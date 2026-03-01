/**
 * Cofree - AI Programming Cafe
 * File: src/orchestrator/planningService.ts
 * Milestone: 3
 * Task: 3.5
 * Status: In Progress
 * Owner: Codex-GPT-5
 * Last Modified: 2026-03-01
 * Description: Native tool-calling orchestration loop with explicit HITL gate generation.
 */

import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_AGENTS } from "../agents/defaultAgents";
import { recordLLMAudit } from "../lib/auditLog";
import {
  createLiteLLMRequestBody,
  isLocalProvider,
  postLiteLLMChatCompletions,
  type LiteLLMMessage,
  type LiteLLMToolDefinition
} from "../lib/litellm";
import type { AppSettings } from "../lib/settingsStore";
import type { ActionProposal, OrchestrationPlan, PlanStep } from "./types";
const MAX_TOOL_LOOP_TURNS = 15;
const MAX_LIST_ENTRIES = 120;
const MAX_FILE_PREVIEW_CHARS = 4000;
const MAX_TOOL_RESULT_PREVIEW = 400;
const MAX_TOOL_RETRY = 2;
const MAX_PATCH_REPAIR_ROUNDS = 1;
const MAX_CREATE_HINT_REPAIR_ROUNDS = 1;
const MAX_MULTI_ARTIFACT_REMINDER_ROUNDS = 2;

interface ToolCallRecord {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface ToolExecutionResult {
  content: string;
  proposedAction?: ActionProposal;
  errorCategory?: ToolErrorCategory;
  errorMessage?: string;
  success?: boolean;
}

interface ChatCompletionChoiceMessage {
  content?: unknown;
  tool_calls?: unknown;
}

interface ChatCompletionPayload {
  id?: string;
  choices?: Array<{
    message?: ChatCompletionChoiceMessage;
  }>;
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

const ASSISTANT_SYSTEM_PROMPT = [
  "你是 Cofree 的服务员。你的目标是作为一名顶级的全栈工程师协助用户。",
  "你必须优先通过可用工具获取事实，再给出答案。必须严格遵守以下工作流原则（Vibe Coding 原则）：",
  "1) **Show, don't tell**：少废话，多干活。直接执行任务，不要在回复中长篇大论解释代码原理、功能特点，除非用户明确要求解释。",
  "2) **信任系统回调**：当系统提示动作成功（如 apply_patch, shell 等）时，直接信任结果并继续执行。不要做无意义重复读取；但在 patch/编辑失败后，允许有针对性地重新读取相关片段并修复。",
  "3) **极简交流**：在报告完成任务时，只需简短回答\u201C已完成\u201D或指明结果位置。绝对不要为了凑字数而列举无关内容。",
  "当用户要求新增/修改/删除文件、执行命令或 git 写操作时：",
  "1) 不要直接执行副作用；",
  "2) 必须通过当前已暴露的 propose_* 工具提出待审批动作（不要假设未暴露工具可用）。",
  "2.1) 单文件、小中型改动优先用 propose_file_edit；它支持 replace / insert / delete / create，也支持 line/start_line/end_line 按行定位，系统会自动把编辑转换为 patch。",
  "2.2) 仅在明确需要 raw diff/patch 时使用 propose_apply_patch，并确保 patch 是合法 unified diff。",
  "2.3) 如果目标是执行任何命令（构建、测试、删除、git 操作等），使用 propose_shell。命令将显示给用户审批后执行。",
  "2.4) 如果收到 patch 预检失败反馈，优先重新读取必要片段后修正，并在一次自动修复重试内完成。",
  "**重要**：调用 propose_* 工具后，立即停止生成文本。不要预测审批结果，不要说\"用户未批准\"或\"等待用户批准\"等话。系统会自动处理审批流程并在执行后通知你结果。",
  "3) 如果用户仅在询问信息或解释且不需要落盘，不要提出审批动作。",
  "4) 禁止为了兜底一次性提出三条审批动作，必须最小化且与当前任务直接相关。",
  "",
  "## 工具选择关键规则",
  "- **创建新文件**：必须使用 propose_file_edit，设置 operation='create'、relative_path 和 content。绝对不要用 cat/echo 重定向。",
  "- **删除文件/目录**：使用 propose_shell，shell='rm -r <路径>' 或 'rm <文件>'。",
  "- **命令执行**：使用 propose_shell，可以使用完整 shell 语法（管道、重定向、&& 等）。示例：propose_shell(shell='npm install && npm test')。",
  "- **Git 操作**：使用 propose_shell，shell='git add .' 或 'git commit -m \"message\"' 或 'git checkout -b branch'。",
  "- **propose_file_edit 的 relative_path 是必填参数**，所有操作都必须提供。",
  "- **replace 操作**必须提供 search（要替换的原文）或 start_line/end_line（行范围）。如果文件不存在，请改用 operation='create'。",
  "- 当工具调用失败时，仔细阅读错误信息并调整参数重试，而不是盲目切换工具。",
  "",
  "当读取文件系统信息时，必须调用 list_files/read_file/git_status/git_diff，而不是伪造结果。读取大文件时优先使用 read_file 的 start_line/end_line 参数按片段读取。",
  "严禁输出伪工具调用标签（如 <tool_call>）。",
  "回复语言与用户保持一致。"
].join("\n");
const TOOL_DEFINITIONS: LiteLLMToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files/directories under workspace relative path.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          relative_path: {
            type: "string",
            description: "Workspace-relative directory path. Empty means workspace root."
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file content by workspace-relative path, optionally by line range.",
      parameters: {
        type: "object",
        required: ["relative_path"],
        additionalProperties: false,
        properties: {
          relative_path: {
            type: "string",
            minLength: 1,
            description: "Workspace-relative file path."
          },
          start_line: {
            type: "number",
            minimum: 1,
            description: "Optional 1-based start line for partial read."
          },
          end_line: {
            type: "number",
            minimum: 1,
            description: "Optional 1-based end line for partial read."
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "git_status",
      description: "Get git status summary in workspace repository.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {}
      }
    }
  },
  {
    type: "function",
    function: {
      name: "git_diff",
      description: "Get workspace git diff, optionally filtered to one file.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          file_path: {
            type: "string",
            description: "Optional workspace-relative file path."
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "propose_apply_patch",
      description:
        "Advanced raw patch path. Propose a write action by submitting unified diff patch for HITL approval (does not execute). Use only when explicit patch/diff is requested or structured edits cannot express the task.\n\nMinimal example:\ndiff --git a/src/foo.ts b/src/foo.ts\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,3 +1,3 @@\n-old line\n+new line",
      parameters: {
        type: "object",
        required: ["patch"],
        additionalProperties: false,
        properties: {
          patch: {
            type: "string",
            description: "Unified diff patch content. MUST include 'diff --git' header. For new files: 'diff --git a/file b/file' then '--- /dev/null' and '+++ b/file'. For edits: 'diff --git a/file b/file' then '--- a/file' and '+++ b/file'. For delete-file patches: include 'deleted file mode 100644', then '--- a/file' and '+++ /dev/null'."
          },
          description: {
            type: "string",
            description: "Optional short description for reviewers."
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "propose_file_edit",
      description:
        "Propose deterministic single-file text edit. Supports replace/insert/delete/create operations. System will generate and validate patch for HITL approval.\n\nUsage examples:\n- Create new file: {relative_path:'src/foo.ts', operation:'create', content:'...'}\n- Replace by search: {relative_path:'src/foo.ts', search:'old text', replace:'new text'}\n- Replace by line range: {relative_path:'src/foo.ts', start_line:10, end_line:15, content:'replacement'}\n- Insert after line: {relative_path:'src/foo.ts', operation:'insert', line:5, content:'new line'}\n- Delete snippet: {relative_path:'src/foo.ts', operation:'delete', search:'text to remove'}\n\nIMPORTANT: relative_path is REQUIRED for all operations.",
      parameters: {
        type: "object",
        required: ["relative_path"],
        additionalProperties: false,
        properties: {
          relative_path: {
            type: "string",
            minLength: 1,
            description: "Workspace-relative file path."
          },
          operation: {
            type: "string",
            enum: ["replace", "insert", "delete", "create"],
            description:
              "Edit operation. Defaults to 'replace' for backward compatibility."
          },
          search: {
            type: "string",
            description:
              "For replace/delete-in-file: exact snippet to find. For backward-compatible insert, may be used as anchor."
          },
          replace: {
            type: "string",
            description:
              "For replace: replacement text. For backward-compatible insert/create, may be used as inserted/content text."
          },
          anchor: {
            type: "string",
            description: "For insert: exact anchor snippet in file."
          },
          line: {
            type: "number",
            minimum: 1,
            description: "For insert: 1-based target line used as insertion anchor."
          },
          start_line: {
            type: "number",
            minimum: 1,
            description: "For replace/delete: optional 1-based start line of the target range."
          },
          end_line: {
            type: "number",
            minimum: 1,
            description: "For replace/delete: optional 1-based end line of the target range."
          },
          content: {
            type: "string",
            description: "For insert/create: inserted or full file content."
          },
          position: {
            type: "string",
            enum: ["before", "after"],
            description: "For insert: insert before or after anchor. Defaults to 'after'."
          },
          replace_all: {
            type: "boolean",
            description:
              "For replace: replace all matches. For backward compatibility, also used as generic apply_all flag."
          },
          apply_all: {
            type: "boolean",
            description: "For replace/insert/delete-in-file: apply operation to all matches."
          },
          overwrite: {
            type: "boolean",
            description:
              "For create: when true and file already exists, update file content instead of failing."
          },
          description: {
            type: "string",
            description: "Optional short description for reviewers."
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "propose_shell",
      description:
        "Propose a shell command execution action for HITL approval (does not execute). Supports full shell syntax including pipes, redirects, and chaining.\n\nExamples:\n- propose_shell(shell='npm install && npm test')\n- propose_shell(shell='rm -r old_dir')\n- propose_shell(shell='git add . && git commit -m \"Update\"')\n- propose_shell(shell='cargo build --release')\n\nThe command will be shown to the user for approval before execution.",
      parameters: {
        type: "object",
        required: ["shell"],
        additionalProperties: false,
        properties: {
          shell: {
            type: "string",
            minLength: 1,
            description: "Full shell command string. Can use pipes (|), redirects (>, <), chaining (&&, ;), variables ($VAR), etc."
          },
          timeout_ms: {
            type: "number",
            minimum: 1000,
            maximum: 600000,
            description: "Optional execution timeout in milliseconds. Defaults to 120000 (2 minutes)."
          },
          description: {
            type: "string",
            description: "Optional short description for reviewers."
          }
        }
      }
    }
  }
];

type ToolRoutingMode =
  | "read_only"
  | "structured_edit"
  | "explicit_patch"
  | "delete_file"
  | "shell_command"
  | "summary_only";

export type PlanningSessionPhase = "default" | "post_action_summary";

interface ToolRoutingPolicy {
  mode: ToolRoutingMode;
  reason: string;
  toolNames: string[];
}

const READ_ONLY_TOOL_NAMES = ["list_files", "read_file", "git_status", "git_diff"];
const PATCH_INTENT_HINTS = ["patch", "diff", "unified diff", "hunk", "补丁", "差异", "diff 格式"];
const COMMAND_INTENT_HINTS = [
  "运行",
  "执行",
  "命令",
  "测试",
  "构建",
  "编译",
  "lint",
  "验证",
  "run ",
  "execute",
  "command",
  "test",
  "build",
  "compile",
  "check",
  "validate",
  "pnpm ",
  "npm ",
  "cargo ",
  "bun ",
  "pytest"
];
const WRITE_INTENT_HINTS = [
  "新增",
  "新建",
  "创建",
  "生成",
  "修改",
  "修复",
  "编辑",
  "重构",
  "更新",
  "实现",
  "写入",
  "replace",
  "insert",
  "delete",
  "create file",
  "new file",
  "modify",
  "change",
  "edit",
  "write ",
  "fix",
  "refactor",
  "update"
];

function includesAnyHint(text: string, hints: string[]): boolean {
  return hints.some((hint) => text.includes(hint));
}

function hasPromptCommandIntent(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return includesAnyHint(lower, COMMAND_INTENT_HINTS);
}

function hasPromptWriteIntent(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  if (includesAnyHint(lower, WRITE_INTENT_HINTS)) {
    return true;
  }

  if (/(写|创建|生成|新建).{0,8}(脚本|文件|代码)/.test(prompt)) {
    return true;
  }
  if (/(write|create|generate).{0,16}(script|file|code)/i.test(prompt)) {
    return true;
  }

  return false;
}

function hasExplicitPatchIntent(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return includesAnyHint(lower, PATCH_INTENT_HINTS);
}

function hasWholeFileDeleteIntent(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  if (/\brm\s+[^\s]+\b/.test(lower)) {
    return true;
  }
  if (/(delete|remove)\s+(the\s+)?file/.test(lower)) {
    return true;
  }

  const mentionsDelete =
    prompt.includes("删除") || prompt.includes("删掉") || prompt.includes("移除");
  const mentionsFile = prompt.includes("文件") || /\.[a-z0-9]{1,8}\b/i.test(prompt);
  const mentionsInFileScope =
    prompt.includes("行") ||
    prompt.includes("片段") ||
    prompt.includes("内容") ||
    prompt.includes("函数") ||
    prompt.includes("变量");

  return mentionsDelete && mentionsFile && !mentionsInFileScope;
}

function estimateRequestedArtifactCount(prompt: string): number {
  const normalized = prompt.trim();
  if (!normalized) {
    return 0;
  }

  const segments = normalized
    .split(/(?:\s+and\s+|\s+plus\s+|以及|并且|还有|和|，|,|；|;)/i)
    .map((segment) => segment.trim())
    .filter(Boolean);

  const artifactPattern = /(?:\.py\b|\.html\b|python|html|脚本|页面|网页|文件)/i;
  const explicitCount = segments.filter((segment) => artifactPattern.test(segment)).length;
  if (explicitCount > 0) {
    return explicitCount;
  }

  return artifactPattern.test(normalized) ? 1 : 0;
}

function collectPatchedFiles(patch: string): string[] {
  const files = new Set<string>();
  for (const rawLine of patch.split(/\r?\n/)) {
    const line = rawLine.trim();
    const diffMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (diffMatch) {
      if (diffMatch[1] && diffMatch[1] !== "/dev/null") {
        files.add(diffMatch[1]);
      }
      if (diffMatch[2] && diffMatch[2] !== "/dev/null") {
        files.add(diffMatch[2]);
      }
      continue;
    }

    const plusMatch = line.match(/^\+\+\+\s+b\/(.+)$/);
    if (plusMatch?.[1]) {
      files.add(plusMatch[1]);
    }
  }

  return Array.from(files);
}

function countPlannedArtifacts(actions: ActionProposal[]): number {
  const artifacts = new Set<string>();

  for (const action of actions) {
    if (action.type === "apply_patch") {
      const patchFiles = collectPatchedFiles(action.payload.patch);
      if (patchFiles.length > 0) {
        patchFiles.forEach((file) => artifacts.add(`file:${file}`));
        continue;
      }
    }

    artifacts.add(`action:${action.id}`);
  }

  return artifacts.size;
}

function selectToolDefinitions(toolNames: string[]): LiteLLMToolDefinition[] {
  const enabled = new Set(toolNames);
  return TOOL_DEFINITIONS.filter((tool) => enabled.has(tool.function.name));
}

function inferToolRoutingPolicy(
  prompt: string,
  phase: PlanningSessionPhase = "default"
): ToolRoutingPolicy {
  if (phase === "post_action_summary") {
    return {
      mode: "summary_only",
      reason: "当前处于审批结果汇报阶段，仅允许基于已知结果生成总结。",
      toolNames: []
    };
  }

  const writeIntent = hasPromptWriteIntent(prompt);
  const commandIntent = hasPromptCommandIntent(prompt);
  const gitIntent = hasExplicitGitIntent(prompt);
  const patchIntent = hasExplicitPatchIntent(prompt);
  const deleteFileIntent = hasWholeFileDeleteIntent(prompt);

  const toolNames = new Set<string>(READ_ONLY_TOOL_NAMES);

  // When any write/patch/delete/command/git intent is detected, expose ALL write tools
  // so the LLM can choose the most appropriate one.
  const anyWriteIntent = writeIntent || patchIntent || deleteFileIntent || commandIntent || gitIntent;

  if (anyWriteIntent) {
    toolNames.add("propose_file_edit");
    toolNames.add("propose_apply_patch");
    toolNames.add("propose_shell");
  }

  if (deleteFileIntent) {
    return {
      mode: "delete_file",
      reason: "检测到整文件删除意图，优先走 shell rm 路径。",
      toolNames: Array.from(toolNames)
    };
  }
  if (patchIntent) {
    return {
      mode: "explicit_patch",
      reason: "检测到显式 patch/diff 意图，优先走 raw patch 路径。",
      toolNames: Array.from(toolNames)
    };
  }
  if (writeIntent) {
    return {
      mode: "structured_edit",
      reason: "检测到代码修改意图，优先走结构化文件编辑路径。",
      toolNames: Array.from(toolNames)
    };
  }
  if (commandIntent || gitIntent) {
    return {
      mode: "shell_command",
      reason: "检测到命令/git 执行意图。",
      toolNames: Array.from(toolNames)
    };
  }

  return {
    mode: "read_only",
    reason: "未检测到写入/命令意图，保持只读工具集。",
    toolNames: Array.from(toolNames)
  };
}

export class LocalOnlyPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalOnlyPolicyError";
  }
}

export interface RunPlanningSessionInput {
  prompt: string;
  settings: AppSettings;
  phase?: PlanningSessionPhase;
  conversationHistory?: Array<{
    role: "user" | "assistant";
    content: string;
  }>;
  internalSystemNote?: string;
  signal?: AbortSignal;
  onAssistantChunk?: (chunk: string) => void;
}

export interface PlanningSessionResult {
  assistantReply: string;
  plan: OrchestrationPlan;
  toolTrace: ToolExecutionTrace[];
}

interface RequestRecord {
  requestId: string;
  inputLength: number;
  outputLength: number;
}

export type ToolErrorCategory =
  | "validation"
  | "workspace"
  | "permission"
  | "timeout"
  | "allowlist"
  | "transport"
  | "guardrail"
  | "tool_not_found"
  | "unknown";

export interface ToolExecutionTrace {
  callId: string;
  name: string;
  arguments: string;
  startedAt: string;
  finishedAt: string;
  attempts: number;
  status: "success" | "failed";
  retried: boolean;
  errorCategory?: ToolErrorCategory;
  errorMessage?: string;
  resultPreview?: string;
}

function createRequestId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function normalizeMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (
          item &&
          typeof item === "object" &&
          "type" in item &&
          (item as Record<string, unknown>).type === "text" &&
          "text" in item &&
          typeof (item as Record<string, unknown>).text === "string"
        ) {
          return (item as Record<string, string>).text;
        }
        return "";
      })
      .join("");
  }

  return "";
}

// 粗略估计 Token 数量：中英文混排时大致 1 个汉字≈1-2 token，英文字符数/4≈token。
// 这里简单使用字符串长度来做保守估算，假设平均 1 token ≈ 2.5 字符。
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2.5);
}

function sanitizeConversationHistory(
  conversationHistory: RunPlanningSessionInput["conversationHistory"],
  maxTokens: number
): LiteLLMMessage[] {
  if (!conversationHistory?.length) {
    return [];
  }

  const validMessages = conversationHistory
    .map((message) => ({
      role: message.role,
      content: message.content.trim()
    }))
    .filter((message) => Boolean(message.content));

  // 如果用户未设置或异常，回退到 128k 默认限制 (128000 * 2.5 = 320000 字符)
  const limitTokens = maxTokens > 0 ? maxTokens : 128000;
  const bufferTokens = 8000; // 留给 System Prompt 和当前回复的空间
  const maxAllowedTokens = limitTokens - bufferTokens;

  let currentTokens = 0;
  const selectedMessages: LiteLLMMessage[] = [];

  // 从新到旧遍历，保留尽可能多的最近消息
  for (let i = validMessages.length - 1; i >= 0; i--) {
    const msg = validMessages[i];
    const tokens = estimateTokens(msg.content);
    if (currentTokens + tokens > maxAllowedTokens) {
      // 如果单条消息就超大，但已经是最新的一条，或者为了防止上下文截断过严：
      // 插入一条系统提示，要求 LLM 注意上下文已被截断或需要压缩。
      selectedMessages.unshift({
        role: "system",
        content: "[系统提示] 之前的对话历史由于达到上下文长度限制已被截断。请基于现有的最新信息继续工作。"
      });
      break;
    }
    selectedMessages.unshift(msg);
    currentTokens += tokens;
  }

  return selectedMessages;
}

function inputLengthOf(messages: LiteLLMMessage[]): number {
  return messages.reduce((total, message) => total + message.content.length, 0);
}

function parseErrorMessage(raw: string, status: number): string {
  if (!raw.trim()) {
    return `${status}`;
  }

  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } };
    return parsed.error?.message ?? raw.slice(0, 240);
  } catch (_error) {
    return raw.slice(0, 240);
  }
}

function parseCompletionPayload(raw: string): ChatCompletionPayload {
  try {
    const parsed = JSON.parse(raw) as ChatCompletionPayload;
    if (!parsed || typeof parsed !== "object") {
      throw new Error("completion payload invalid");
    }
    return parsed;
  } catch (_error) {
    throw new Error("模型响应不是有效 JSON。");
  }
}

function parseToolCalls(raw: unknown): ToolCallRecord[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((item, index) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const record = item as Record<string, unknown>;
      const fn = record.function;
      if (!fn || typeof fn !== "object") {
        return null;
      }
      const fnRecord = fn as Record<string, unknown>;
      if (typeof fnRecord.name !== "string" || typeof fnRecord.arguments !== "string") {
        return null;
      }
      const id =
        typeof record.id === "string" && record.id.trim()
          ? record.id
          : `toolcall-${index + 1}-${Date.now()}`;
      return {
        id,
        type: "function" as const,
        function: {
          name: fnRecord.name,
          arguments: fnRecord.arguments
        }
      };
    })
    .filter((item): item is ToolCallRecord => Boolean(item));
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
      hasTrailingNewline: false
    };
  }

  const hasTrailingNewline = content.endsWith("\n");
  const body = hasTrailingNewline ? content.slice(0, -1) : content;

  return {
    lines: body.length > 0 ? body.split("\n") : [""],
    hasTrailingNewline
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

function insertByLine(content: string, line: number, insertContent: string, position: "before" | "after"): string {
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

function buildReplacementPatch(relativePath: string, before: string, after: string): string {
  if (before === after) {
    throw new Error("编辑结果为空，未产生文件变更。");
  }

  const previous = splitPatchLines(before);
  const next = splitPatchLines(after);
  const previousCount = previous.lines.length;
  const nextCount = next.lines.length;
  const previousStart = previousCount > 0 ? 1 : 0;
  const nextStart = nextCount > 0 ? 1 : 0;
  const hunkLines: string[] = [];

  for (const line of previous.lines) {
    hunkLines.push(`-${line}`);
  }
  if (previous.lines.length > 0 && !previous.hasTrailingNewline) {
    hunkLines.push("\\ No newline at end of file");
  }

  for (const line of next.lines) {
    hunkLines.push(`+${line}`);
  }
  if (next.lines.length > 0 && !next.hasTrailingNewline) {
    hunkLines.push("\\ No newline at end of file");
  }

  return [
    `diff --git a/${relativePath} b/${relativePath}`,
    `--- a/${relativePath}`,
    `+++ b/${relativePath}`,
    `@@ -${formatUnifiedRange(previousStart, previousCount)} +${formatUnifiedRange(nextStart, nextCount)} @@`,
    ...hunkLines
  ].join("\n") + "\n";
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

  return [
    `diff --git a/${relativePath} b/${relativePath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${relativePath}`,
    `@@ -0,0 +${formatUnifiedRange(1, next.lines.length)} @@`,
    ...hunkLines
  ].join("\n") + "\n";
}

function createActionId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function nowIso(): string {
  return new Date().toISOString();
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
  if (lower.includes("patch does not apply") || lower.includes("corrupt patch")) {
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
  if (lower.includes("fetch") || lower.includes("network") || lower.includes("http")) {
    return "transport";
  }
  return "unknown";
}

function shouldRetryToolCall(category: ToolErrorCategory): boolean {
  return category === "transport" || category === "timeout";
}

function resultPreview(content: string): string {
  return content.slice(0, MAX_TOOL_RESULT_PREVIEW);
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

async function executeToolCall(
  call: ToolCallRecord,
  workspacePath: string
): Promise<ToolExecutionResult> {
  const safeWorkspace = workspacePath.trim();
  if (!safeWorkspace) {
    const message = "未选择工作区。";
    return {
      content: JSON.stringify({ error: message }),
      success: false,
      errorCategory: "workspace",
      errorMessage: message
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
      errorMessage: message
    };
  }

  try {
    if (call.function.name === "list_files") {
      const relativePath = normalizeRelativePath(args.relative_path);
      const entries = await invoke<FileEntry[]>("list_workspace_files", {
        workspacePath: safeWorkspace,
        relativePath
      });
      return {
        content: JSON.stringify({
          ok: true,
          relative_path: relativePath,
          entry_count: entries.length,
          entries_preview: renderListEntries(entries)
        }),
        success: true
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
          errorMessage: message
        };
      }
      if (startLine && endLine && startLine > endLine) {
        const message = "start_line 不能大于 end_line";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message
        };
      }
      const content = await invoke<string>("read_workspace_file", {
        workspacePath: safeWorkspace,
        relativePath,
        startLine,
        endLine
      });
      const trimmed = content.slice(0, MAX_FILE_PREVIEW_CHARS);
      return {
        content: JSON.stringify({
          ok: true,
          relative_path: relativePath,
          start_line: startLine,
          end_line: endLine,
          content_preview: trimmed,
          truncated: content.length > trimmed.length
        }),
        success: true
      };
    }

    if (call.function.name === "git_status") {
      const status = await invoke<{
        modified: string[];
        added: string[];
        deleted: string[];
        untracked: string[];
      }>("git_status_workspace", {
        workspacePath: safeWorkspace
      });
      return {
        content: JSON.stringify({
          ok: true,
          ...status
        }),
        success: true
      };
    }

    if (call.function.name === "git_diff") {
      const filePath = normalizeRelativePath(args.file_path);
      const diff = await invoke<string>("git_diff_workspace", {
        workspacePath: safeWorkspace,
        filePath: filePath || null
      });
      return {
        content: JSON.stringify({
          ok: true,
          file_path: filePath || null,
          diff_preview: diff.slice(0, MAX_FILE_PREVIEW_CHARS),
          truncated: diff.length > MAX_FILE_PREVIEW_CHARS
        }),
        success: true
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
          errorMessage: message
        };
      }
      const preflight = await invoke<PatchApplyResult>("check_workspace_patch", {
        workspacePath: safeWorkspace,
        patch
      });
      if (!preflight.success) {
        const message = `Patch 预检失败: ${preflight.message}`;
        return {
          content: JSON.stringify({
            error: message,
            files: preflight.files
          }),
          success: false,
          errorCategory: "validation",
          errorMessage: message
        };
      }
      const action: ActionProposal = {
        id: createActionId("gate-a-apply-patch"),
        type: "apply_patch",
        description: asString(args.description, "Apply generated patch to workspace (Gate A)"),
        gateRequired: true,
        status: "pending",
        executed: false,
        payload: {
          patch
        }
      };
      return {
        content: JSON.stringify({
          ok: true,
          action_type: "apply_patch",
          action_id: action.id,
          patch_length: patch.length,
          files: preflight.files
        }),
        success: true,
        proposedAction: action
      };
    }

    if (call.function.name === "propose_file_edit") {
      const relativePath = normalizeRelativePath(args.relative_path);
      const operationRaw = asString(args.operation, "replace").trim().toLowerCase();
      const operation = operationRaw || "replace";
      const applyAll = asBoolean(args.apply_all, asBoolean(args.replace_all, false));
      const positionCandidate = asString(args.position, "after").trim().toLowerCase();
      const insertPosition = positionCandidate === "before" ? "before" : "after";
      const line = normalizeOptionalPositiveInt(args.line);
      const startLine = normalizeOptionalPositiveInt(args.start_line);
      const endLine = normalizeOptionalPositiveInt(args.end_line);
      if (!relativePath) {
        const message = "relative_path 不能为空";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message
        };
      }
      let patch = "";
      const responseMeta: Record<string, unknown> = {
        mode: "file_edit",
        operation,
        relative_path: relativePath,
        apply_all: applyAll
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
          errorMessage: message
        };
      }
      if (startLine && endLine && startLine > endLine) {
        const message = "start_line 不能大于 end_line";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message
        };
      }

      if (operation === "create") {
        const createContent = asString(args.content, asString(args.replace));
        const overwrite = asBoolean(args.overwrite, false);
        if (!createContent) {
          const message = "create 操作要求 content 非空";
          return {
            content: JSON.stringify({ error: message }),
            success: false,
            errorCategory: "validation",
            errorMessage: message
          };
        }

        let existingContent: string | null = null;
        try {
          existingContent = await invoke<string>("read_workspace_file", {
            workspacePath: safeWorkspace,
            relativePath
          });
        } catch (_error) {
          existingContent = null;
        }

        if (existingContent !== null && !overwrite) {
          const message = `目标文件已存在: ${relativePath}（如需覆盖请设置 overwrite=true）`;
          return {
            content: JSON.stringify({ error: message }),
            success: false,
            errorCategory: "validation",
            errorMessage: message
          };
        }

        patch =
          existingContent === null
            ? buildCreateFilePatch(relativePath, createContent)
            : buildReplacementPatch(relativePath, existingContent, createContent);
        responseMeta.created = existingContent === null;
        responseMeta.overwrite = overwrite;
      } else {
        let original = "";
        let fileExists = true;
        try {
          original = await invoke<string>("read_workspace_file", {
            workspacePath: safeWorkspace,
            relativePath
          });
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
              errorMessage: message
            };
          }
        }
        if (!patch && fileExists) {
        let nextContent = original;

        if (operation === "replace") {
          if (startLine) {
            const replacement = asString(args.content, asString(args.replace));
            nextContent = replaceByLineRange(original, startLine, endLine ?? startLine, replacement);
            responseMeta.selection_mode = "line_range";
          } else {
            const search = asString(args.search);
            const replace = asString(args.replace);
            if (!search) {
              const message = "replace 操作要求 search 非空，或提供 start_line/end_line。若要创建新文件，请改用 operation='create' 并提供 content 参数";
              return {
                content: JSON.stringify({ error: message }),
                success: false,
                errorCategory: "validation",
                errorMessage: message
              };
            }
            const hits = countOccurrences(original, search);
            if (hits < 1) {
              const message = `search 片段未找到: ${relativePath}`;
              return {
                content: JSON.stringify({ error: message }),
                success: false,
                errorCategory: "validation",
                errorMessage: message
              };
            }
            if (!applyAll && hits > 1) {
              const message = `search 片段出现多次（${hits} 次）；请提供更精确片段或设置 apply_all=true`;
              return {
                content: JSON.stringify({ error: message }),
                success: false,
                errorCategory: "validation",
                errorMessage: message
              };
            }

            nextContent = applyAll
              ? original.split(search).join(replace)
              : original.replace(search, replace);
            responseMeta.matched = hits;
          }
        } else if (operation === "insert") {
          const insertContent = asString(args.content, asString(args.replace));
          if (!insertContent) {
            const message = "insert 操作要求 content 非空";
            return {
              content: JSON.stringify({ error: message }),
              success: false,
              errorCategory: "validation",
              errorMessage: message
            };
          }
          if (line) {
            nextContent = insertByLine(original, line, insertContent, insertPosition);
            responseMeta.selection_mode = "line_anchor";
            responseMeta.position = insertPosition;
          } else {
            const anchor = asString(args.anchor, asString(args.search));
            if (!anchor) {
              const message = "insert 操作要求 anchor 非空，或提供 line";
              return {
                content: JSON.stringify({ error: message }),
                success: false,
                errorCategory: "validation",
                errorMessage: message
              };
            }
            const hits = countOccurrences(original, anchor);
            if (hits < 1) {
              const message = `anchor 片段未找到: ${relativePath}`;
              return {
                content: JSON.stringify({ error: message }),
                success: false,
                errorCategory: "validation",
                errorMessage: message
              };
            }
            if (!applyAll && hits > 1) {
              const message = `anchor 片段出现多次（${hits} 次）；请提供更精确片段或设置 apply_all=true`;
              return {
                content: JSON.stringify({ error: message }),
                success: false,
                errorCategory: "validation",
                errorMessage: message
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
            nextContent = replaceByLineRange(original, startLine, endLine ?? startLine, "");
            responseMeta.selection_mode = "line_range";
          } else {
            const search = asString(args.search, asString(args.anchor));
          if (!search) {
            const message =
              "delete 操作要求 search 非空，或提供 start_line/end_line。若目标是删除整个文件，请改用 propose_run_command 执行 rm <relative_path>。";
            return {
              content: JSON.stringify({ error: message }),
              success: false,
              errorCategory: "validation",
                errorMessage: message
              };
            }
            const hits = countOccurrences(original, search);
            if (hits < 1) {
              const message = `search 片段未找到: ${relativePath}`;
              return {
                content: JSON.stringify({ error: message }),
                success: false,
                errorCategory: "validation",
                errorMessage: message
              };
            }
            if (!applyAll && hits > 1) {
              const message = `search 片段出现多次（${hits} 次）；请提供更精确片段或设置 apply_all=true`;
              return {
                content: JSON.stringify({ error: message }),
                success: false,
                errorCategory: "validation",
                errorMessage: message
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
            errorMessage: message
          };
        }

        patch = buildReplacementPatch(relativePath, original, nextContent);
        } // end if (!patch && fileExists)
      }

      const preflight = await invoke<PatchApplyResult>("check_workspace_patch", {
        workspacePath: safeWorkspace,
        patch
      });
      if (!preflight.success) {
        const message = `Patch 预检失败: ${preflight.message}`;
        return {
          content: JSON.stringify({
            error: message,
            files: preflight.files
          }),
          success: false,
          errorCategory: "validation",
          errorMessage: message
        };
      }

      const action: ActionProposal = {
        id: createActionId("gate-a-apply-patch"),
        type: "apply_patch",
        description: asString(
          args.description,
          `Apply structured edit for ${relativePath} (Gate A)`
        ),
        gateRequired: true,
        status: "pending",
        executed: false,
        payload: {
          patch
        }
      };
      return {
        content: JSON.stringify({
          ok: true,
          action_type: "apply_patch",
          action_id: action.id,
          patch_length: patch.length,
          files: preflight.files,
          ...responseMeta
        }),
        success: true,
        proposedAction: action
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
          errorMessage: message
        };
      }
      const timeout = Math.max(1000, Math.min(600000, asNumber(args.timeout_ms, 120000)));
      if (timeout < 1000 || timeout > 600000) {
        const message = "timeout_ms 必须在 1000-600000 之间";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message
        };
      }
      const action: ActionProposal = {
        id: createActionId("gate-shell"),
        type: "shell",
        description: asString(args.description, "Execute shell command (Gate)"),
        gateRequired: true,
        status: "pending",
        executed: false,
        payload: {
          shell,
          timeoutMs: timeout
        }
      };
      return {
        content: JSON.stringify({
          ok: true,
          action_type: "shell",
          action_id: action.id,
          shell
        }),
        success: true,
        proposedAction: action
      };
    }

    return {
      content: JSON.stringify({ error: `未知工具: ${call.function.name}` }),
      success: false,
      errorCategory: "tool_not_found",
      errorMessage: `未知工具: ${call.function.name}`
    };
  } catch (error) {
    const message = String(error || "Unknown error");
    return {
      content: JSON.stringify({ error: message }),
      success: false,
      errorCategory: classifyToolError(message),
      errorMessage: message
    };
  }
}

async function executeToolCallWithRetry(
  call: ToolCallRecord,
  workspacePath: string
): Promise<{
  result: ToolExecutionResult;
  trace: ToolExecutionTrace;
}> {
  const startedAt = nowIso();
  let attempts = 0;
  let lastResult: ToolExecutionResult = {
    content: JSON.stringify({ error: "工具调用未执行" }),
    success: false,
    errorCategory: "unknown",
    errorMessage: "工具调用未执行"
  };

  while (attempts < MAX_TOOL_RETRY) {
    attempts += 1;
    const current = await executeToolCall(call, workspacePath);
    const success = current.success !== false;
    const errorCategory = current.errorCategory ?? (success ? undefined : "unknown");
    const errorMessage = current.errorMessage ?? (success ? undefined : "工具调用失败");
    lastResult = {
      ...current,
      success,
      errorCategory,
      errorMessage
    };

    if (success) {
      return {
        result: lastResult,
        trace: {
          callId: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
          startedAt,
          finishedAt: nowIso(),
          attempts,
          status: "success",
          retried: attempts > 1,
          resultPreview: resultPreview(current.content)
        }
      };
    }

    if (!shouldRetryToolCall(errorCategory ?? "unknown")) {
      break;
    }
  }

  return {
    result: lastResult,
    trace: {
      callId: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
      startedAt,
      finishedAt: nowIso(),
      attempts,
      status: "failed",
      retried: attempts > 1,
      errorCategory: lastResult.errorCategory,
      errorMessage: lastResult.errorMessage,
      resultPreview: resultPreview(lastResult.content)
    }
  };
}

async function requestToolCompletion(
  messages: LiteLLMMessage[],
  settings: AppSettings,
  activeTools: LiteLLMToolDefinition[],
  signal?: AbortSignal
): Promise<{
  assistantMessage: LiteLLMMessage;
  toolCalls: ToolCallRecord[];
  requestRecord: RequestRecord;
}> {
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }

  const body = createLiteLLMRequestBody(messages, settings, {
    stream: false,
    temperature: 0.1,
    tools: activeTools,
    toolChoice: "auto"
  });

  const response = await postLiteLLMChatCompletions(settings, body);
  if (response.status < 200 || response.status >= 300) {
    const detail = parseErrorMessage(response.body, response.status);
    throw new Error(`服务员响应失败: ${detail}`);
  }

  const payload = parseCompletionPayload(response.body);
  const requestId =
    typeof payload.id === "string" && payload.id.trim() ? payload.id : createRequestId("chat");

  const firstChoice = payload.choices?.[0];
  const rawMessage = firstChoice?.message;
  if (!rawMessage) {
    throw new Error("模型响应缺少 message。");
  }

  const toolCalls = parseToolCalls(rawMessage.tool_calls);
  const assistantMessage: LiteLLMMessage = {
    role: "assistant",
    content: normalizeMessageContent(rawMessage.content),
    tool_calls: toolCalls.length ? toolCalls : undefined
  };

  return {
    assistantMessage,
    toolCalls,
    requestRecord: {
      requestId,
      inputLength: inputLengthOf(messages),
      outputLength: response.body.length
    }
  };
}

async function runNativeToolCallingLoop(
  prompt: string,
  settings: AppSettings,
  phase: PlanningSessionPhase,
  conversationHistory: LiteLLMMessage[],
  internalSystemNote?: string,
  signal?: AbortSignal,
  onAssistantChunk?: (chunk: string) => void
): Promise<{
  assistantReply: string;
  requestRecords: RequestRecord[];
  proposedActions: ActionProposal[];
  toolTrace: ToolExecutionTrace[];
}> {
  const routingPolicy = inferToolRoutingPolicy(prompt, phase);
  const activeTools = selectToolDefinitions(routingPolicy.toolNames);
  const shellAvailable = routingPolicy.toolNames.includes("propose_shell");
  const patchRepairInstruction =
    routingPolicy.mode === "explicit_patch"
      ? "请读取必要文件片段后，重新调用 propose_apply_patch。"
      : "请读取必要文件片段后，重新调用 propose_file_edit。";
  const createPathRepairInstruction = shellAvailable
    ? "若目标是新建文件，请调用 propose_file_edit 并设置 operation='create'；若目录不存在，可先调用 propose_shell 执行 mkdir -p <目录>。"
    : "若目标是新建文件，请调用 propose_file_edit 并设置 operation='create'；并优先选择已存在目录下的 relative_path。";
  const runtimeContext = createRuntimeContextPrompt(settings, routingPolicy);
  const requestedArtifactCount =
    phase === "default" && routingPolicy.mode !== "read_only"
      ? estimateRequestedArtifactCount(prompt)
      : 0;
  const messages: LiteLLMMessage[] = [
    { role: "system", content: ASSISTANT_SYSTEM_PROMPT },
    { role: "system", content: runtimeContext },
    ...(internalSystemNote?.trim()
      ? [{ role: "system" as const, content: internalSystemNote.trim() }]
      : []),
    ...conversationHistory,
    { role: "user", content: prompt }
  ];

  const requestRecords: RequestRecord[] = [];
  const proposedActions: ActionProposal[] = [];
  const toolTrace: ToolExecutionTrace[] = [];
  let patchRepairRounds = 0;
  let createHintRepairRounds = 0;
  let multiArtifactReminderRounds = 0;

  for (let turn = 0; turn < MAX_TOOL_LOOP_TURNS; turn += 1) {
    const completion = await requestToolCompletion(messages, settings, activeTools, signal);
    requestRecords.push(completion.requestRecord);
    messages.push(completion.assistantMessage);

    if (!completion.toolCalls.length) {
      const finalText = completion.assistantMessage.content.trim();
      onAssistantChunk?.(finalText);
      return {
        assistantReply: finalText,
        requestRecords,
        proposedActions,
        toolTrace
      };
    }

    let patchPreflightFailure: string | null = null;
    let createPathUsageFailure: string | null = null;
    for (const toolCall of completion.toolCalls) {
      const { result: toolResult, trace } = await executeToolCallWithRetry(
        toolCall,
        settings.workspacePath
      );
      toolTrace.push(trace);
      if (
        toolResult.success === false &&
        toolResult.errorCategory === "validation" &&
        (toolCall.function.name === "propose_apply_patch" ||
          toolCall.function.name === "propose_file_edit") &&
        (toolResult.errorMessage ?? "").includes("Patch 预检失败")
      ) {
        patchPreflightFailure = toolResult.errorMessage ?? "Patch 预检失败";
      }
      if (
        toolResult.success === false &&
        toolResult.errorCategory === "validation" &&
        toolCall.function.name === "propose_file_edit" &&
        ((toolResult.errorMessage ?? "").toLowerCase().includes("invalid target path") ||
          (toolResult.errorMessage ?? "").toLowerCase().includes("no such file or directory"))
      ) {
        createPathUsageFailure = toolResult.errorMessage ?? "目标路径不存在";
      }
      if (toolResult.proposedAction) {
        proposedActions.push(toolResult.proposedAction);
      }
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        name: toolCall.function.name,
        content: toolResult.content
      });
    }

    if (
      !proposedActions.length &&
      patchPreflightFailure &&
      patchRepairRounds < MAX_PATCH_REPAIR_ROUNDS
    ) {
      patchRepairRounds += 1;
      messages.push({
        role: "system",
        content: [
          "系统提示：上一轮 patch 预检失败。",
          `错误信息：${patchPreflightFailure}`,
          patchRepairInstruction,
          "仅允许一次自动修复重试，并保持最小改动。"
        ].join("\n")
      });
      continue;
    }

    if (
      !proposedActions.length &&
      createPathUsageFailure &&
      createHintRepairRounds < MAX_CREATE_HINT_REPAIR_ROUNDS
    ) {
      createHintRepairRounds += 1;
      messages.push({
        role: "system",
        content: [
          "系统提示：检测到文件创建路径问题。",
          `错误信息：${createPathUsageFailure}`,
          createPathRepairInstruction
        ].join("\n")
      });
      continue;
    }

    if (requestedArtifactCount > 1) {
      const plannedArtifacts = countPlannedArtifacts(proposedActions);
      if (
        plannedArtifacts > 0 &&
        plannedArtifacts < requestedArtifactCount &&
        multiArtifactReminderRounds < MAX_MULTI_ARTIFACT_REMINDER_ROUNDS
      ) {
        multiArtifactReminderRounds += 1;
        messages.push({
          role: "system",
          content: [
            "系统提示：用户请求包含多个交付物。",
            `当前已提出 ${plannedArtifacts} 个交付物相关动作，目标至少 ${requestedArtifactCount} 个。`,
            "请继续提出剩余缺失交付物的审批动作；不要重复已有动作。",
            "仅在所有请求交付物都已覆盖，或确实无法继续时，才停止工具调用。"
          ].join("\n")
        });
        continue;
      }
    }

    if (proposedActions.length > 0) {
      return {
        assistantReply: completion.assistantMessage.content.trim(),
        requestRecords,
        proposedActions,
        toolTrace
      };
    }
  }

  return {
    assistantReply: "已达到工具调用轮次上限，请缩小任务范围后重试。",
    requestRecords,
    proposedActions,
    toolTrace
  };
}

function sanitizeStepsFromPrompt(prompt: string): PlanStep[] {
  const normalized = prompt.trim() || "实现用户提出的功能";
  return [
    {
      id: "step-plan",
      owner: "planner",
      summary: `分析需求并拆解执行步骤: ${normalized}`
    },
    {
      id: "step-implement",
      owner: "coder",
      summary: "基于任务生成实现或回答"
    },
    {
      id: "step-verify",
      owner: "tester",
      summary: "补充验证建议并总结风险"
    }
  ];
}

function buildProposedActions(fromTools: ActionProposal[]): ActionProposal[] {
  const uniqueActions: ActionProposal[] = [];
  const seen = new Set<string>();

  for (const action of fromTools) {
    const validationError = validateProposedAction(action);
    if (validationError) {
      continue;
    }

    const fingerprint = actionFingerprint(action);
    if (seen.has(fingerprint)) {
      continue;
    }
    seen.add(fingerprint);
    uniqueActions.push(action);
  }

  return uniqueActions;
}

function initializePlan(
  prompt: string,
  settings: AppSettings,
  proposedActions: ActionProposal[]
): OrchestrationPlan {
  const steps = sanitizeStepsFromPrompt(prompt);
  return {
    state: proposedActions.length ? "human_review" : "done",
    prompt: prompt.trim() || "实现用户提出的功能",
    steps,
    proposedActions,
    workspacePath: settings.workspacePath.trim()
  };
}

function hasExplicitGitIntent(prompt: string): boolean {
  const corpus = prompt.toLowerCase();
  return (
    corpus.includes("git") ||
    corpus.includes("commit") ||
    corpus.includes("branch") ||
    corpus.includes("checkout") ||
    corpus.includes("提交") ||
    corpus.includes("分支") ||
    corpus.includes("暂存")
  );
}

function actionFingerprint(action: ActionProposal): string {
  if (action.type === "apply_patch") {
    return `${action.type}:${action.payload.patch.trim()}`;
  }
  // action.type === "shell"
  return `${action.type}:${action.payload.shell.trim()}:${action.payload.timeoutMs}`;
}

function validateProposedAction(action: ActionProposal): string | null {
  if (action.type === "apply_patch") {
    if (!action.payload.patch.trim()) {
      return "patch 不能为空";
    }
    return null;
  }

  if (action.type === "shell") {
    if (!action.payload.shell.trim()) {
      return "shell 命令不能为空";
    }
    if (action.payload.timeoutMs < 1000 || action.payload.timeoutMs > 600000) {
      return "timeout 超出范围";
    }
    return null;
  }

  return null;
}

function createRuntimeContextPrompt(settings: AppSettings, routingPolicy: ToolRoutingPolicy): string {
  const workspacePath = settings.workspacePath.trim();
  const workspaceLine = workspacePath
    ? `当前工作区: ${workspacePath}`
    : "当前工作区: 未选择";
  const agentLines = DEFAULT_AGENTS.map(
    (agent) =>
      `- ${agent.role}: tools=[${agent.tools.join(", ")}], sensitiveActionAllowed=${agent.sensitiveActionAllowed}`
  );

  return [
    "运行时上下文：",
    workspaceLine,
    `本轮工具路由模式: ${routingPolicy.mode}`,
    `路由原因: ${routingPolicy.reason}`,
    `本轮可用工具: [${routingPolicy.toolNames.join(", ")}]`,
    routingPolicy.mode === "summary_only"
      ? "当前阶段只允许基于系统已知结果做总结，禁止提出新的审批动作或重复声明能力限制。"
      : "当前阶段可按需读取事实或提出待审批动作。",
    "可用角色与能力：",
    ...agentLines,
    "Guardrails: 默认只读；未经审批不得执行写盘/命令/git 写操作。",
    "如需文件系统信息，必须通过已定义工具调用，不得臆测。"
  ].join("\n");
}

function containsCapabilityDenial(text: string): boolean {
  const corpus = text.toLowerCase();
  const hints = [
    "只读",
    "read-only",
    "无法执行文件创建",
    "当前工具路由模式为只读",
    "仅支持 [list_files, read_file, git_status, git_diff]"
  ];
  return hints.some((hint) => corpus.includes(hint.toLowerCase()));
}

function reconcileAssistantReply(params: {
  assistantReply: string;
  phase: PlanningSessionPhase;
  proposedActions: ActionProposal[];
  toolTrace: ToolExecutionTrace[];
}): string {
  const { assistantReply, phase, proposedActions, toolTrace } = params;
  const normalized = assistantReply.trim();

  if (!normalized) {
    if (proposedActions.length > 0) {
      return "已生成待审批动作，请查看下方审批卡片。";
    }
    if (phase === "post_action_summary") {
      return "审批动作已处理完毕，结果已同步到上方记录。";
    }
    return normalized;
  }

  if (!containsCapabilityDenial(normalized)) {
    return normalized;
  }

  const hasSuccessfulToolCall = toolTrace.some((trace) => trace.status === "success");
  if (!hasSuccessfulToolCall && phase !== "post_action_summary") {
    return normalized;
  }

  if (proposedActions.length > 0) {
    return "已生成待审批动作，请查看下方审批卡片。";
  }

  if (phase === "post_action_summary") {
    return "审批动作已处理完毕，结果已同步到上方记录。";
  }

  return normalized;
}

function assertLocalOnlyPolicy(settings: AppSettings): void {
  if (settings.allowCloudModels) {
    return;
  }

  if (isLocalProvider(settings.provider)) {
    return;
  }

  throw new LocalOnlyPolicyError("Local-only 已开启，请切换到本地 Provider（如 Ollama）后再发起请求。");
}

export async function runPlanningSession(
  input: RunPlanningSessionInput
): Promise<PlanningSessionResult> {
  const normalizedPrompt = input.prompt.trim();
  if (!normalizedPrompt) {
    throw new Error("请输入任务描述后再发送。");
  }

  assertLocalOnlyPolicy(input.settings);
  const phase = input.phase ?? "default";
  const maxTokens = input.settings.maxContextTokens || 128000;
  const historyMessages = sanitizeConversationHistory(input.conversationHistory, maxTokens);

  try {
    const loopResult = await runNativeToolCallingLoop(
      normalizedPrompt,
      input.settings,
      phase,
      historyMessages,
      input.internalSystemNote,
      input.signal,
      input.onAssistantChunk
    );

    for (const record of loopResult.requestRecords) {
      recordLLMAudit({
        requestId: record.requestId,
        provider: input.settings.provider,
        model: input.settings.model,
        timestamp: new Date().toISOString(),
        inputLength: record.inputLength,
        outputLength: record.outputLength
      });
    }

    const proposedActions = buildProposedActions(loopResult.proposedActions);
    const plan = initializePlan(normalizedPrompt, input.settings, proposedActions);
    const assistantReply = reconcileAssistantReply({
      assistantReply: loopResult.assistantReply,
      phase,
      proposedActions,
      toolTrace: loopResult.toolTrace
    });

    return {
      assistantReply,
      plan,
      toolTrace: loopResult.toolTrace
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    console.error("runPlanningSession failed:", error);
    const errorMessage = String(error || "Unknown error");
    const fallbackPlan = initializePlan(normalizedPrompt, input.settings, []);
    return {
      assistantReply: `服务员暂时无法完成本轮工具调用，请稍后重试。\n\n**错误详情**：\n\`\`\`\n${errorMessage}\n\`\`\``,
      plan: fallbackPlan,
      toolTrace: []
    };
  }
}
