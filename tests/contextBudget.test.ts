import { describe, expect, it, vi } from "vitest";
import type { LiteLLMMessage, LiteLLMToolDefinition } from "../src/lib/litellm";
import {
  compressMessagesToFitBudget,
  estimateTokensForMessage,
  estimateTokensForMessages,
  estimateTokensFromText,
  estimateTokensForToolDefinitions,
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
        summarize: async () => "should-not-run",
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
      summarize: vi.fn(async (messagesToSummarize: LiteLLMMessage[]) => {
        return `summary(${messagesToSummarize.length})`;
      }),
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

    expect(res.messages[0]?.role).toBe("system");
    expect(res.messages[1]?.role).toBe("system");

    expect(res.messages[2]?.role).toBe("system");
    expect(res.messages[2]?.content).toContain("[对话历史摘要]");

    expect(res.messages[3]?.role).not.toBe("tool");

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
      summarizer: undefined,
    });

    expect(res.compressed).toBe(true);
    const pinnedLen = messages[0].role === "system" ? 1 : 0;
    const firstAfterPinned = res.messages[pinnedLen];
    expect(firstAfterPinned?.role).not.toBe("tool");
  });
});

// ===================================================================
// P0-1: Multi-script token estimation
// ===================================================================

describe("estimateTokensFromText (multi-script)", () => {
  it("estimates more tokens for CJK text than Latin text of same char count", () => {
    const chineseText = "你好世界测试代码"; // 8 CJK chars
    const englishText = "abcdefgh";          // 8 Latin chars

    const chineseTokens = estimateTokensFromText(chineseText);
    const englishTokens = estimateTokensFromText(englishText);

    // CJK should estimate significantly more tokens per character
    expect(chineseTokens).toBeGreaterThan(englishTokens);
  });

  it("returns 0 for empty string", () => {
    expect(estimateTokensFromText("")).toBe(0);
    expect(estimateTokensFromText(null as unknown as string)).toBe(0);
  });

  it("handles mixed content (Chinese + English + code)", () => {
    const mixed = "function hello() { console.log('你好'); }";
    const tokens = estimateTokensFromText(mixed);
    expect(tokens).toBeGreaterThan(0);
    // Sanity: mixed content should not be wildly off
    expect(tokens).toBeLessThan(mixed.length);
  });

  it("estimates more tokens for code punctuation than plain Latin", () => {
    const codePunct = "{}()[];:=<>+-*/";
    const latinText = "abcdefghijklmno";
    expect(estimateTokensFromText(codePunct)).toBeGreaterThan(
      estimateTokensFromText(latinText)
    );
  });

  it("classifies CJK Extension B characters correctly", () => {
    // U+20000 is CJK Unified Ideographs Extension B
    const extBChar = "\u{20000}";
    const latinChar = "a";
    expect(estimateTokensFromText(extBChar)).toBeGreaterThan(
      estimateTokensFromText(latinChar),
    );
  });

});

// ===================================================================
// P0-2: Tool definition token overhead estimation
// ===================================================================

describe("estimateTokensForToolDefinitions", () => {
  it("returns 0 for empty array", () => {
    expect(estimateTokensForToolDefinitions([])).toBe(0);
  });

  it("returns positive value for tool definitions", () => {
    const tools: LiteLLMToolDefinition[] = [
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a text file by workspace-relative path.",
          parameters: {
            type: "object",
            properties: {
              relative_path: { type: "string", description: "file path" },
            },
          },
        },
      },
    ];

    const tokens = estimateTokensForToolDefinitions(tools);
    expect(tokens).toBeGreaterThan(10);
  });

  it("scales with number of tools", () => {
    const tool: LiteLLMToolDefinition = {
      type: "function",
      function: {
        name: "grep",
        description: "Search file contents using regex pattern.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string" },
          },
        },
      },
    };

    const one = estimateTokensForToolDefinitions([tool]);
    const three = estimateTokensForToolDefinitions([tool, tool, tool]);
    expect(three).toBeGreaterThan(one);
  });
});

// ===================================================================
// P1-1: Post-compression verification loop
// ===================================================================

describe("compressMessagesToFitBudget (verification loop)", () => {
  it("subtracts toolDefinitionTokens from effective budget", async () => {
    const messages: LiteLLMMessage[] = [
      msg("system", "sys"),
      msg("user", "hello"),
    ];

    const before = estimateTokensForMessages(messages);

    // Budget is generous without tool overhead
    const res1 = await compressMessagesToFitBudget({
      messages,
      policy: {
        maxPromptTokens: before + 100,
        minMessagesToSummarize: 4,
        minRecentMessagesToKeep: 2,
        recentTokensMinRatio: 0.4,
        toolDefinitionTokens: 0,
      },
    });
    expect(res1.compressed).toBe(false);

    // With large tool definition overhead, budget becomes tight
    const res2 = await compressMessagesToFitBudget({
      messages,
      policy: {
        maxPromptTokens: before + 100,
        minMessagesToSummarize: 4,
        minRecentMessagesToKeep: 2,
        recentTokensMinRatio: 0.4,
        toolDefinitionTokens: before + 200,
      },
    });
    expect(res2.compressed).toBe(true);
  });

  it("summarizes old messages and keeps recent window when over budget", async () => {
    const messages: LiteLLMMessage[] = [
      msg("system", "sys prompt " + "x".repeat(200)),
      msg("system", "runtime ctx " + "y".repeat(200)),
      msg("user", "u1 ".repeat(500)),
      msg("assistant", "a1 ".repeat(500)),
      msg("user", "u2 ".repeat(500)),
      msg("assistant", "a2 ".repeat(500)),
      msg("user", "u3 ".repeat(500)),
      msg("assistant", "a3 ".repeat(500)),
      msg("user", "u4 ".repeat(500)),
      msg("assistant", "a4 ".repeat(500)),
    ];

    const before = estimateTokensForMessages(messages);

    const res = await compressMessagesToFitBudget({
      messages,
      policy: {
        maxPromptTokens: Math.max(50, Math.floor(before * 0.15)),
        minMessagesToSummarize: 2,
        minRecentMessagesToKeep: 2,
        recentTokensMinRatio: 0.2,
      },
      summarizer: {
        summarize: async (msgs) => `compressed(${msgs.length})`,
      },
    });

    expect(res.compressed).toBe(true);
    expect(res.usedSummary).toBe(true);
    expect(res.estimatedTokensAfter).toBeLessThan(before);
  });
});

