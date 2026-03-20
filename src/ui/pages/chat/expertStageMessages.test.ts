import { describe, expect, it } from "vitest";
import type { ChatMessageRecord } from "../../../lib/chatHistoryStore";
import { insertExpertStageSummaryMessages } from "./expertStageMessages";

describe("insertExpertStageSummaryMessages", () => {
  it("inserts before the last assistant message when streaming", () => {
    const prev: ChatMessageRecord[] = [
      {
        id: "a1",
        role: "assistant",
        content: "streaming…",
        createdAt: "2026-01-01T00:00:00.000Z",
        plan: null,
      },
    ];
    const next = insertExpertStageSummaryMessages(prev, {
      kind: "stage_complete",
      stageLabel: "plan",
      agentRole: "planner",
      summary: "Done planning",
      stageStatus: "completed",
      teamId: "team-x",
    });
    expect(next).toHaveLength(2);
    expect(next[0].assistantSpeaker?.label).toContain("plan");
    expect(next[0].content).toContain("专家组阶段小结");
    expect(next[1].id).toBe("a1");
  });

  it("appends when last message is not assistant", () => {
    const prev: ChatMessageRecord[] = [
      {
        id: "u1",
        role: "user",
        content: "hi",
        createdAt: "2026-01-01T00:00:00.000Z",
        plan: null,
      },
    ];
    const next = insertExpertStageSummaryMessages(prev, {
      kind: "stage_complete",
      stageLabel: "code",
      agentRole: "coder",
      summary: "Coded",
      stageStatus: "completed",
    });
    expect(next).toHaveLength(2);
    expect(next[1].assistantSpeaker?.label).toContain("code");
  });
});
