import { createRef } from "react";
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ActiveMention, MentionSuggestion } from "../mentions";
import { ChatComposer, type ChatComposerProps } from "./ChatComposer";

function buildMentionSuggestion(overrides: Partial<MentionSuggestion> = {}): MentionSuggestion {
  return {
    kind: "file",
    relativePath: "src/App.tsx",
    displayName: "App.tsx",
    modified: 0,
    size: 0,
    source: "search",
    ...overrides,
  };
}

function renderComposer(overrides: Partial<ChatComposerProps> = {}) {
  const activeMention: ActiveMention = { query: "", start: 0, end: 1 };
  const mentionSuggestions = [
    buildMentionSuggestion(),
    buildMentionSuggestion({ relativePath: "src/main.ts", displayName: "main.ts" }),
  ];
  const props: ChatComposerProps = {
    textareaRef: createRef<HTMLTextAreaElement>(),
    prompt: "@",
    chatBlocked: false,
    composerAttachments: [],
    onRemoveComposerAttachment: vi.fn(),
    selectedSkills: [],
    onRemoveSelectedSkill: vi.fn(),
    activeMention,
    mentionSuggestions,
    mentionSelectionIndex: 0,
    onPromptChange: vi.fn(),
    onMentionSync: vi.fn(),
    onMentionSuggestionSelect: vi.fn(),
    onSelectNextMention: vi.fn(),
    onSelectPreviousMention: vi.fn(),
    onClearMentionUi: vi.fn(),
    onSubmit: vi.fn(),
    liveContextTokens: null,
    maxContextTokens: 120_000,
    isStreaming: false,
    executingActionId: "",
    messagesCount: 1,
    onClearHistory: vi.fn(),
    debugMode: false,
    isExportingDebugBundle: false,
    hasDebugBundleTarget: false,
    onDownloadConversationDebugBundle: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };

  return { ...render(<ChatComposer {...props} />), props };
}

describe("ChatComposer mention keyboard behavior", () => {
  it("does not resync mention state while using arrow-key navigation", () => {
    const onMentionSync = vi.fn();
    const onSelectNextMention = vi.fn();
    const onSelectPreviousMention = vi.fn();
    const view = renderComposer({
      onMentionSync,
      onSelectNextMention,
      onSelectPreviousMention,
    });

    const textarea = view.container.querySelector("textarea");
    expect(textarea).not.toBeNull();
    if (!textarea) {
      throw new Error("textarea not found");
    }

    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    fireEvent.keyUp(textarea, { key: "ArrowDown" });
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    fireEvent.keyUp(textarea, { key: "ArrowUp" });

    expect(onSelectNextMention).toHaveBeenCalledWith(1);
    expect(onSelectPreviousMention).toHaveBeenCalledTimes(1);
    expect(onMentionSync).not.toHaveBeenCalled();
  });

  it("still syncs mention state on normal keyup", () => {
    const onMentionSync = vi.fn();
    const view = renderComposer({ onMentionSync });

    const textarea = view.container.querySelector("textarea");
    expect(textarea).not.toBeNull();
    if (!textarea) {
      throw new Error("textarea not found");
    }

    fireEvent.keyUp(textarea, { key: "a" });

    expect(onMentionSync).toHaveBeenCalledTimes(1);
  });
});

describe("ChatComposer edit mode (M5)", () => {
  it("renders the edit banner and switches submit label when editingMessageId is set", () => {
    const view = renderComposer({
      prompt: "edited body",
      editingMessageId: "msg-42",
    });

    expect(view.container.querySelector(".chat-edit-banner")).not.toBeNull();
    expect(view.container.querySelector(".chat-input-box-editing")).not.toBeNull();
    expect(view.getByText("保存并重新生成")).toBeTruthy();
  });

  it("does not render the edit banner in normal mode", () => {
    const view = renderComposer({ prompt: "hello" });
    expect(view.container.querySelector(".chat-edit-banner")).toBeNull();
    expect(view.getByText("发送")).toBeTruthy();
  });

  it("invokes onCancelEdit when the cancel button is clicked", () => {
    const onCancelEdit = vi.fn();
    const view = renderComposer({
      prompt: "edited body",
      editingMessageId: "msg-42",
      onCancelEdit,
    });

    const cancelBtn = view.container.querySelector(".chat-edit-banner-cancel");
    expect(cancelBtn).not.toBeNull();
    fireEvent.click(cancelBtn!);
    expect(onCancelEdit).toHaveBeenCalledTimes(1);
  });
});
