import type { ChatMessageRecord } from "../../../lib/chatHistoryStore";
import type { OrchestrationPlan } from "../../../orchestrator/types";
import type { ConversationTopbarAction } from "./ConversationTopbar";
import type { LiveToolCall } from "./types";

export interface ConversationTopbarTarget {
  anchor:
    | "tools"
    | "approval"
    | "ask_user"
    | "restore"
    | "blocked_output"
    | "context"
    | "plan";
  messageId?: string;
  actionId?: string;
}

function plansLooselyEqual(a: OrchestrationPlan, b: OrchestrationPlan): boolean {
  if (a === b) return true;
  if (a.state !== b.state || a.prompt !== b.prompt || a.steps.length !== b.steps.length) {
    return false;
  }
  return a.steps.every((s, i) => s.id === b.steps[i]!.id);
}

function findLatestPlanMessageId(
  messages: ChatMessageRecord[],
  activePlan: OrchestrationPlan,
): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.role !== "assistant" || !m.plan) continue;
    if (plansLooselyEqual(m.plan, activePlan)) return m.id;
  }
  return null;
}

function resolveToolsTarget(
  messages: ChatMessageRecord[],
  liveToolCalls: LiveToolCall[],
): ConversationTopbarTarget | null {
  if (liveToolCalls.length === 0) return null;
  for (let c = liveToolCalls.length - 1; c >= 0; c -= 1) {
    const call = liveToolCalls[c]!;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i]!;
      if (m.role !== "assistant" || !m.toolTrace?.length) continue;
      if (m.toolTrace.some((t) => t.callId === call.callId)) {
        return { anchor: "tools", messageId: m.id };
      }
    }
  }
  return null;
}

function findMessageIdForPlanAndAction(
  messages: ChatMessageRecord[],
  plan: OrchestrationPlan,
  actionId: string,
): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.role !== "assistant" || !m.plan) continue;
    if (!plansLooselyEqual(m.plan, plan)) continue;
    if (m.plan.proposedActions.some((a) => a.id === actionId)) return m.id;
  }
  return null;
}

function resolveApprovalTarget(
  messages: ChatMessageRecord[],
  activePlan: OrchestrationPlan | null,
): ConversationTopbarTarget | null {
  if (!activePlan || activePlan.state !== "human_review") return null;
  const pending = activePlan.proposedActions.find((a) => a.status === "pending");
  if (!pending) return null;
  const messageId = findMessageIdForPlanAndAction(messages, activePlan, pending.id);
  return {
    anchor: "approval",
    actionId: pending.id,
    ...(messageId ? { messageId } : {}),
  };
}

function resolveProgressTarget(
  messages: ChatMessageRecord[],
  activePlan: OrchestrationPlan | null,
): ConversationTopbarTarget | null {
  if (activePlan) {
    const planMsg = findLatestPlanMessageId(messages, activePlan);
    if (planMsg) return { anchor: "plan", messageId: planMsg };
  }
  return null;
}

function resolveBlockedOutputTarget(input: {
  messages: ChatMessageRecord[];
  activePlan: OrchestrationPlan | null;
}): ConversationTopbarTarget | null {
  const { messages, activePlan } = input;

  const failedStep = activePlan?.steps.find(
    (s) => s.status === "failed" || s.status === "blocked",
  );
  if (failedStep && activePlan) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i]!;
      if (m.role !== "assistant" || !m.plan) continue;
      if (!plansLooselyEqual(m.plan, activePlan)) continue;
      return {
        anchor: "blocked_output",
        messageId: m.id,
      };
    }
    return { anchor: "blocked_output" };
  }

  const failedAction = activePlan?.proposedActions.find((a) => a.status === "failed");
  if (failedAction && activePlan) {
    const messageId = findMessageIdForPlanAndAction(messages, activePlan, failedAction.id);
    return {
      anchor: "blocked_output",
      actionId: failedAction.id,
      ...(messageId ? { messageId } : {}),
    };
  }

  const failedTraceMessage = (() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i]!;
      if (m.role !== "assistant" || !m.toolTrace?.length) continue;
      if (m.toolTrace.some((t) => t.status === "failed")) return m;
    }
    return null;
  })();
  if (failedTraceMessage) {
    return { anchor: "blocked_output", messageId: failedTraceMessage.id };
  }

  return null;
}

export function resolveConversationTopbarTarget(input: {
  action: ConversationTopbarAction;
  messages: ChatMessageRecord[];
  activePlan: OrchestrationPlan | null;
  liveToolCalls: LiveToolCall[];
  hasAskUserPending: boolean;
  askUserAnchorMessageId?: string | null;
  hasRestoreNotice: boolean;
  restoreAnchorMessageId?: string | null;
  sessionNote: string;
}): ConversationTopbarTarget | null {
  const {
    action,
    messages,
    activePlan,
    liveToolCalls,
    hasAskUserPending,
    askUserAnchorMessageId,
    hasRestoreNotice,
    restoreAnchorMessageId,
  } = input;

  switch (action) {
    case "tools":
      return resolveToolsTarget(messages, liveToolCalls);
    case "approval":
      return resolveApprovalTarget(messages, activePlan);
    case "progress":
      return resolveProgressTarget(messages, activePlan);
    case "context":
      return { anchor: "context" };
    case "ask_user": {
      if (!hasAskUserPending) return null;
      const mid = askUserAnchorMessageId?.trim();
      if (!mid) return null;
      return { anchor: "ask_user", messageId: mid };
    }
    case "restore": {
      if (!hasRestoreNotice) return null;
      const mid = restoreAnchorMessageId?.trim();
      if (!mid) return null;
      return { anchor: "restore", messageId: mid };
    }
    case "blocked_output":
      return resolveBlockedOutputTarget({ messages, activePlan });
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}