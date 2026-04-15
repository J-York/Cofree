import { invoke } from "@tauri-apps/api/core";
import { awaitShellCommandWithDeadline, checkShellJob } from "../lib/tauriBridge";
import {
  DEFAULT_TOOL_PERMISSIONS,
  type AppSettings,
  type ToolPermissions,
} from "../lib/settingsStore";
import {
  describeApprovalRule,
  findMatchingApprovalRule,
  type ApprovalRule,
} from "../lib/approvalRuleStore";
import {
  createAskUserRequest,
  waitForUserResponse,
  type AskUserRequest,
} from "./askUserService";
import {
  DEFAULT_SHELL_OUTPUT_CAPTURE_MAX_BYTES,
  resolveShellExecutionMode,
  resolveShellReadyTimeoutMs,
  resolveShellReadyUrl,
  inferBlockUntilMs,
  INSTALL_BUILD_BLOCK_UNTIL_MS,
  INSTALL_BUILD_TIMEOUT_MS,
} from "../lib/shellCommand";
import type { ActionProposal, PlanStep, PlanStepStatus } from "./types";
import type { ToolCallRecord } from "./llmToolLoop";
import type { CofreeRcConfig } from "../lib/cofreerc";
import type { WorkingMemory } from "./workingMemory";
import type {
  ToolErrorCategory,
  ToolExecutionStatus,
  ToolExecutionTrace,
} from "./toolTraceTypes";

const MAX_LIST_ENTRIES = 120;
const MAX_FILE_PREVIEW_CHARS = 15000;
const MAX_TOOL_RESULT_PREVIEW = 400;
const MAX_TOOL_RETRY = 2;

const ALL_TOOL_NAMES = [
  "list_files",
  "read_file",
  "grep",
  "glob",
  "git_status",
  "git_diff",
  "update_plan",
  "propose_apply_patch",
  "propose_file_edit",
  "propose_shell",
  "check_shell_job",
  "diagnostics",
  "fetch",
  "ask_user",
] as const;


export interface ToolExecutionResult {
  content: string;
  /** @deprecated Use proposedActions[] instead. Kept for backward compat during transition. */
  proposedAction?: ActionProposal;
  /** P1-1: Array of proposed actions from sub-agent/team execution. */
  proposedActions?: ActionProposal[];
  errorCategory?: ToolErrorCategory;
  errorMessage?: string;
  success?: boolean;
  /** P1-3: Completion status, richer than boolean success. */
  completionStatus?: "completed" | "partial" | "failed";
  traceStatus?: ToolExecutionStatus;
  fromCache?: boolean;
}

export type SensitiveWriteAutoExecutionPolicy = "allow" | "disabled";

export interface TodoPlanStateLike {
  steps: PlanStep[];
  activeStepId?: string;
}

export interface ToolExecutorDeps {
  createActionId: (prefix: string) => string;
  nowIso: () => string;
  actionFingerprint: (action: ActionProposal) => string;
  setActivePlanStep: (state: TodoPlanStateLike, stepId: string) => string;
  setPlanStepStatus: (
    state: TodoPlanStateLike,
    stepId: string,
    status: Exclude<PlanStepStatus, "pending" | "in_progress">,
    note?: string,
  ) => string;
  addPlanStep: (state: TodoPlanStateLike, params: {
    title: string;
    summary?: string;
    owner?: PlanStep["owner"];
    afterStepId?: string;
    note?: string;
  }) => PlanStep;
  appendPlanStepNote: (step: PlanStep, note?: string) => void;
  formatTodoPlanBlock: (state: TodoPlanStateLike) => string;
  smartTruncate: (content: string, maxLength: number, headRatio?: number) => string;
}

interface FileEntry {
  name: string;
  is_dir: boolean;
  size: number;
  modified: number;
}

interface PatchApplyResult {
  success: boolean;
  message: string;
  files: string[];
}

interface DiagnosticEntry {
  file: string;
  line: number;
  column: number;
  severity: string;
  message: string;
}

interface DiagnosticsResult {
  success: boolean;
  diagnostics: DiagnosticEntry[];
  tool_used: string;
  raw_output: string;
}

function normalizeRelativePath(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * Strip line-number prefixes that read_file adds (e.g. "487│  code" → "  code").
 * Models may accidentally copy these into search/anchor fields.
 */
function stripLineNumberPrefixes(text: string): string {
  // \s* handles optional leading spaces that some models copy from the display format (e.g. "  10│")
  return text.replace(/^\s*[0-9]+│/gm, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeOptionalPositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : null;
}

function countOccurrences(content: string, snippet: string): number {
  if (!snippet) {
    return 0;
  }

  let total = 0;
  let offset = 0;
  while (offset <= content.length) {
    const index = content.indexOf(snippet, offset);
    if (index < 0) {
      break;
    }
    total += 1;
    offset = index + Math.max(1, snippet.length);
  }
  return total;
}

function splitPatchLines(content: string): {
  lines: string[];
  hasTrailingNewline: boolean;
} {
  if (!content.length) {
    return {
      lines: [],
      hasTrailingNewline: false,
    };
  }

  const hasTrailingNewline = content.endsWith("\n");
  const body = hasTrailingNewline ? content.slice(0, -1) : content;

  return {
    lines: body.length > 0 ? body.split("\n") : [""],
    hasTrailingNewline,
  };
}

function splitContentSegments(content: string): string[] {
  if (!content.length) {
    return [];
  }

  const segments: string[] = [];
  let start = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\n") {
      segments.push(content.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (start < content.length) {
    segments.push(content.slice(start));
  }
  return segments;
}

function replaceByLineRange(
  content: string,
  startLine: number,
  endLine: number,
  replacement: string
): string {
  const segments = splitContentSegments(content);
  if (!segments.length) {
    throw new Error("文件为空，无法按行定位编辑。");
  }
  if (startLine < 1 || endLine < 1 || startLine > endLine) {
    throw new Error("非法行号范围。");
  }
  if (startLine > segments.length || endLine > segments.length) {
    throw new Error(`行号超出文件范围（总行数 ${segments.length}）。`);
  }

  return (
    segments.slice(0, startLine - 1).join("") +
    replacement +
    segments.slice(endLine).join("")
  );
}

function insertByLine(
  content: string,
  line: number,
  insertContent: string,
  position: "before" | "after"
): string {
  const segments = splitContentSegments(content);
  if (!segments.length) {
    throw new Error("文件为空，无法按行定位插入。");
  }
  if (line < 1 || line > segments.length) {
    throw new Error(`line 超出文件范围（总行数 ${segments.length}）。`);
  }

  const insertionIndex = position === "before" ? line - 1 : line;
  return (
    segments.slice(0, insertionIndex).join("") +
    insertContent +
    segments.slice(insertionIndex).join("")
  );
}

function formatUnifiedRange(start: number, count: number): string {
  if (count === 1) {
    return `${start}`;
  }
  return `${start},${count}`;
}

async function buildReplacementPatch(
  relativePath: string,
  before: string,
  after: string
): Promise<string> {
  if (before === after) {
    throw new Error("编辑结果为空，未产生文件变更。");
  }
  return invoke<string>("build_workspace_edit_patch", {
    relativePath,
    before,
    after,
  });
}

function buildCreateFilePatch(relativePath: string, content: string): string {
  const next = splitPatchLines(content);
  if (next.lines.length < 1) {
    throw new Error("create 操作要求 content 至少包含一行。");
  }

  const hunkLines = next.lines.map((line) => `+${line}`);
  if (!next.hasTrailingNewline) {
    hunkLines.push("\\ No newline at end of file");
  }

  return (
    [
      `diff --git a/${relativePath} b/${relativePath}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${relativePath}`,
      `@@ -0,0 +${formatUnifiedRange(1, next.lines.length)} @@`,
      ...hunkLines,
    ].join("\n") + "\n"
  );
}

function classifyToolError(message: string): ToolErrorCategory {
  const lower = message.toLowerCase();
  if (
    lower.includes("不能为空") ||
    lower.includes("invalid json") ||
    lower.includes("arguments") ||
    lower.includes("未找到") ||
    lower.includes("出现多次") ||
    lower.includes("预检失败") ||
    lower.includes("已存在") ||
    lower.includes("未产生文件变更") ||
    lower.includes("不支持的 file edit") ||
    lower.includes("行号") ||
    lower.includes("文件为空") ||
    lower.includes("invalid target path") ||
    lower.includes("no such file or directory") ||
    lower.includes("line 超出")
  ) {
    return "validation";
  }
  if (lower.includes("未选择工作区") || lower.includes("workspace")) {
    return "workspace";
  }
  if (
    lower.includes("allowlist") ||
    lower.includes("guardrail") ||
    lower.includes("shell 控制符") ||
    lower.includes("工作区越界路径") ||
    lower.includes("受限目录") ||
    lower.includes("命中被禁止的可执行程序") ||
    lower.includes("命中高风险关键字") ||
    lower.includes("解释器内联执行") ||
    lower.includes("propose_apply_patch") ||
    lower.includes("直接改文件")
  ) {
    return "guardrail";
  }
  if (
    lower.includes("patch does not apply") ||
    lower.includes("corrupt patch")
  ) {
    return "validation";
  }
  if (lower.includes("timed out") || lower.includes("超时")) {
    return "timeout";
  }
  if (lower.includes("permission") || lower.includes("not permitted")) {
    return "permission";
  }
  if (lower.includes("未知工具")) {
    return "tool_not_found";
  }
  if (
    lower.includes("fetch") ||
    lower.includes("network") ||
    lower.includes("http")
  ) {
    return "transport";
  }
  return "unknown";
}

function shouldRetryToolCall(category: ToolErrorCategory): boolean {
  switch (category) {
    case "transport":
    case "timeout":
      return true;
    case "workspace":
      // Workspace errors (e.g. file temporarily locked) may resolve on retry
      return true;
    case "validation":
    case "permission":
    case "allowlist":
    case "guardrail":
    case "tool_not_found":
      // These are deterministic failures — retrying won't help
      return false;
    case "unknown":
      // Unknown errors get one retry in case they're transient
      return true;
    default:
      return false;
  }
}

/**
 * Compute exponential backoff delay for tool call retries.
 * Uses a shorter base than LLM retries since tool calls are local operations.
 */
function computeToolRetryDelay(attempt: number): number {
  const baseDelayMs = 500;
  const maxDelayMs = 5000;
  const delay = baseDelayMs * Math.pow(2, attempt - 1);
  const jitter = delay * 0.2 * Math.random();
  return Math.min(delay + jitter, maxDelayMs);
}

/**
 * Build a contextual error recovery hint for the LLM based on the tool error category.
 * This helps the model understand what went wrong and how to fix it.
 */
function buildToolErrorRecoveryHint(
  toolName: string,
  category: ToolErrorCategory,
  errorMessage: string,
): string {
  const hints: string[] = [
    `工具 "${toolName}" 执行失败。`,
    `错误类别: ${category}`,
    `错误信息: ${errorMessage}`,
  ];

  switch (category) {
    case "validation":
      hints.push(
        "恢复建议: 参数格式或值不正确。请检查工具参数是否符合要求，特别注意：",
        "- relative_path 必须是工作区相对路径，不能是绝对路径",
        "- search 字段必须与文件中的实际内容完全匹配（包括空格和缩进）",
        "- 必填参数不能省略",
      );
      break;
    case "workspace":
      hints.push(
        "恢复建议: 工作区操作失败。可能的原因：",
        "- 文件或目录不存在 — 先用 list_files 或 glob 确认路径",
        "- 文件被锁定或权限不足 — 尝试其他文件或等待后重试",
        "- 路径拼写错误 — 使用 glob 搜索正确的文件名",
      );
      break;
    case "timeout":
      hints.push(
        "恢复建议: 操作超时。对于耗时操作：",
        "- 缩小操作范围（如减少 grep 的 max_results）",
        "- 对于 shell 命令，增加 timeout_ms 参数",
        "- 将大操作拆分为多个小操作",
      );
      break;
    case "transport":
      hints.push(
        "恢复建议: 网络或传输错误，通常是暂时性的。系统会自动重试。",
      );
      break;
    case "tool_not_found":
      hints.push(
        "恢复建议: 调用了不存在的工具。请检查工具名称拼写，可用工具列表见系统提示。",
      );
      break;
    case "permission":
    case "allowlist":
    case "guardrail":
      hints.push(
        "恢复建议: 权限或安全策略阻止了此操作。请：",
        "- 使用其他方式完成任务",
        "- 如果是 shell 命令被阻止，尝试使用更安全的替代命令",
      );
      break;
    default:
      hints.push(
        "恢复建议: 发生未知错误。请尝试：",
        "- 检查参数是否正确",
        "- 使用 read_file 确认目标文件的当前状态",
        "- 尝试不同的方法完成任务",
      );
  }

  return hints.join("\n");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("The operation was aborted.", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function resultPreview(content: string): string {
  return content.slice(0, MAX_TOOL_RESULT_PREVIEW);
}

function buildAutoApprovalMeta(
  source: "tool_permission" | "workspace_rule" | null,
  matchedRule?: ApprovalRule | null,
): Record<string, unknown> {
  if (!source) {
    return {};
  }

  return {
    approval_source: source,
    approval_rule_matched: source === "workspace_rule",
    approval_rule_kind:
      source === "workspace_rule" ? matchedRule?.kind ?? null : null,
    approval_rule_label:
      source === "workspace_rule" && matchedRule
        ? describeApprovalRule(matchedRule)
        : null,
  };
}

function resolveSensitiveActionAutoApprovalSource(params: {
  permissionLevel: "auto" | "ask";
  matchedRule?: ApprovalRule | null;
  autoExecutionPolicy: SensitiveWriteAutoExecutionPolicy;
}): "tool_permission" | "workspace_rule" | null {
  if (params.autoExecutionPolicy === "disabled") {
    return null;
  }
  if (params.permissionLevel === "auto") {
    return "tool_permission";
  }
  return params.matchedRule ? "workspace_rule" : null;
}

async function fetchPostPatchDiagnostics(
  workspacePath: string,
  changedFiles: string[]
): Promise<{ hasDiagnostics: boolean; summary: string }> {
  try {
    const result = await invoke<DiagnosticsResult>(
      "get_workspace_diagnostics",
      {
        workspacePath,
        changedFiles,
      }
    );
    if (
      !result.success ||
      result.tool_used === "none" ||
      result.diagnostics.length === 0
    ) {
      return { hasDiagnostics: false, summary: "" };
    }
    const relevantDiagnostics = result.diagnostics.slice(0, 10);
    const lines = relevantDiagnostics.map(
      (d) =>
        `${d.severity.toUpperCase()} ${d.file}:${d.line}:${d.column} ${d.message
        }`
    );
    const summary = `[诊断反馈 via ${result.tool_used}] 发现 ${result.diagnostics.length
      } 个问题:\n${lines.join("\n")}`;
    return { hasDiagnostics: true, summary };
  } catch {
    return { hasDiagnostics: false, summary: "" };
  }
}

async function autoExecutePatchProposal(params: {
  workspacePath: string;
  patch: string;
  responseMeta?: Record<string, unknown>;
  autoApprovalMeta?: Record<string, unknown>;
}): Promise<ToolExecutionResult> {
  const snapshot = await invoke<{
    success: boolean;
    snapshot_id: string;
    files: string[];
  }>("create_workspace_snapshot", {
    workspacePath: params.workspacePath,
    patch: params.patch,
  });
  const applyResult = await invoke<PatchApplyResult>(
    "apply_workspace_patch",
    { workspacePath: params.workspacePath, patch: params.patch }
  );
  if (!applyResult.success && snapshot.success) {
    await invoke<PatchApplyResult>("restore_workspace_snapshot", {
      workspacePath: params.workspacePath,
      snapshotId: snapshot.snapshot_id,
    });
  }

  const responsePayload: Record<string, unknown> = {
    ok: applyResult.success,
    action_type: "apply_patch",
    auto_executed: true,
    patch_length: params.patch.length,
    files: applyResult.files,
    message: applyResult.message,
    ...(params.responseMeta ?? {}),
    ...(params.autoApprovalMeta ?? {}),
  };
  if (applyResult.success) {
    const diagnostics = await fetchPostPatchDiagnostics(
      params.workspacePath,
      applyResult.files
    );
    if (diagnostics.hasDiagnostics) {
      responsePayload.diagnostics = diagnostics.summary;
    }
  }

  return {
    content: JSON.stringify(responsePayload),
    success: applyResult.success,
    errorCategory: applyResult.success ? undefined : "validation",
    errorMessage: applyResult.success ? undefined : applyResult.message,
  };
}

async function autoExecuteShellProposal(params: {
  workspacePath: string;
  shell: string;
  timeoutMs: number;
  blockUntilMs: number;
  autoApprovalMeta?: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<ToolExecutionResult> {
  // For install/build commands the default blockUntilMs is 90 000 ms.
  // If the caller left timeoutMs at the default (120 000), the JS deadline and
  // the Rust hard-kill would fire almost simultaneously. Raise the hard timeout
  // so the command keeps running in the background after the deadline.
  const effectiveTimeoutMs =
    params.blockUntilMs === INSTALL_BUILD_BLOCK_UNTIL_MS &&
    params.timeoutMs <= INSTALL_BUILD_BLOCK_UNTIL_MS
      ? INSTALL_BUILD_TIMEOUT_MS
      : Math.max(params.timeoutMs, params.blockUntilMs + 5_000);

  const deadlineResult = await awaitShellCommandWithDeadline({
    workspacePath: params.workspacePath,
    shell: params.shell,
    timeoutMs: effectiveTimeoutMs,
    blockUntilMs: params.blockUntilMs,
    maxOutputBytes: DEFAULT_SHELL_OUTPUT_CAPTURE_MAX_BYTES,
    signal: params.signal,
  });

  if (deadlineResult.moved_to_background) {
    return {
      content: JSON.stringify({
        ok: true,
        action_type: "shell",
        auto_executed: true,
        shell: params.shell,
        moved_to_background: true,
        job_id: deadlineResult.job_id,
        stdout: deadlineResult.partial_stdout,
        stderr: deadlineResult.partial_stderr,
        exit_code: null,
        timed_out: false,
        message: `命令在 ${params.blockUntilMs}ms 内未完成，已自动转为后台运行。如需检查进程状态，可使用 propose_shell(shell='kill -0 <pid>') 或重新运行相关命令。`,
        ...(params.autoApprovalMeta ?? {}),
      }),
      success: true,
    };
  }

  const cmdResult = deadlineResult.result;

  return {
    content: JSON.stringify({
      ok: cmdResult.success,
      action_type: "shell",
      auto_executed: true,
      shell: params.shell,
      stdout: cmdResult.stdout,
      stderr: cmdResult.stderr,
      stdout_truncated: cmdResult.stdout_truncated ?? false,
      stderr_truncated: cmdResult.stderr_truncated ?? false,
      stdout_total_bytes: cmdResult.stdout_total_bytes ?? cmdResult.stdout.length,
      stderr_total_bytes: cmdResult.stderr_total_bytes ?? cmdResult.stderr.length,
      output_limit_bytes: cmdResult.output_limit_bytes ?? DEFAULT_SHELL_OUTPUT_CAPTURE_MAX_BYTES,
      exit_code: cmdResult.status,
      timed_out: cmdResult.timed_out,
      ...(params.autoApprovalMeta ?? {}),
    }),
    success: cmdResult.success,
    errorCategory: cmdResult.success ? undefined : "validation",
    errorMessage: cmdResult.success
      ? undefined
      : `命令执行失败 (exit ${cmdResult.status})`,
  };
}

function renderListEntries(entries: FileEntry[]): string {
  const sorted = [...entries].sort((left, right) => {
    if (left.is_dir !== right.is_dir) {
      return left.is_dir ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
  const preview = sorted.slice(0, MAX_LIST_ENTRIES).map((entry) => {
    if (entry.is_dir) {
      return `[DIR] ${entry.name}/`;
    }
    return `[FILE] ${entry.name} (${entry.size}B)`;
  });
  if (sorted.length > MAX_LIST_ENTRIES) {
    preview.push(`... ${sorted.length - MAX_LIST_ENTRIES} entries omitted`);
  }
  return preview.join("\n");
}

export async function executeToolCall(
  call: ToolCallRecord,
  workspacePath: string,
  deps: ToolExecutorDeps,
  toolPermissions: ToolPermissions = DEFAULT_TOOL_PERMISSIONS,
  settings?: AppSettings,
  projectConfig?: CofreeRcConfig,
  enabledToolNames?: string[],
  planState?: TodoPlanStateLike,
  workingMemory?: WorkingMemory,
  signal?: AbortSignal,
  turn?: number,
  _focusedPaths?: string[],
  sessionId?: string,
  onAskUserRequest?: (request: AskUserRequest) => void,
  autoExecutionPolicy: SensitiveWriteAutoExecutionPolicy = "allow",
): Promise<ToolExecutionResult> {
  const safeWorkspace = workspacePath.trim();
  if (!safeWorkspace) {
    const message = "未选择工作区。";
    return {
      content: JSON.stringify({ error: message }),
      success: false,
      errorCategory: "workspace",
      errorMessage: message,
    };
  }

  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.function.arguments) as Record<string, unknown>;
  } catch (_error) {
    const message = "tool arguments 不是合法 JSON";
    return {
      content: JSON.stringify({ error: message }),
      success: false,
      errorCategory: "validation",
      errorMessage: message,
    };
  }

  try {
    if (call.function.name === "list_files") {
      const relativePath = normalizeRelativePath(args.relative_path);
      const ignorePatterns =
        projectConfig?.ignorePatterns && projectConfig.ignorePatterns.length > 0
          ? projectConfig.ignorePatterns
          : null;
      const entries = await invoke<FileEntry[]>("list_workspace_files", {
        workspacePath: safeWorkspace,
        relativePath,
        ignorePatterns,
      });
      const resultContent = JSON.stringify({
        ok: true,
        relative_path: relativePath,
        entry_count: entries.length,
        entries_preview: renderListEntries(entries),
      });

      return {
        content: resultContent,
        success: true,
      };
    }

    if (call.function.name === "read_file") {
      const relativePath = normalizeRelativePath(args.relative_path);
      const startLine = normalizeOptionalPositiveInt(args.start_line);
      const endLine = normalizeOptionalPositiveInt(args.end_line);
      if (!relativePath) {
        const message = "relative_path 不能为空";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }
      if (startLine && endLine && startLine > endLine) {
        const message = "start_line 不能大于 end_line";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }

      // --- 读取去重：仅对无行范围的全文读取进行去重 ---
      if (!startLine && !endLine && workingMemory && turn !== undefined) {
        const existing = workingMemory.fileKnowledge.get(relativePath);
        if (existing && existing.lastReadTurn !== undefined
          && (turn - existing.lastReadTurn) < 10) {
          return {
            success: true,
            content: JSON.stringify({
              status: "cached",
              message: `此文件已在第 ${existing.lastReadTurn + 1} 轮读取过（当前第 ${turn + 1} 轮）。`,
              cached_summary: existing.summary,
              total_lines: existing.totalLines,
              language: existing.language || "unknown",
              hint: "如需查看特定区域，请使用 start_line/end_line 参数精确读取。如需更新信息，请使用 grep 搜索特定内容。",
            }),
          };
        }
      }

      const result = await invoke<{
        content: string;
        total_lines: number;
        start_line: number;
        end_line: number;
      }>("read_workspace_file", {
        workspacePath: safeWorkspace,
        relativePath,
        startLine,
        endLine,
        ignorePatterns:
          projectConfig?.ignorePatterns &&
            projectConfig.ignorePatterns.length > 0
            ? projectConfig.ignorePatterns
            : null,
      });

      // Add line numbers to content for model orientation
      const lines = result.content.split("\n");
      // Remove trailing empty line from split if content ends with \n
      if (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop();
      }
      const numbered = lines
        .map((line, i) => `${result.start_line + i}│${line}`)
        .join("\n");
      const trimmed = deps.smartTruncate(numbered, MAX_FILE_PREVIEW_CHARS);
      const wasTruncated = numbered.length > MAX_FILE_PREVIEW_CHARS;

      const resultContent = JSON.stringify({
        ok: true,
        relative_path: relativePath,
        total_lines: result.total_lines,
        showing_lines: `${result.start_line}-${result.end_line}`,
        content_preview: trimmed,
        truncated: wasTruncated,
        ...(wasTruncated
          ? {
            hint:
              "内容已裁剪。可使用 start_line/end_line 分段读取，获取完整文件。",
          }
          : {}),
      });

      return {
        content: resultContent,
        success: true,
      };
    }

    if (call.function.name === "git_status") {
      const status = await invoke<string>("git_status_workspace", {
        workspacePath: safeWorkspace,
      });
      const resultContent = JSON.stringify({
        ok: true,
        status_preview: deps.smartTruncate(status, MAX_FILE_PREVIEW_CHARS),
        truncated: status.length > MAX_FILE_PREVIEW_CHARS,
      });

      return {
        content: resultContent,
        success: true,
      };
    }

    if (call.function.name === "git_diff") {
      const filePath = normalizeRelativePath(args.file_path);
      const diff = await invoke<string>("git_diff_workspace", {
        workspacePath: safeWorkspace,
        filePath: filePath || null,
      });

      const resultContent = JSON.stringify({
        ok: true,
        file_path: filePath || null,
        diff_preview: deps.smartTruncate(diff, MAX_FILE_PREVIEW_CHARS),
        truncated: diff.length > MAX_FILE_PREVIEW_CHARS,
      });

      return {
        content: resultContent,
        success: true,
      };
    }

    if (call.function.name === "grep") {
      const pattern = asString(args.pattern).trim();
      if (!pattern) {
        const message = "pattern 不能为空";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }
      const includeGlob = asString(args.include_glob).trim() || null;
      const maxResults = normalizeOptionalPositiveInt(args.max_results) ?? 50;
      const result = await invoke<{
        matches: Array<{ file: string; line: number; content: string }>;
        truncated: boolean;
      }>("grep_workspace_files", {
        workspacePath: safeWorkspace,
        pattern,
        includeGlob,
        maxResults,
        ignorePatterns:
          projectConfig?.ignorePatterns &&
            projectConfig.ignorePatterns.length > 0
            ? projectConfig.ignorePatterns
            : null,
      });
      const matchCount = result.matches.length;
      const preview = result.matches
        .slice(0, 30)
        .map((m) => `${m.file}:${m.line}│${m.content}`)
        .join("\n");

      const resultContent = JSON.stringify({
        ok: true,
        pattern,
        include_glob: includeGlob,
        match_count: matchCount,
        truncated: result.truncated,
        matches_preview: deps.smartTruncate(preview, MAX_FILE_PREVIEW_CHARS),
      });

      return {
        content: resultContent,
        success: true,
      };
    }

    if (call.function.name === "glob") {
      const pattern = asString(args.pattern).trim();
      if (!pattern) {
        const message = "pattern 不能为空";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }
      const maxResults = normalizeOptionalPositiveInt(args.max_results) ?? 100;
      const entries = await invoke<
        Array<{ path: string; size: number; modified: number }>
      >("glob_workspace_files", {
        workspacePath: safeWorkspace,
        pattern,
        maxResults,
        ignorePatterns:
          projectConfig?.ignorePatterns &&
            projectConfig.ignorePatterns.length > 0
            ? projectConfig.ignorePatterns
            : null,
      });
      const preview = entries
        .slice(0, 60)
        .map((e) => `${e.path} (${e.size}B)`)
        .join("\n");

      const resultContent = JSON.stringify({
        ok: true,
        pattern,
        file_count: entries.length,
        files_preview: deps.smartTruncate(preview, MAX_FILE_PREVIEW_CHARS),
      });

      return {
        content: resultContent,
        success: true,
      };
    }

    if (call.function.name === "update_plan") {
      if (!planState) {
        const message = "update_plan 缺少当前计划上下文";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }

      const operation = asString(args.operation).trim();
      const stepId = asString(args.step_id).trim();
      const note = asString(args.note).trim();
      if (!operation) {
        const message = "operation 不能为空";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }
      if (!stepId) {
        const message = "step_id 不能为空";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }

      let message = "";
      switch (operation) {
        case "set_active":
          message = deps.setActivePlanStep(planState, stepId);
          break;
        case "complete":
          message = deps.setPlanStepStatus(planState, stepId, "completed", note);
          break;
        case "block":
          message = deps.setPlanStepStatus(planState, stepId, "blocked", note);
          break;
        case "fail":
          message = deps.setPlanStepStatus(planState, stepId, "failed", note);
          break;
        case "skip":
          message = deps.setPlanStepStatus(planState, stepId, "skipped", note);
          break;
        case "note": {
          const target = planState.steps.find((step) => step.id === stepId);
          if (!target) {
            message = `未找到步骤 ${stepId}`;
          } else {
            deps.appendPlanStepNote(target, note || asString(args.summary).trim());
            message = `步骤「${target.title}」备注已更新`;
          }
          break;
        }
        case "add": {
          const title = asString(args.title).trim() || stepId;
          if (!title) {
            message = "operation=add 时必须提供 title";
            break;
          }
          const added = deps.addPlanStep(planState, {
            title,
            summary: asString(args.summary).trim(),
            owner: (["planner", "coder", "tester", "debugger", "reviewer"].includes(asString(args.owner).trim())
              ? (asString(args.owner).trim() as PlanStep["owner"])
              : undefined),
            afterStepId: asString(args.after_step_id).trim() || undefined,
            note,
          });
          message = `已新增步骤「${added.title}」`;
          break;
        }
        default:
          message = `不支持的 update_plan operation: ${operation}`;
      }

      const isError = message.startsWith("未找到") || message.startsWith("不支持") || message.startsWith("operation=");
      return {
        content: JSON.stringify({
          ok: !isError,
          action_type: "update_plan",
          operation,
          step_id: stepId,
          message,
          active_step_id: planState.activeStepId ?? null,
          plan_summary: deps.formatTodoPlanBlock(planState),
          steps: planState.steps.map((step) => ({
            id: step.id,
            title: step.title,
            owner: step.owner,
            status: step.status,
            linkedActionIds: step.linkedActionIds ?? [],
          })),
        }),
        success: !isError,
        errorCategory: isError ? "validation" : undefined,
        errorMessage: isError ? message : undefined,
      };
    }

    if (call.function.name === "propose_apply_patch") {
      const patch = asString(args.patch).trim();
      if (!patch) {
        const message = "patch 不能为空";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }
      const preflight = await invoke<PatchApplyResult>(
        "check_workspace_patch",
        {
          workspacePath: safeWorkspace,
          patch,
        }
      );
      if (!preflight.success) {
        const message = `Patch 预检失败: ${preflight.message}`;
        return {
          content: JSON.stringify({
            error: message,
            files: preflight.files,
          }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }
      if (preflight.files.length > 1) {
        const message = `propose_apply_patch 仅允许单文件 patch；当前 patch 涉及 ${preflight.files.length} 个文件。请改用 propose_file_edit 按文件逐个提交。`;
        return {
          content: JSON.stringify({
            error: message,
            files: preflight.files,
          }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }
      const actionBase: ActionProposal = {
        id: deps.createActionId("gate-a-apply-patch"),
        toolCallId: call.id,
        toolName: call.function.name,
        planStepId: planState?.activeStepId,
        type: "apply_patch",
        description: asString(
          args.description,
          "Apply generated patch to workspace (Gate A)"
        ),
        gateRequired: true,
        status: "pending",
        executed: false,
        payload: {
          patch,
        },
      };
      const action: ActionProposal = {
        ...actionBase,
        fingerprint: deps.actionFingerprint(actionBase),
      };
      const matchedRule = findMatchingApprovalRule(safeWorkspace, action);
      const autoApprovalSource = resolveSensitiveActionAutoApprovalSource({
        permissionLevel: toolPermissions.propose_apply_patch,
        matchedRule,
        autoExecutionPolicy,
      });
      if (autoApprovalSource) {
        return autoExecutePatchProposal({
          workspacePath: safeWorkspace,
          patch,
          autoApprovalMeta: buildAutoApprovalMeta(autoApprovalSource, matchedRule),
        });
      }
      return {
        content: JSON.stringify({
          ok: true,
          action_type: "apply_patch",
          action_id: action.id,
          patch_length: patch.length,
          files: preflight.files,
        }),
        success: true,
        proposedAction: action,
      };
    }

    if (call.function.name === "propose_file_edit") {
      const relativePath = normalizeRelativePath(args.relative_path);
      const operationRaw = asString(args.operation, "replace")
        .trim()
        .toLowerCase();
      const operation = operationRaw || "replace";
      const applyAll = asBoolean(
        args.apply_all,
        asBoolean(args.replace_all, false)
      );
      const positionCandidate = asString(args.position, "after")
        .trim()
        .toLowerCase();
      const insertPosition =
        positionCandidate === "before" ? "before" : "after";
      const line = normalizeOptionalPositiveInt(args.line);
      const startLine = normalizeOptionalPositiveInt(args.start_line);
      const endLine = normalizeOptionalPositiveInt(args.end_line);
      if (!relativePath) {
        const message = "relative_path 不能为空";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }
      let patch = "";
      const responseMeta: Record<string, unknown> = {
        mode: "file_edit",
        operation,
        relative_path: relativePath,
        apply_all: applyAll,
      };
      if (line) {
        responseMeta.line = line;
      }
      if (startLine) {
        responseMeta.start_line = startLine;
      }
      if (endLine) {
        responseMeta.end_line = endLine;
      }

      if (endLine && !startLine) {
        const message = "提供 end_line 时必须同时提供 start_line";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }
      if (startLine && endLine && startLine > endLine) {
        const message = "start_line 不能大于 end_line";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }

      if (operation === "create") {
        const createContent = asString(args.content, asString(args.replace));
        const overwrite = asBoolean(args.overwrite, false);
        if (!createContent) {
          const message = "create 操作要求 content 非空。operation='create' 必须提供 content 参数，包含要写入的完整文件内容。";
          return {
            content: JSON.stringify({ error: message }),
            success: false,
            errorCategory: "validation",
            errorMessage: message,
          };
        }

        let existingContent: string | null = null;
        try {
          existingContent = (
            await invoke<{
              content: string;
              total_lines: number;
              start_line: number;
              end_line: number;
            }>("read_workspace_file", {
              workspacePath: safeWorkspace,
              relativePath,
            })
          ).content;
        } catch (_error) {
          existingContent = null;
        }

        if (existingContent !== null && !overwrite) {
          const message = `目标文件已存在: ${relativePath}（如需覆盖请设置 overwrite=true）`;
          return {
            content: JSON.stringify({ error: message }),
            success: false,
            errorCategory: "validation",
            errorMessage: message,
          };
        }

        patch =
          existingContent === null
            ? buildCreateFilePatch(relativePath, createContent)
            : await buildReplacementPatch(
              relativePath,
              existingContent,
              createContent
            );
        responseMeta.created = existingContent === null;
        responseMeta.overwrite = overwrite;
      } else {
        let original = "";
        let fileExists = true;
        try {
          original = (
            await invoke<{
              content: string;
              total_lines: number;
              start_line: number;
              end_line: number;
            }>("read_workspace_file", {
              workspacePath: safeWorkspace,
              relativePath,
            })
          ).content;
          // Normalize CRLF → LF so search snippets (which models always generate with \n) match correctly
          original = original.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        } catch (_readError) {
          fileExists = false;
          // File doesn't exist — auto-detect as create intent
          const createContent = asString(args.content, asString(args.replace));
          if (createContent) {
            patch = buildCreateFilePatch(relativePath, createContent);
            responseMeta.auto_create = true;
            responseMeta.operation = "create";
          } else {
            const message = `文件不存在: ${relativePath}。若要创建新文件，请使用 operation='create' 并提供 content 参数`;
            return {
              content: JSON.stringify({ error: message }),
              success: false,
              errorCategory: "validation",
              errorMessage: message,
            };
          }
        }
        if (!patch && fileExists) {
          let nextContent = original;

          if (operation === "replace") {
            if (startLine) {
              const replacement = asString(
                args.content,
                asString(args.replace)
              );
              nextContent = replaceByLineRange(
                original,
                startLine,
                endLine ?? startLine,
                replacement
              );
              responseMeta.selection_mode = "line_range";
            } else {
              const search = stripLineNumberPrefixes(asString(args.search));
              const replace = asString(args.replace);
              if (!search) {
                const message =
                  "replace 操作要求 search 非空，或提供 start_line/end_line。若要创建新文件，请改用 operation='create' 并提供 content 参数";
                return {
                  content: JSON.stringify({ error: message }),
                  success: false,
                  errorCategory: "validation",
                  errorMessage: message,
                };
              }
              const hits = countOccurrences(original, search);
              if (hits < 1) {
                const message = `search 片段未找到: ${relativePath}。search 必须精确匹配文件内容（不含行号前缀）。建议改用 start_line/end_line 行范围方式编辑。`;
                return {
                  content: JSON.stringify({ error: message }),
                  success: false,
                  errorCategory: "validation",
                  errorMessage: message,
                };
              }
              if (!applyAll && hits > 1) {
                const message = `search 片段出现多次（${hits} 次）；请提供更精确片段或设置 apply_all=true`;
                return {
                  content: JSON.stringify({ error: message }),
                  success: false,
                  errorCategory: "validation",
                  errorMessage: message,
                };
              }

              nextContent = applyAll
                ? original.split(search).join(replace)
                : original.replace(search, replace);
              responseMeta.matched = hits;
            }
          } else if (operation === "insert") {
            const insertContent = asString(
              args.content,
              asString(args.replace)
            );
            if (!insertContent) {
              const message = "insert 操作要求 content 非空";
              return {
                content: JSON.stringify({ error: message }),
                success: false,
                errorCategory: "validation",
                errorMessage: message,
              };
            }
            if (line) {
              nextContent = insertByLine(
                original,
                line,
                insertContent,
                insertPosition
              );
              responseMeta.selection_mode = "line_anchor";
              responseMeta.position = insertPosition;
            } else {
              const anchor = stripLineNumberPrefixes(
                asString(args.anchor, asString(args.search))
              );
              if (!anchor) {
                const message = "insert 操作要求 anchor 非空，或提供 line";
                return {
                  content: JSON.stringify({ error: message }),
                  success: false,
                  errorCategory: "validation",
                  errorMessage: message,
                };
              }
              const hits = countOccurrences(original, anchor);
              if (hits < 1) {
                const message = `anchor 片段未找到: ${relativePath}。anchor 必须精确匹配文件内容（不含行号前缀）。建议改用 line 参数指定插入位置。`;
                return {
                  content: JSON.stringify({ error: message }),
                  success: false,
                  errorCategory: "validation",
                  errorMessage: message,
                };
              }
              if (!applyAll && hits > 1) {
                const message = `anchor 片段出现多次（${hits} 次）；请提供更精确片段或设置 apply_all=true`;
                return {
                  content: JSON.stringify({ error: message }),
                  success: false,
                  errorCategory: "validation",
                  errorMessage: message,
                };
              }

              const anchored =
                insertPosition === "before"
                  ? `${insertContent}${anchor}`
                  : `${anchor}${insertContent}`;
              nextContent = applyAll
                ? original.split(anchor).join(anchored)
                : original.replace(anchor, anchored);
              responseMeta.matched = hits;
              responseMeta.position = insertPosition;
            }
          } else if (operation === "delete") {
            if (startLine) {
              nextContent = replaceByLineRange(
                original,
                startLine,
                endLine ?? startLine,
                ""
              );
              responseMeta.selection_mode = "line_range";
            } else {
              const search = stripLineNumberPrefixes(
                asString(args.search, asString(args.anchor))
              );
              if (!search) {
                const message =
                  "delete 操作要求 search 非空，或提供 start_line/end_line。若目标是删除整个文件，请改用 propose_run_command 执行 rm <relative_path>。";
                return {
                  content: JSON.stringify({ error: message }),
                  success: false,
                  errorCategory: "validation",
                  errorMessage: message,
                };
              }
              const hits = countOccurrences(original, search);
              if (hits < 1) {
                const message = `search 片段未找到: ${relativePath}。search 必须精确匹配文件内容（不含行号前缀）。建议改用 start_line/end_line 行范围方式编辑。`;
                return {
                  content: JSON.stringify({ error: message }),
                  success: false,
                  errorCategory: "validation",
                  errorMessage: message,
                };
              }
              if (!applyAll && hits > 1) {
                const message = `search 片段出现多次（${hits} 次）；请提供更精确片段或设置 apply_all=true`;
                return {
                  content: JSON.stringify({ error: message }),
                  success: false,
                  errorCategory: "validation",
                  errorMessage: message,
                };
              }

              nextContent = applyAll
                ? original.split(search).join("")
                : original.replace(search, "");
              responseMeta.matched = hits;
            }
          } else {
            const message = `不支持的 file edit operation: ${operation}`;
            return {
              content: JSON.stringify({ error: message }),
              success: false,
              errorCategory: "validation",
              errorMessage: message,
            };
          }

          patch = await buildReplacementPatch(
            relativePath,
            original,
            nextContent
          );
        } // end if (!patch && fileExists)
      }

      const preflight = await invoke<PatchApplyResult>(
        "check_workspace_patch",
        {
          workspacePath: safeWorkspace,
          patch,
        }
      );
      if (!preflight.success) {
        const message = `Patch 预检失败: ${preflight.message}`;
        return {
          content: JSON.stringify({
            error: message,
            files: preflight.files,
          }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }

      const action: ActionProposal = {
        id: deps.createActionId("gate-a-apply-patch"),
        toolCallId: call.id,
        toolName: call.function.name,
        planStepId: planState?.activeStepId,
        type: "apply_patch",
        description: asString(
          args.description,
          `Apply structured edit for ${relativePath} (Gate A)`
        ),
        gateRequired: true,
        status: "pending",
        executed: false,
        payload: {
          patch,
        },
      };
      action.fingerprint = deps.actionFingerprint(action);
      const matchedRule = findMatchingApprovalRule(safeWorkspace, action);
      const autoApprovalSource = resolveSensitiveActionAutoApprovalSource({
        permissionLevel: toolPermissions.propose_file_edit,
        matchedRule,
        autoExecutionPolicy,
      });
      if (autoApprovalSource) {
        return autoExecutePatchProposal({
          workspacePath: safeWorkspace,
          patch,
          responseMeta,
          autoApprovalMeta: buildAutoApprovalMeta(autoApprovalSource, matchedRule),
        });
      }
      return {
        content: JSON.stringify({
          ok: true,
          action_type: "apply_patch",
          action_id: action.id,
          patch_length: patch.length,
          files: preflight.files,
          ...responseMeta,
        }),
        success: true,
        proposedAction: action,
      };
    }

    if (call.function.name === "propose_shell") {
      const shell = asString(args.shell).trim();
      if (!shell) {
        const message = "shell 命令不能为空";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }
      const timeout = Math.max(
        1000,
        Math.min(600000, asNumber(args.timeout_ms, 120000))
      );
      if (timeout < 1000 || timeout > 600000) {
        const message = "timeout_ms 必须在 1000-600000 之间";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }
      const blockUntilMs = inferBlockUntilMs(shell, args.block_until_ms);
      const executionMode = resolveShellExecutionMode(shell, args.execution_mode);
      const readyUrl = resolveShellReadyUrl({
        shell,
        preferredUrl: args.ready_url,
        executionMode,
      });
      const readyTimeoutMs = resolveShellReadyTimeoutMs(
        args.ready_timeout_ms,
        executionMode,
      );
      const action: ActionProposal = {
        id: deps.createActionId("gate-shell"),
        toolCallId: call.id,
        toolName: call.function.name,
        planStepId: planState?.activeStepId,
        type: "shell",
        description: asString(
          args.description,
          executionMode === "background"
            ? "Launch background service (Gate)"
            : "Execute shell command (Gate)",
        ),
        gateRequired: true,
        status: "pending",
        executed: false,
        payload: {
          shell,
          timeoutMs: timeout,
          blockUntilMs,
          executionMode,
          readyUrl,
          readyTimeoutMs,
        },
      };
      action.fingerprint = deps.actionFingerprint(action);
      const matchedRule = findMatchingApprovalRule(safeWorkspace, action);
      const autoApprovalSource = resolveSensitiveActionAutoApprovalSource({
        permissionLevel: toolPermissions.propose_shell,
        matchedRule,
        autoExecutionPolicy,
      });
      if (autoApprovalSource && executionMode === "foreground") {
        return autoExecuteShellProposal({
          workspacePath: safeWorkspace,
          shell,
          timeoutMs: timeout,
          blockUntilMs,
          autoApprovalMeta: buildAutoApprovalMeta(autoApprovalSource, matchedRule),
          signal,
        });
      }
      return {
        content: JSON.stringify({
          action_type: "shell",
          action_id: action.id,
          shell,
          timeout_ms: timeout,
          execution_mode: executionMode,
          ready_url: readyUrl,
          ready_timeout_ms: readyTimeoutMs,
          approval_required: true,
          proposal_created: true,
          execution_state: "pending_approval",
          command_executed: false,
          action_status: action.status,
          message:
            executionMode === "background"
              ? "后台 Shell 命令已创建待审批动作，将在审批后异步启动。"
              : "Shell 命令已创建待审批动作，尚未执行。",
        }),
        success: true,
        traceStatus: "pending_approval",
        proposedAction: action,
      };
    }

    if (call.function.name === "check_shell_job") {
      const jobId = asString(args.job_id).trim();
      if (!jobId) {
        return {
          content: JSON.stringify({ error: "job_id 不能为空" }),
          success: false,
          errorCategory: "validation" as const,
          errorMessage: "job_id 不能为空",
        };
      }
      try {
        const status = await checkShellJob(jobId);
        const message = !status.found
          ? "该 job 未找到（从未存在或早于当前会话）"
          : status.completed
            ? status.success
              ? `进程已完成（exit_code=${status.exit_code ?? 0}）`
              : `进程已失败（exit_code=${status.exit_code ?? -1}，timed_out=${status.timed_out ?? false}）`
            : status.running
              ? "进程仍在运行中"
              : "进程已退出（结果尚未记录）";
        return {
          content: JSON.stringify({
            job_id: jobId,
            running: status.running,
            found: status.found,
            completed: status.completed,
            cancelled: status.cancelled ?? false,
            ...(status.completed
              ? {
                success: status.success,
                exit_code: status.exit_code,
                timed_out: status.timed_out ?? false,
                stdout: status.stdout ?? "",
                stderr: status.stderr ?? "",
              }
              : {}),
            message,
          }),
          success: true,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: JSON.stringify({ error: msg }),
          success: false,
          errorCategory: "validation" as const,
          errorMessage: msg,
        };
      }
    }

    if (call.function.name === "diagnostics") {
      const changedFiles = Array.isArray(args.changed_files)
        ? (args.changed_files as string[])
          .map((f) => String(f).trim())
          .filter(Boolean)
        : undefined;
      const result = await invoke<{
        success: boolean;
        diagnostics: Array<{
          file: string;
          line: number;
          column: number;
          severity: string;
          message: string;
        }>;
        tool_used: string;
        raw_output: string;
      }>("get_workspace_diagnostics", {
        workspacePath: safeWorkspace,
        changedFiles:
          changedFiles && changedFiles.length > 0 ? changedFiles : null,
      });

      const errorCount = result.diagnostics.filter(
        (d) => d.severity === "error"
      ).length;
      const warningCount = result.diagnostics.filter(
        (d) => d.severity === "warning"
      ).length;
      const diagnosticsPreview = result.diagnostics
        .slice(0, 50)
        .map(
          (d) =>
            `${d.severity.toUpperCase()} ${d.file}:${d.line}:${d.column} ${d.message
            }`
        )
        .join("\n");

      return {
        content: JSON.stringify({
          ok: true,
          tool_used: result.tool_used,
          error_count: errorCount,
          warning_count: warningCount,
          total_diagnostics: result.diagnostics.length,
          diagnostics_preview: deps.smartTruncate(
            diagnosticsPreview,
            MAX_FILE_PREVIEW_CHARS
          ),
        }),
        success: true,
      };
    }

    if (call.function.name === "fetch") {
      const url = asString(args.url).trim();
      if (!url) {
        const message = "url 不能为空";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }
      const maxSize = normalizeOptionalPositiveInt(args.max_size);
      const result = await invoke<{
        success: boolean;
        url: string;
        content_type: string | null;
        content: string;
        truncated: boolean;
        error: string | null;
      }>("fetch_url", {
        url,
        maxSize: maxSize || null,
        proxy: settings?.proxy ?? null,
      });

      if (!result.success) {
        const errorMsg = result.error || "请求失败";
        return {
          content: JSON.stringify({
            ok: false,
            url: result.url,
            error: errorMsg,
          }),
          success: false,
          errorCategory: "validation",
          errorMessage: errorMsg,
        };
      }

      return {
        content: JSON.stringify({
          ok: true,
          url: result.url,
          content_type: result.content_type,
          truncated: result.truncated,
          content_preview: deps.smartTruncate(
            result.content,
            MAX_FILE_PREVIEW_CHARS
          ),
        }),
        success: true,
      };
    }

    if (call.function.name === "ask_user") {
      const question = asString(args.question).trim();
      if (!question) {
        const message = "question 不能为空";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }

      const context = asString(args.context).trim() || undefined;
      const options = Array.isArray(args.options)
        ? (args.options as string[]).map((opt) => String(opt).trim()).filter(Boolean)
        : undefined;
      const allowMultiple = args.allow_multiple !== undefined ? asBoolean(args.allow_multiple, false) : false;
      const required = args.required !== undefined ? asBoolean(args.required, true) : true;

      if (!sessionId) {
        const message = "ask_user 工具需要 sessionId，当前调用缺少 session 上下文";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }

      const requestId = createAskUserRequest(
        sessionId,
        question,
        context,
        options,
        allowMultiple,
        required
      );

      // Notify UI so it can show the dialog
      onAskUserRequest?.({
        id: requestId,
        sessionId,
        question,
        context,
        options,
        allowMultiple,
        required,
        timestamp: new Date().toISOString(),
      });

      // Block tool loop until user responds (or cancels / signal aborts)
      let userResponse;
      try {
        userResponse = await waitForUserResponse(requestId, signal);
      } catch (_err) {
        return {
          content: JSON.stringify({
            ok: false,
            request_id: requestId,
            skipped: true,
            response: null,
            message: "用户取消了输入请求。",
          }),
          success: true,
        };
      }

      return {
        content: JSON.stringify({
          ok: true,
          request_id: requestId,
          question,
          response: userResponse.response || null,
          skipped: userResponse.skipped,
          options: options || null,
        }),
        success: true,
      };
    }

    return {
      content: JSON.stringify({
        error: `"${call.function.name}" is not a valid tool, try one of [${(enabledToolNames ?? ALL_TOOL_NAMES).join(", ")}].`,
      }),
      success: false,
      errorCategory: "tool_not_found",
      errorMessage: `未知工具: ${call.function.name}`,
    };
  } catch (error) {
    const message = String(error || "Unknown error");
    return {
      content: JSON.stringify({ error: message }),
      success: false,
      errorCategory: classifyToolError(message),
      errorMessage: message,
    };
  }
}

export async function executeToolCallWithRetry(
  call: ToolCallRecord,
  workspacePath: string,
  deps: ToolExecutorDeps,
  toolPermissions: ToolPermissions = DEFAULT_TOOL_PERMISSIONS,
  settings?: AppSettings,
  projectConfig?: CofreeRcConfig,
  enabledToolNames?: string[],
  planState?: TodoPlanStateLike,
  workingMemory?: WorkingMemory,
  signal?: AbortSignal,
  turn?: number,
  focusedPaths?: string[],
  sessionId?: string,
  onAskUserRequest?: (request: AskUserRequest) => void,
  autoExecutionPolicy: SensitiveWriteAutoExecutionPolicy = "allow",
): Promise<{
  result: ToolExecutionResult;
  trace: ToolExecutionTrace;
}> {
  const startedAt = deps.nowIso();
  let attempts = 0;
  let lastResult: ToolExecutionResult = {
    content: JSON.stringify({ error: "工具调用未执行" }),
    success: false,
    errorCategory: "unknown",
    errorMessage: "工具调用未执行",
  };

  while (attempts < MAX_TOOL_RETRY) {
    attempts += 1;

    // Apply exponential backoff delay between retry attempts
    if (attempts > 1) {
      const retryDelay = computeToolRetryDelay(attempts);
      console.log(
        `[ToolRetry] 工具 "${call.function.name}" 第 ${attempts} 次重试，延迟 ${Math.round(retryDelay)}ms`
      );
      await sleep(retryDelay, signal);
    }

    const current = await executeToolCall(
      call,
      workspacePath,
      deps,
      toolPermissions,
      settings,
      projectConfig,
      enabledToolNames,
      planState,
      workingMemory,
      signal,
      turn,
      focusedPaths,
      sessionId,
      onAskUserRequest,
      autoExecutionPolicy,
    );
    const success = current.success !== false;
    const traceStatus: ToolExecutionStatus = success
      ? current.traceStatus ?? "success"
      : "failed";
    const errorCategory =
      current.errorCategory ?? (success ? undefined : "unknown");
    const errorMessage =
      current.errorMessage ?? (success ? undefined : "工具调用失败");
    lastResult = {
      ...current,
      success,
      errorCategory,
      errorMessage,
      traceStatus,
    };

    if (success) {
      return {
        result: lastResult,
        trace: {
          callId: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
          startedAt,
          finishedAt: deps.nowIso(),
          attempts,
          status: traceStatus,
          retried: attempts > 1,
          resultPreview: resultPreview(current.content),
        },
      };
    }

    if (!shouldRetryToolCall(errorCategory ?? "unknown")) {
      break;
    }
  }

  // Append contextual error recovery hint to help the LLM self-correct
  const recoveryHint = buildToolErrorRecoveryHint(
    call.function.name,
    lastResult.errorCategory ?? "unknown",
    lastResult.errorMessage ?? "未知错误",
  );
  const enrichedContent = (() => {
    try {
      const parsed = JSON.parse(lastResult.content);
      parsed._recovery_hint = recoveryHint;
      return JSON.stringify(parsed);
    } catch {
      return JSON.stringify({
        error: lastResult.errorMessage ?? "工具调用失败",
        _recovery_hint: recoveryHint,
      });
    }
  })();

  return {
    result: {
      ...lastResult,
      content: enrichedContent,
    },
    trace: {
      callId: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
      startedAt,
      finishedAt: deps.nowIso(),
      attempts,
      status: "failed",
      retried: attempts > 1,
      errorCategory: lastResult.errorCategory,
      errorMessage: lastResult.errorMessage,
      resultPreview: resultPreview(enrichedContent),
    },
  };
}
