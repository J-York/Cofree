import { describe, expect, it } from "vitest";
import type { Conversation } from "../../../lib/conversationStore";
import type { BackgroundStreamState } from "./types";
import {
  createBackgroundStreamState,
  createClearedConversation,
  createConversationViewState,
  createEmptyChatViewState,
  resolvePreferredConversationId,
} from "./sessionState";

const BASE_CONVERSATION: Conversation = {
  id: "conv-1",
  title: "测试对话",
  createdAt: "2026-03-07T00:00:00.000Z",
  updatedAt: "2026-03-07T00:00:00.000Z",
  messages: [
    {
      id: "msg-1",
      role: "assistant",
      content: "hello",
      createdAt: "2026-03-07T00:00:00.000Z",
      plan: null,
    },
  ],
  lastTokenCount: 42,
};

describe("chat sessionState helpers", () => {
  it("creates an empty chat view state", () => {
    expect(createEmptyChatViewState("ready")).toEqual({
      messages: [],
      liveContextTokens: null,
      isStreaming: false,
      sessionNote: "ready",
      liveToolCalls: [],
      categorizedError: null,
    });
  });

  it("creates idle conversation view state from stored conversation data", () => {
    const viewState = createConversationViewState({
      conversation: BASE_CONVERSATION,
      idleSessionNote: "已切换对话",
    });

    expect(viewState).toEqual({
      messages: BASE_CONVERSATION.messages,
      liveContextTokens: 42,
      isStreaming: false,
      sessionNote: "已切换对话",
      liveToolCalls: [],
      categorizedError: null,
    });
    expect(viewState.messages).not.toBe(BASE_CONVERSATION.messages);
  });

  it("prefers background stream state when restoring a streaming conversation", () => {
    const backgroundStream: BackgroundStreamState = {
      messages: [
        {
          id: "msg-2",
          role: "assistant",
          content: "streaming",
          createdAt: "2026-03-07T00:01:00.000Z",
          plan: null,
        },
      ],
      isStreaming: true,
      tokenCount: 99,
      sessionNote: "正在回复…",
      liveToolCalls: [
        {
          callId: "call-1",
          toolName: "read",
          status: "running",
        },
      ],
      error: null,
    };

    const viewState = createConversationViewState({
      conversation: BASE_CONVERSATION,
      backgroundStream,
      idleSessionNote: "不会使用",
    });

    expect(viewState).toEqual({
      messages: backgroundStream.messages,
      liveContextTokens: 99,
      isStreaming: true,
      sessionNote: "正在回复…",
      liveToolCalls: backgroundStream.liveToolCalls,
      categorizedError: null,
    });
    expect(viewState.messages).not.toBe(backgroundStream.messages);
    expect(viewState.liveToolCalls).not.toBe(backgroundStream.liveToolCalls);
  });

  it("creates background stream state only for active streams", () => {
    expect(
      createBackgroundStreamState({
        isStreaming: false,
        messages: BASE_CONVERSATION.messages,
        liveContextTokens: 5,
        sessionNote: "idle",
        liveToolCalls: [],
        categorizedError: null,
      }),
    ).toBeNull();

    const backgroundStream = createBackgroundStreamState({
      isStreaming: true,
      messages: BASE_CONVERSATION.messages,
      liveContextTokens: 5,
      sessionNote: "running",
      liveToolCalls: [
        {
          callId: "call-1",
          toolName: "grep",
          status: "success",
          resultPreview: "done",
        },
      ],
      categorizedError: null,
    });

    expect(backgroundStream).toEqual({
      messages: BASE_CONVERSATION.messages,
      isStreaming: true,
      tokenCount: 5,
      sessionNote: "running",
      liveToolCalls: [
        {
          callId: "call-1",
          toolName: "grep",
          status: "success",
          resultPreview: "done",
        },
      ],
      error: null,
    });
  });

  it("clears conversation payloads and resolves preferred conversation ids", () => {
    const clearedConversation = createClearedConversation(BASE_CONVERSATION);
    expect(clearedConversation.id).toBe(BASE_CONVERSATION.id);
    expect(clearedConversation.title).toBe(BASE_CONVERSATION.title);
    expect(clearedConversation.createdAt).toBe(BASE_CONVERSATION.createdAt);
    expect(clearedConversation.messages).toEqual([]);
    expect(clearedConversation.lastTokenCount).toBeNull();
    expect(clearedConversation.updatedAt).not.toBe(BASE_CONVERSATION.updatedAt);

    expect(
      resolvePreferredConversationId(
        [
          { id: "conv-1", title: "A", createdAt: "1", updatedAt: "1", messageCount: 1 },
          { id: "conv-2", title: "B", createdAt: "2", updatedAt: "2", messageCount: 0 },
        ],
        "conv-2",
      ),
    ).toBe("conv-2");
    expect(
      resolvePreferredConversationId(
        [
          { id: "conv-1", title: "A", createdAt: "1", updatedAt: "1", messageCount: 1 },
          { id: "conv-2", title: "B", createdAt: "2", updatedAt: "2", messageCount: 0 },
        ],
        "missing",
      ),
    ).toBe("conv-1");
    expect(resolvePreferredConversationId([], null)).toBeNull();
  });
});