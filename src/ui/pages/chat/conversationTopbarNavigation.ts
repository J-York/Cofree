import type { ChatMessageRecord } from "../../../lib/chatHistoryStore";
import type { OrchestrationPlan, SubAgentProgressEvent } from "../../../orchestrator/types";
import type { ConversationTopbarAction } from "./ConversationTopbar";
import type { LiveToolCall, SubAgentStatusItem } from "./types";

export interface ConversationTopbarTarget {
  anchor:
    | "tools"
    | "parallel"
    | "approval"
    | "ask_user"
    | "restore"
    | "blocked_output"
    | "context"
    | "plan"
    | "stage_summary";
  messageId?: string;
  actionId?: string;
  stageLabel?: string;
}

function hasTrustworthyStageIndexPair(event: SubAgentProgressEvent): boolean {
  const total = event.totalStages;
  const cur = event.currentStageIndex;
  return (
    typeof total === "number" &&
    total > 0 &&
    typeof cur === "number" &&
    cur >= 1 &&
    cur <= total
  );
}

function hasOrchestrationStatusSignal(event: SubAgentProgressEvent): boolean {
  if (event.kind === "stage_complete" || event.kind === "team_checkpoint") {
    return true;
  }
  if (event.teamId?.trim()) {
    return true;
  }
  if (event.stageLabel?.trim()) {
    return true;
  }
  return hasTrustworthyStageIndexPair(event);
}

function plansLooselyEqual(a: OrchestrationPlan, b: OrchestrationPlan): boolean {
  if (a === b) return true;
  if (a.state !== b.state || a.prompt !== b.prompt || a.steps.length !== b.steps.length) {
    return false;
  }
  return a.steps.every((s, i) => s.id === b.steps[i]!.id);
}

function expertSpeakerIdFromStageMeta(ev: {
  teamId?: string;
  stageLabel?: string;
  agentRole?: string;
}): string {
  return `${ev.teamId ?? "task"}:${ev.stageLabel ?? "unknown"}:${ev.agentRole ?? "agent"}`;
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

function summaryMatchesStageLabel(message: ChatMessageRecord, stageLabel: string): boolean {
  if (message.role !== "assistant" || !message.assistantSpeaker) {
    return false;
  }
  const normalized = stageLabel.trim();
  if (!normalized) {
    return false;
  }
  return (
    message.assistantSpeaker.id.includes(`:${normalized}:`) ||
    message.assistantSpeaker.label.includes(normalized)
  );
}

function findLatestStageSummaryMessageId(
  messages: ChatMessageRecord[],
  stageLabel?: string | null,
): string | null {
  const normalizedStageLabel = stageLabel?.trim();
  if (normalizedStageLabel) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i]!;
      if (summaryMatchesStageLabel(m, normalizedStageLabel)) {
        return m.id;
      }
    }
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.role === "assistant" && m.assistantSpeaker) return m.id;
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

function pickLatestOrchestrationSubAgentItem(
  items: SubAgentStatusItem[],
): SubAgentStatusItem | null {
  const trusted = items.filter((item) => hasOrchestrationStatusSignal(item.lastEvent));
  if (trusted.length === 0) return null;
  return [...trusted].sort((a, b) => b.updatedAt - a.updatedAt)[0]!;
}

function findParallelMessageId(
  messages: ChatMessageRecord[],
  item: SubAgentStatusItem,
): string | null {
  const ev = item.lastEvent;
  const stageLabel = ev.stageLabel?.trim();
  const agentRole = ev.agentRole?.trim();
  if (stageLabel && agentRole) {
    const sid = expertSpeakerIdFromStageMeta({
      teamId: ev.teamId,
      stageLabel,
      agentRole,
    });
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i]!;
      if (m.role === "assistant" && m.assistantSpeaker?.id === sid) return m.id;
    }
  }
  if (stageLabel) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i]!;
      if (m.role !== "assistant" || !m.assistantSpeaker) continue;
      if (m.assistantSpeaker.label.includes(stageLabel)) return m.id;
    }
  }
  return null;
}

function resolveParallelTarget(
  messages: ChatMessageRecord[],
  subAgentStatus: SubAgentStatusItem[],
): ConversationTopbarTarget | null {
  const latest = pickLatestOrchestrationSubAgentItem(subAgentStatus);
  if (!latest) return null;
  const messageId = findParallelMessageId(messages, latest);
  if (!messageId) return null;
  return { anchor: "parallel", messageId };
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
  subAgentStatus: SubAgentStatusItem[],
): ConversationTopbarTarget | null {
  if (activePlan) {
    const planMsg = findLatestPlanMessageId(messages, activePlan);
    if (planMsg) return { anchor: "plan", messageId: planMsg };
  }
  const currentStageLabel = pickLatestOrchestrationSubAgentItem(subAgentStatus)?.lastEvent.stageLabel;
  const stageId = findLatestStageSummaryMessageId(messages, currentStageLabel);
  if (stageId) return { anchor: "stage_summary", messageId: stageId };
  return null;
}

function pickLatestStageCompleteEvent(
  items: SubAgentStatusItem[],
): (SubAgentProgressEvent & { kind: "stage_complete" }) | null {
  const matches = items.filter(
    (item): item is SubAgentStatusItem & { lastEvent: SubAgentProgressEvent & { kind: "stage_complete" } } =>
      item.lastEvent.kind === "stage_complete",
  );
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.updatedAt - a.updatedAt);
  return matches[0]!.lastEvent;
}

function findExpertMessageIdForStageComplete(
  messages: ChatMessageRecord[],
  ev: SubAgentProgressEvent & { kind: "stage_complete" },
): string | null {
  const sid = expertSpeakerIdFromStageMeta({
    teamId: ev.teamId,
    stageLabel: ev.stageLabel,
    agentRole: ev.agentRole,
  });
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.role === "assistant" && m.assistantSpeaker?.id === sid) return m.id;
  }
  return null;
}

function resolveBlockedOutputTarget(input: {
  messages: ChatMessageRecord[];
  activePlan: OrchestrationPlan | null;
  subAgentStatus: SubAgentStatusItem[];
}): ConversationTopbarTarget | null {
  const { messages, activePlan, subAgentStatus } = input;
  const latestStage = pickLatestStageCompleteEvent(subAgentStatus);
  if (
    latestStage &&
    (latestStage.stageStatus === "failed" || latestStage.stageStatus === "blocked")
  ) {
    const messageId = findExpertMessageIdForStageComplete(messages, latestStage);
    return {
      anchor: "blocked_output",
      stageLabel: latestStage.stageLabel,
      ...(messageId ? { messageId } : {}),
    };
  }

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
        stageLabel: failedStep.title,
        messageId: m.id,
      };
    }
    return { anchor: "blocked_output", stageLabel: failedStep.title };
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
  subAgentStatus: SubAgentStatusItem[];
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
    subAgentStatus,
    hasAskUserPending,
    askUserAnchorMessageId,
    hasRestoreNotice,
    restoreAnchorMessageId,
  } = input;

  switch (action) {
    case "tools":
      return resolveToolsTarget(messages, liveToolCalls);
    case "parallel":
      return resolveParallelTarget(messages, subAgentStatus);
    case "approval":
      return resolveApprovalTarget(messages, activePlan);
    case "progress":
      return resolveProgressTarget(messages, activePlan, subAgentStatus);
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
      return resolveBlockedOutputTarget({ messages, activePlan, subAgentStatus });
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}
