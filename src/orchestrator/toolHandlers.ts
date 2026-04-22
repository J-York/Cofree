/**
 * Per-tool handlers dispatched from `executeToolCall`.
 *
 * Each handler is `(ctx) => Promise<ToolExecutionResult>` so the dispatcher
 * can look one up by `call.function.name` without a giant switch. Shared
 * top-level behavior — workspace validation, JSON.parse of arguments,
 * outer try/catch with error classification — lives in the caller and is
 * intentionally not re-implemented here.
 *
 * Conventions for a handler:
 *   - Validation failures return a structured ToolExecutionResult with
 *     `errorCategory: "validation"` (no throw). The caller will propagate.
 *   - Unexpected Tauri / network failures throw; the caller's try/catch
 *     funnels the message through `classifyToolError`.
 *   - Handlers never mutate the context object.
 */
import { invoke } from "@tauri-apps/api/core";
import { checkShellJob } from "../lib/tauriBridge";
import type { ToolPermissions, AppSettings } from "../lib/settingsStore";
import { findMatchingApprovalRule } from "../lib/approvalRuleStore";
import {
  createAskUserRequest,
  waitForUserResponse,
  type AskUserRequest,
} from "./askUserService";
import {
  resolveShellExecutionMode,
  resolveShellReadyTimeoutMs,
  resolveShellReadyUrl,
  inferBlockUntilMs,
} from "../lib/shellCommand";
import type { ActionProposal } from "./types";
import type { ToolCallRecord } from "./llmToolLoop";
import type { CofreeRcConfig } from "../lib/cofreerc";
import type { WorkingMemory } from "./workingMemory";
import type {
  ToolExecutionResult,
  ToolExecutorDeps,
  TodoPlanStateLike,
} from "./toolExecutor";
import {
  asBoolean,
  asNumber,
  asString,
  countOccurrences,
  normalizeOptionalPositiveInt,
  normalizeRelativePath,
  stripLineNumberPrefixes,
} from "./toolArgParsing";
import {
  buildCreateFilePatch,
  buildReplacementPatch,
  insertByLine,
  replaceByLineRange,
} from "./patchBuilders";
import {
  buildAutoApprovalMeta,
  resolveSensitiveActionAutoApprovalSource,
  type SensitiveWriteAutoExecutionPolicy,
} from "./toolApprovalResolver";
import {
  autoExecutePatchProposal,
  autoExecuteShellProposal,
} from "./toolAutoExecution";

const MAX_LIST_ENTRIES = 120;
const MAX_FILE_PREVIEW_CHARS = 15000;

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

export interface ToolHandlerContext {
  call: ToolCallRecord;
  args: Record<string, unknown>;
  safeWorkspace: string;
  deps: ToolExecutorDeps;
  toolPermissions: ToolPermissions;
  settings?: AppSettings;
  projectConfig?: CofreeRcConfig;
  planState?: TodoPlanStateLike;
  workingMemory?: WorkingMemory;
  signal?: AbortSignal;
  turn?: number;
  sessionId?: string;
  onAskUserRequest?: (request: AskUserRequest) => void;
  autoExecutionPolicy: SensitiveWriteAutoExecutionPolicy;
}

export type ToolHandler = (ctx: ToolHandlerContext) => Promise<ToolExecutionResult>;

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

function resolveIgnorePatterns(projectConfig?: CofreeRcConfig): string[] | null {
  return projectConfig?.ignorePatterns && projectConfig.ignorePatterns.length > 0
    ? projectConfig.ignorePatterns
    : null;
}

const handleListFiles: ToolHandler = async ({ args, safeWorkspace, projectConfig }) => {
  const relativePath = normalizeRelativePath(args.relative_path);
  const ignorePatterns = resolveIgnorePatterns(projectConfig);
  const entries = await invoke<FileEntry[]>("list_workspace_files", {
    workspacePath: safeWorkspace,
    relativePath,
    ignorePatterns,
  });
  return {
    content: JSON.stringify({
      ok: true,
      relative_path: relativePath,
      entry_count: entries.length,
      entries_preview: renderListEntries(entries),
    }),
    success: true,
  };
};

const handleReadFile: ToolHandler = async ({
  args,
  safeWorkspace,
  projectConfig,
  workingMemory,
  turn,
  deps,
}) => {
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
    if (
      existing &&
      existing.lastReadTurn !== undefined &&
      turn - existing.lastReadTurn < 10
    ) {
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
    ignorePatterns: resolveIgnorePatterns(projectConfig),
  });

  const lines = result.content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const numbered = lines
    .map((line, i) => `${result.start_line + i}│${line}`)
    .join("\n");
  const trimmed = deps.smartTruncate(numbered, MAX_FILE_PREVIEW_CHARS);
  const wasTruncated = numbered.length > MAX_FILE_PREVIEW_CHARS;

  return {
    content: JSON.stringify({
      ok: true,
      relative_path: relativePath,
      total_lines: result.total_lines,
      showing_lines: `${result.start_line}-${result.end_line}`,
      content_preview: trimmed,
      truncated: wasTruncated,
      ...(wasTruncated
        ? {
            hint: "内容已裁剪。可使用 start_line/end_line 分段读取，获取完整文件。",
          }
        : {}),
    }),
    success: true,
  };
};

const handleGitStatus: ToolHandler = async ({ safeWorkspace, deps }) => {
  const status = await invoke<string>("git_status_workspace", {
    workspacePath: safeWorkspace,
  });
  return {
    content: JSON.stringify({
      ok: true,
      status_preview: deps.smartTruncate(status, MAX_FILE_PREVIEW_CHARS),
      truncated: status.length > MAX_FILE_PREVIEW_CHARS,
    }),
    success: true,
  };
};

const handleGitDiff: ToolHandler = async ({ args, safeWorkspace, deps }) => {
  const filePath = normalizeRelativePath(args.file_path);
  const diff = await invoke<string>("git_diff_workspace", {
    workspacePath: safeWorkspace,
    filePath: filePath || null,
  });
  return {
    content: JSON.stringify({
      ok: true,
      file_path: filePath || null,
      diff_preview: deps.smartTruncate(diff, MAX_FILE_PREVIEW_CHARS),
      truncated: diff.length > MAX_FILE_PREVIEW_CHARS,
    }),
    success: true,
  };
};

const handleGrep: ToolHandler = async ({ args, safeWorkspace, projectConfig, deps }) => {
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
    ignorePatterns: resolveIgnorePatterns(projectConfig),
  });
  const matchCount = result.matches.length;
  const preview = result.matches
    .slice(0, 30)
    .map((m) => `${m.file}:${m.line}│${m.content}`)
    .join("\n");
  return {
    content: JSON.stringify({
      ok: true,
      pattern,
      include_glob: includeGlob,
      match_count: matchCount,
      truncated: result.truncated,
      matches_preview: deps.smartTruncate(preview, MAX_FILE_PREVIEW_CHARS),
    }),
    success: true,
  };
};

const handleGlob: ToolHandler = async ({ args, safeWorkspace, projectConfig, deps }) => {
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
    ignorePatterns: resolveIgnorePatterns(projectConfig),
  });
  const preview = entries.slice(0, 60).map((e) => `${e.path} (${e.size}B)`).join("\n");
  return {
    content: JSON.stringify({
      ok: true,
      pattern,
      file_count: entries.length,
      files_preview: deps.smartTruncate(preview, MAX_FILE_PREVIEW_CHARS),
    }),
    success: true,
  };
};

const handleUpdatePlan: ToolHandler = async ({ args, planState, deps }) => {
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
        afterStepId: asString(args.after_step_id).trim() || undefined,
        note,
      });
      message = `已新增步骤「${added.title}」`;
      break;
    }
    default:
      message = `不支持的 update_plan operation: ${operation}`;
  }

  const isError =
    message.startsWith("未找到") ||
    message.startsWith("不支持") ||
    message.startsWith("operation=");
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
        status: step.status,
        linkedActionIds: step.linkedActionIds ?? [],
      })),
    }),
    success: !isError,
    errorCategory: isError ? "validation" : undefined,
    errorMessage: isError ? message : undefined,
  };
};

const handleProposeApplyPatch: ToolHandler = async ({
  args,
  call,
  safeWorkspace,
  deps,
  planState,
  toolPermissions,
  autoExecutionPolicy,
}) => {
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
  const preflight = await invoke<PatchApplyResult>("check_workspace_patch", {
    workspacePath: safeWorkspace,
    patch,
  });
  if (!preflight.success) {
    const message = `Patch 预检失败: ${preflight.message}`;
    return {
      content: JSON.stringify({ error: message, files: preflight.files }),
      success: false,
      errorCategory: "validation",
      errorMessage: message,
    };
  }
  if (preflight.files.length > 1) {
    const message = `propose_apply_patch 仅允许单文件 patch；当前 patch 涉及 ${preflight.files.length} 个文件。请改用 propose_file_edit 按文件逐个提交。`;
    return {
      content: JSON.stringify({ error: message, files: preflight.files }),
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
      "Apply generated patch to workspace (Gate A)",
    ),
    gateRequired: true,
    status: "pending",
    executed: false,
    payload: { patch },
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
};

const handleProposeFileEdit: ToolHandler = async ({
  args,
  call,
  safeWorkspace,
  deps,
  planState,
  toolPermissions,
  autoExecutionPolicy,
}) => {
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
  if (line) responseMeta.line = line;
  if (startLine) responseMeta.start_line = startLine;
  if (endLine) responseMeta.end_line = endLine;

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
      const message =
        "create 操作要求 content 非空。operation='create' 必须提供 content 参数，包含要写入的完整文件内容。";
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
        : await buildReplacementPatch(relativePath, existingContent, createContent);
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
      original = original.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    } catch (_readError) {
      fileExists = false;
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
          const replacement = asString(args.content, asString(args.replace));
          nextContent = replaceByLineRange(
            original,
            startLine,
            endLine ?? startLine,
            replacement,
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
        const insertContent = asString(args.content, asString(args.replace));
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
          nextContent = insertByLine(original, line, insertContent, insertPosition);
          responseMeta.selection_mode = "line_anchor";
          responseMeta.position = insertPosition;
        } else {
          const anchor = stripLineNumberPrefixes(
            asString(args.anchor, asString(args.search)),
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
            "",
          );
          responseMeta.selection_mode = "line_range";
        } else {
          const search = stripLineNumberPrefixes(
            asString(args.search, asString(args.anchor)),
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

      patch = await buildReplacementPatch(relativePath, original, nextContent);
    }
  }

  const preflight = await invoke<PatchApplyResult>("check_workspace_patch", {
    workspacePath: safeWorkspace,
    patch,
  });
  if (!preflight.success) {
    const message = `Patch 预检失败: ${preflight.message}`;
    return {
      content: JSON.stringify({ error: message, files: preflight.files }),
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
      `Apply structured edit for ${relativePath} (Gate A)`,
    ),
    gateRequired: true,
    status: "pending",
    executed: false,
    payload: { patch },
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
};

const handleProposeShell: ToolHandler = async ({
  args,
  call,
  safeWorkspace,
  deps,
  planState,
  toolPermissions,
  autoExecutionPolicy,
  signal,
}) => {
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
    Math.min(600000, asNumber(args.timeout_ms, 120000)),
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
};

const handleCheckShellJob: ToolHandler = async ({ args }) => {
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
};

const handleDiagnostics: ToolHandler = async ({ args, safeWorkspace, deps }) => {
  const changedFiles = Array.isArray(args.changed_files)
    ? (args.changed_files as string[]).map((f) => String(f).trim()).filter(Boolean)
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
    changedFiles: changedFiles && changedFiles.length > 0 ? changedFiles : null,
  });

  const errorCount = result.diagnostics.filter((d) => d.severity === "error").length;
  const warningCount = result.diagnostics.filter(
    (d) => d.severity === "warning",
  ).length;
  const diagnosticsPreview = result.diagnostics
    .slice(0, 50)
    .map(
      (d) =>
        `${d.severity.toUpperCase()} ${d.file}:${d.line}:${d.column} ${d.message}`,
    )
    .join("\n");

  return {
    content: JSON.stringify({
      ok: true,
      tool_used: result.tool_used,
      error_count: errorCount,
      warning_count: warningCount,
      total_diagnostics: result.diagnostics.length,
      diagnostics_preview: deps.smartTruncate(diagnosticsPreview, MAX_FILE_PREVIEW_CHARS),
    }),
    success: true,
  };
};

const handleFetch: ToolHandler = async ({ args, settings, deps }) => {
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
      content: JSON.stringify({ ok: false, url: result.url, error: errorMsg }),
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
      content_preview: deps.smartTruncate(result.content, MAX_FILE_PREVIEW_CHARS),
    }),
    success: true,
  };
};

const handleAskUser: ToolHandler = async ({ args, sessionId, onAskUserRequest, signal }) => {
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
  const allowMultiple =
    args.allow_multiple !== undefined ? asBoolean(args.allow_multiple, false) : false;
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
    required,
  );

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
};

export const TOOL_HANDLERS: Record<string, ToolHandler> = {
  list_files: handleListFiles,
  read_file: handleReadFile,
  git_status: handleGitStatus,
  git_diff: handleGitDiff,
  grep: handleGrep,
  glob: handleGlob,
  update_plan: handleUpdatePlan,
  propose_apply_patch: handleProposeApplyPatch,
  propose_file_edit: handleProposeFileEdit,
  propose_shell: handleProposeShell,
  check_shell_job: handleCheckShellJob,
  diagnostics: handleDiagnostics,
  fetch: handleFetch,
  ask_user: handleAskUser,
};
