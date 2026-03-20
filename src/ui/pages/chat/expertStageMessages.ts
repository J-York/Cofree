import type { ChatMessageRecord } from "../../../lib/chatHistoryStore";
import type { SubAgentProgressEvent } from "../../../orchestrator/types";

function newExpertStageMessageId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? `expert-stage-${crypto.randomUUID()}`
    : `expert-stage-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Inserts an expert-panel stage summary into the visible message list.
 * When the last message is an assistant turn, the summary is placed immediately before it
 * (typical streaming case). Otherwise the summary is appended so it is not dropped.
 */
export function insertExpertStageSummaryMessages(
  prev: ChatMessageRecord[],
  event: SubAgentProgressEvent & { kind: "stage_complete" },
): ChatMessageRecord[] {
  const teamPrefix = event.teamId ? `[${event.teamId}] ` : "";
  const speakerLabel = `${teamPrefix}${event.stageLabel} · ${event.agentRole}`;
  const expertMsg: ChatMessageRecord = {
    id: newExpertStageMessageId(),
    role: "assistant",
    content:
      `### 专家组阶段小结 · ${event.stageStatus}\n\n` +
      event.summary,
    createdAt: new Date().toISOString(),
    plan: null,
    assistantSpeaker: {
      id: `${event.teamId ?? "task"}:${event.stageLabel}:${event.agentRole}`,
      label: speakerLabel,
    },
  };

  if (prev.length < 1) {
    return [expertMsg];
  }

  const last = prev[prev.length - 1];
  if (last.role === "assistant") {
    return [...prev.slice(0, -1), expertMsg, last];
  }

  return [...prev, expertMsg];
}
