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
