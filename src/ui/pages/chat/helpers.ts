import type { ChatMessageRecord } from "../../../lib/chatHistoryStore";
import { formatContextAttachmentManifest } from "../../../lib/contextAttachments";
import type { OrchestrationPlan } from "../../../orchestrator/types";

export interface ConversationHistoryMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ChatMessageRecord["tool_calls"];
  tool_call_id?: string;
  name?: string;
}

const TOOL_NAME_LABELS: Record<string, string> = {
  list_files: "浏览目录",
  read_file: "读取文件",
  git_status: "Git 状态",
  git_diff: "Git 差异",
  grep: "搜索代码",
  glob: "查找文件",
  propose_file_edit: "编辑文件",
  propose_apply_patch: "应用补丁",
  propose_shell: "执行命令",
  task: "子任务",
  update_plan: "更新 Todo",
  diagnostics: "诊断检查",
  fetch: "获取网页",
};

const TERMINAL_STEP_STATUSES = new Set(["completed", "failed", "skipped"]);
const CONTINUATION_PROMPT_PREFIXES = [
  "继续",
  "接着",
  "继续吧",
  "继续做",
  "继续完成",
  "继续处理",
  "继续刚才",
  "继续下去",
  "resume",
  "continue",
  "carry on",
  "keep going",
  "go on",
];

export function createMessageId(role: "user" | "assistant" | "tool"): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return `${role}-${crypto.randomUUID()}`;
  }
  return `${role}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

export function buildToolCallsFromPlan(
  plan: OrchestrationPlan | null,
): ChatMessageRecord["tool_calls"] | undefined {
  if (
    !plan ||
    !Array.isArray(plan.proposedActions) ||
    plan.proposedActions.length === 0
  ) {
    return undefined;
  }

  return plan.proposedActions.map((action) => ({
    id: action.toolCallId || action.id,
    type: "function",
    function: {
      name:
        action.toolName ||
        (action.type === "shell" ? "propose_shell" : "propose_file_edit"),
      arguments: JSON.stringify(action.payload),
    },
  }));
}

export function toConversationHistory(
  records: ChatMessageRecord[],
): ConversationHistoryMessage[] {
  return records
    .filter(
      (record) =>
        record.content.trim() ||
        record.role === "tool" ||
        (record.role === "assistant" &&
          record.tool_calls &&
          record.tool_calls.length > 0),
    )
    .map((record) => ({
      role: record.role,
      content: (() => {
        const content = record.content.trim();
        const manifest = formatContextAttachmentManifest(record.contextAttachments ?? []);
        if (!manifest) {
          return content;
        }
        return content ? `${content}\n\n${manifest}` : manifest;
      })(),
      ...(record.tool_calls ? { tool_calls: record.tool_calls } : {}),
      ...(record.tool_call_id ? { tool_call_id: record.tool_call_id } : {}),
      ...(record.name ? { name: record.name } : {}),
    }));
}

function hasUnfinishedTodoPlan(plan: OrchestrationPlan | null): plan is OrchestrationPlan {
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
    return false;
  }

  return plan.steps.some((step) => !TERMINAL_STEP_STATUSES.has(step.status));
}

function isContinuationLikePrompt(prompt: string): boolean {
  const normalized = prompt.trim();
  if (!normalized) {
    return false;
  }
  const lower = normalized.toLowerCase();
  return CONTINUATION_PROMPT_PREFIXES.some((prefix) =>
    lower.startsWith(prefix.toLowerCase()),
  );
}

export function deriveCarryForwardPlan(params: {
  records: ChatMessageRecord[];
  prompt: string;
  explicitPlan?: OrchestrationPlan | null;
  isContinuation?: boolean;
}): OrchestrationPlan | undefined {
  if (params.explicitPlan) {
    return params.explicitPlan;
  }

  if (!params.isContinuation && !isContinuationLikePrompt(params.prompt)) {
    return undefined;
  }

  const latestPlan = [...params.records]
    .reverse()
    .map((record) => record.plan)
    .find(hasUnfinishedTodoPlan);

  if (!latestPlan) {
    return undefined;
  }

  return {
    ...latestPlan,
    prompt: params.prompt.trim() || latestPlan.prompt,
    proposedActions: [],
    state: latestPlan.steps.some((step) => step.status === "in_progress")
      ? "executing"
      : "planning",
  };
}

export function formatToolName(name: string): string {
  return TOOL_NAME_LABELS[name] || name;
}
