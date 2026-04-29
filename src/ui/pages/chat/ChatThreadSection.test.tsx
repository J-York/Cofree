import { createRef } from "react";
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ChatMessageRecord } from "../../../lib/chatHistoryStore";
import { ChatThreadSection, type ChatThreadSectionProps } from "./ChatThreadSection";

function userMessage(id: string, content: string): ChatMessageRecord {
  return {
    id,
    role: "user",
    content,
    createdAt: "2026-04-26T00:00:00Z",
    plan: null,
  };
}

function assistantMessage(id: string, content: string): ChatMessageRecord {
  return {
    id,
    role: "assistant",
    content,
    createdAt: "2026-04-26T00:00:01Z",
    plan: null,
  };
}

function renderThread(overrides: Partial<ChatThreadSectionProps> = {}) {
  const props: ChatThreadSectionProps = {
    threadRef: createRef<HTMLDivElement>(),
    onThreadScroll: vi.fn(),
    messages: [userMessage("u-1", "hello"), assistantMessage("a-1", "hi")],
    assistantDisplayName: "Assistant",
    assistantDescription: "",
    debugMode: false,
    isStreaming: false,
    liveToolCalls: [],
    liveThinking: "",
    executingActionId: "",
    getActiveShellActionIds: () => [],
    onApprove: vi.fn().mockResolvedValue(undefined),
    onRetry: vi.fn().mockResolvedValue(undefined),
    onReject: vi.fn(),
    onComment: vi.fn(),
    onCancel: vi.fn().mockResolvedValue(undefined),
    onApproveAll: vi.fn().mockResolvedValue(undefined),
    onRejectAll: vi.fn(),
    onSuggestionClick: vi.fn(),
    ...overrides,
  };
  return { ...render(<ChatThreadSection {...props} />), props };
}

describe("ChatThreadSection edit button (M5)", () => {
  it("renders an edit button on user messages when not streaming", () => {
    const view = renderThread({ onEditMessage: vi.fn() });
    const editButtons = view.container.querySelectorAll(".chat-message-edit-btn");
    // One button per user message (only "u-1" is a user message).
    expect(editButtons.length).toBe(1);
  });

  it("does not render the button on assistant messages", () => {
    const view = renderThread({
      onEditMessage: vi.fn(),
      messages: [assistantMessage("a-only", "hi from bot")],
    });
    expect(view.container.querySelectorAll(".chat-message-edit-btn").length).toBe(0);
  });

  it("hides the button while streaming (canEdit guard)", () => {
    const view = renderThread({
      onEditMessage: vi.fn(),
      isStreaming: true,
    });
    expect(view.container.querySelectorAll(".chat-message-edit-btn").length).toBe(0);
  });

  it("hides the button on the message currently being edited", () => {
    const view = renderThread({
      onEditMessage: vi.fn(),
      editingMessageId: "u-1",
    });
    expect(view.container.querySelectorAll(".chat-message-edit-btn").length).toBe(0);
  });

  it("invokes onEditMessage with the user message id when clicked", () => {
    const onEditMessage = vi.fn();
    const view = renderThread({ onEditMessage });
    const btn = view.container.querySelector(".chat-message-edit-btn");
    expect(btn).not.toBeNull();
    fireEvent.click(btn!);
    expect(onEditMessage).toHaveBeenCalledWith("u-1");
  });

  it("does not render any edit button when onEditMessage is not provided", () => {
    const view = renderThread({});
    expect(view.container.querySelectorAll(".chat-message-edit-btn").length).toBe(0);
  });
});
