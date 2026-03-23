import { describe, expect, it } from "vitest";

import type { AskUserRequest } from "../../../orchestrator/askUserService";
import { resolveApprovalAskUserDecision } from "./approvalGuard";

function makeRequest(
  id: string,
  sessionId: string,
): AskUserRequest {
  return {
    id,
    sessionId,
    question: "Need input",
    required: true,
    timestamp: "2026-03-23T00:00:00.000Z",
  };
}

describe("approvalGuard", () => {
  it("allows approval when there is no pending ask_user request", () => {
    expect(
      resolveApprovalAskUserDecision(
        "csess:conv-1:agent-orchestrator",
        null,
        null,
      ),
    ).toBe("allow");
  });

  it("blocks approval when the pending ask_user request is already visible for the same session", () => {
    const request = makeRequest("ask-1", "csess:conv-1:agent-orchestrator");

    expect(
      resolveApprovalAskUserDecision(
        "csess:conv-1:agent-orchestrator",
        request,
        request,
      ),
    ).toBe("block_visible");
  });

  it("clears a hidden pending ask_user request for the same session", () => {
    const request = makeRequest("ask-1", "csess:conv-1:agent-orchestrator");

    expect(
      resolveApprovalAskUserDecision(
        "csess:conv-1:agent-orchestrator",
        request,
        null,
      ),
    ).toBe("clear_hidden");
  });

  it("clears a pending ask_user request when the visible dialog belongs to another session", () => {
    const pendingRequest = makeRequest("ask-1", "csess:conv-1:agent-orchestrator");
    const visibleRequest = makeRequest("ask-2", "csess:conv-2:agent-orchestrator");

    expect(
      resolveApprovalAskUserDecision(
        "csess:conv-1:agent-orchestrator",
        pendingRequest,
        visibleRequest,
      ),
    ).toBe("clear_hidden");
  });
});
