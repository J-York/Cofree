import { describe, expect, it } from "vitest";

import type { ConversationTopbarTarget } from "./conversationTopbarNavigation";
import { focusTopbarTarget, resolveTopbarTargetElement } from "./conversationTopbarDom";

function buildThreadTarget(target: ConversationTopbarTarget): {
  thread: HTMLDivElement;
  contextAnchor: HTMLDivElement;
} {
  const thread = document.createElement("div");
  const contextAnchor = document.createElement("div");

  const message = document.createElement("div");
  message.dataset.chatMessageId = "m1";

  const plan = document.createElement("div");
  plan.dataset.topbarAnchor = "plan";

  const action = document.createElement("button");
  action.dataset.topbarActionId = "a1";
  action.textContent = "Approve";
  plan.appendChild(action);
  message.appendChild(plan);
  thread.appendChild(message);
  document.body.appendChild(thread);
  document.body.appendChild(contextAnchor);

  expect(resolveTopbarTargetElement({ thread, contextAnchor, target })).not.toBeNull();

  return { thread, contextAnchor };
}

describe("resolveTopbarTargetElement", () => {
  it("routes context targets to the composer/token anchor", () => {
    const thread = document.createElement("div");
    const contextAnchor = document.createElement("div");

    const result = resolveTopbarTargetElement({
      thread,
      contextAnchor,
      target: { anchor: "context" },
    });

    expect(result).toBe(contextAnchor);
  });

  it("prefers a scoped action element before falling back to the plan root", () => {
    const { thread, contextAnchor } = buildThreadTarget({
      anchor: "approval",
      messageId: "m1",
      actionId: "a1",
    });

    const result = resolveTopbarTargetElement({
      thread,
      contextAnchor,
      target: { anchor: "approval", messageId: "m1", actionId: "a1" },
    });

    expect(result?.dataset.topbarActionId).toBe("a1");
  });
});

describe("focusTopbarTarget", () => {
  it("moves focus to the first focusable descendant when present", () => {
    const target = document.createElement("div");
    const button = document.createElement("button");
    button.textContent = "Go";
    target.appendChild(button);
    document.body.appendChild(target);

    focusTopbarTarget(target);

    expect(document.activeElement).toBe(button);
  });

  it("focuses the target itself when no focusable child exists", () => {
    const target = document.createElement("div");
    document.body.appendChild(target);

    focusTopbarTarget(target);

    expect(document.activeElement).toBe(target);
    expect(target.getAttribute("tabindex")).toBe("-1");
  });
});
