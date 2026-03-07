import type { ChatMessageRecord } from "../../../lib/chatHistoryStore";
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
  diagnostics: "诊断检查",
  fetch: "获取网页",
};

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
      content: record.content.trim(),
      ...(record.tool_calls ? { tool_calls: record.tool_calls } : {}),
      ...(record.tool_call_id ? { tool_call_id: record.tool_call_id } : {}),
      ...(record.name ? { name: record.name } : {}),
    }));
}

export function formatToolName(name: string): string {
  return TOOL_NAME_LABELS[name] || name;
}
