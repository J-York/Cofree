import { describe, expect, it } from "vitest";

import {
  buildCheckpointRestoreRecord,
  getCheckpointRestoreScope,
  shouldApplyCheckpointRecovery,
} from "./checkpointRecovery";

describe("checkpointRecovery", () => {
  it("derives the same restore scope for the same conversation despite message mutations", () => {
    const before = {
      id: "conv-1",
      agentBinding: { agentId: "agent-concierge" },
      messages: [{ id: "m1", content: "before" }],
    };
    const after = {
      id: "conv-1",
      agentBinding: { agentId: "agent-concierge" },
      messages: [
        { id: "m1", content: "before" },
        { id: "m2", content: "after approve" },
      ],
    };

    expect(getCheckpointRestoreScope(before, "agent-fullstack")).toEqual(
      getCheckpointRestoreScope(after, "agent-fullstack"),
    );
  });

  it("does not re-apply the same checkpoint record twice", () => {
    const record = buildCheckpointRestoreRecord(
      "csess:conv-1:agent-concierge",
      "assistant-1",
    );

    expect(shouldApplyCheckpointRecovery(null, record)).toBe(true);
    expect(shouldApplyCheckpointRecovery(record, record)).toBe(false);
    expect(
      shouldApplyCheckpointRecovery(
        record,
        buildCheckpointRestoreRecord("csess:conv-2:agent-concierge", "assistant-1"),
      ),
    ).toBe(true);
  });
});
