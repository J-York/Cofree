import { describe, expect, it, vi } from "vitest";
import type { LiteLLMMessage } from "../src/lib/litellm";
import {
  compressMessagesToFitBudget,
  estimateTokensForMessage,
  estimateTokensForMessages,
} from "../src/orchestrator/contextBudget";

function msg(role: LiteLLMMessage["role"], content: string): LiteLLMMessage {
  return { role, content };
}

describe("contextBudget", () => {
  it("does not compress when under budget", async () => {
    const messages: LiteLLMMessage[] = [
      msg("system", "sys"),
      msg("system", "runtime"),
      msg("user", "hi"),
    ];

    const res = await compressMessagesToFitBudget({
      messages,
      policy: {
        maxPromptTokens: 10_000,
        minMessagesToSummarize: 4,
        minRecentMessagesToKeep: 6,
        recentTokensMinRatio: 0.4,
      },
      summarizer: {
        canSummarize: () => true,
        summarize: async () => "should-not-run",
        markSummarized: () => {},
      },
    });

    expect(res.compressed).toBe(false);
    expect(res.messages).toBe(messages);
    expect(res.estimatedTokensAfter).toBe(res.estimatedTokensBefore);
  });

  it("includes tool_calls payload in token estimation", () => {
    const base: LiteLLMMessage = {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call-1", type: "function", function: { name: "x", arguments: "{\"k\":\"v\"}" } }],
    };

    const noTools: LiteLLMMessage = { role: "assistant", content: "" };

    expect(estimateTokensForMessage(base)).toBeGreaterThan(
      estimateTokensForMessage(noTools)
    );
  });

  it("summarizes older messages when over budget and summarizer is available", async () => {
    const summarizer = {
      canSummarize: () => true,
      summarize: vi.fn(async (messagesToSummarize: LiteLLMMessage[]) => {
        return `summary(${messagesToSummarize.length})`;
      }),
      markSummarized: vi.fn(),
    };

    const messages: LiteLLMMessage[] = [
      msg("system", "sys"),
      msg("system", "runtime"),
      msg("user", "u1 ".repeat(200)),
      msg("assistant", "a1 ".repeat(200)),
      msg("user", "u2 ".repeat(200)),
      msg("assistant", "a2 ".repeat(200)),
      msg("user", "u3 ".repeat(200)),
      msg("assistant", "a3 ".repeat(200)),
      msg("user", "u4 ".repeat(200)),
      msg("assistant", "a4 ".repeat(200)),
      msg("user", "u5 ".repeat(200)),
      msg("assistant", "a5 ".repeat(200)),
      msg("user", "u6 ".repeat(200)),
      msg("assistant", "a6 ".repeat(200)),
    ];

    const before = estimateTokensForMessages(messages);

    const res = await compressMessagesToFitBudget({
      messages,
      policy: {
        // Force compression
        maxPromptTokens: Math.max(20, Math.floor(before * 0.3)),
        minMessagesToSummarize: 4,
        minRecentMessagesToKeep: 3,
        recentTokensMinRatio: 0.4,
      },
      summarizer,
    });

    expect(res.compressed).toBe(true);
    expect(res.usedSummary).toBe(true);
    expect(summarizer.summarize).toHaveBeenCalledTimes(1);
    expect(summarizer.markSummarized).toHaveBeenCalledTimes(1);

    // System prefix stays pinned
    expect(res.messages[0]?.role).toBe("system");
    expect(res.messages[1]?.role).toBe("system");

    // Summary message inserted right after pinned system prefix
    expect(res.messages[2]?.role).toBe("system");
    expect(res.messages[2]?.content).toContain("[对话历史摘要]");

    // Do not start kept portion with tool role.
    expect(res.messages[3]?.role).not.toBe("tool");

    // Preserve at least one user message in the compressed prompt.
    expect(res.messages.some((m) => m.role === "user")).toBe(true);
  });

  it("avoids starting recent messages with an orphan tool message", async () => {
    const assistantWithToolCalls: LiteLLMMessage = {
      role: "assistant",
      content: "calling tool",
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "read_file", arguments: "{\"relative_path\":\"a\"}" },
        },
      ],
    };

    const toolResult: LiteLLMMessage = {
      role: "tool",
      content: "{\"ok\":true}",
      tool_call_id: "call-1",
      name: "read_file",
    };

    const messages: LiteLLMMessage[] = [
      msg("system", "sys"),
      msg("user", "u ".repeat(300)),
      msg("assistant", "a ".repeat(300)),
      assistantWithToolCalls,
      toolResult,
      msg("assistant", "after tool"),
    ];

    const before = estimateTokensForMessages(messages);

    const res = await compressMessagesToFitBudget({
      messages,
      policy: {
        maxPromptTokens: Math.max(20, Math.floor(before * 0.35)),
        minMessagesToSummarize: 2,
        minRecentMessagesToKeep: 2,
        recentTokensMinRatio: 0.2,
      },
      summarizer: {
        canSummarize: () => false,
        summarize: async () => "",
        markSummarized: () => {},
      },
    });

    expect(res.compressed).toBe(true);
    const pinnedLen = messages[0].role === "system" ? 1 : 0;
    const firstAfterPinned = res.messages[pinnedLen];
    // The first kept message after pinned system prefix must not be a tool message.
    expect(firstAfterPinned?.role).not.toBe("tool");
  });
});
