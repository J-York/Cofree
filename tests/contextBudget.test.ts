import { describe, expect, it, vi, beforeEach } from "vitest";
import type { LiteLLMMessage, LiteLLMToolDefinition } from "../src/lib/litellm";
import {
  compressMessagesToFitBudget,
  estimateTokensForMessage,
  estimateTokensForMessages,
  estimateTokensFromText,
  estimateTokensForToolDefinitions,
  updateTokenCalibration,
  resetTokenCalibration,
  tokenCalibration,
  scoreMessageImportance,
  mergeConsecutiveToolMessages,
} from "../src/orchestrator/contextBudget";

function msg(role: LiteLLMMessage["role"], content: string): LiteLLMMessage {
  return { role, content };
}

describe("contextBudget", () => {
  beforeEach(() => {
    resetTokenCalibration();
  });

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
      summarizer: {
        canSummarize: () => false,
        summarize: async () => "",
        markSummarized: () => {},
      },
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
  beforeEach(() => {
    resetTokenCalibration();
  });

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

  it("respects calibration factor", () => {
    const text = "Hello world";
    const base = estimateTokensFromText(text, 1.0);
    const doubled = estimateTokensFromText(text, 2.0);
    expect(doubled).toBeGreaterThanOrEqual(base * 1.5); // ceil rounding
    expect(doubled).toBeLessThanOrEqual(base * 2.5);
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
  beforeEach(() => {
    resetTokenCalibration();
  });

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

  it("retries compression when first pass still exceeds budget", async () => {
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

    // Very tight budget forces multiple rounds of compression.
    const res = await compressMessagesToFitBudget({
      messages,
      policy: {
        maxPromptTokens: Math.max(50, Math.floor(before * 0.15)),
        minMessagesToSummarize: 2,
        minRecentMessagesToKeep: 2,
        recentTokensMinRatio: 0.2,
      },
      summarizer: {
        canSummarize: () => true,
        summarize: async (msgs) => `compressed(${msgs.length})`,
        markSummarized: vi.fn(),
      },
    });

    expect(res.compressed).toBe(true);
    expect(res.estimatedTokensAfter).toBeLessThan(before);
  });
});

// ===================================================================
// P1-3: Dynamic calibration
// ===================================================================

describe("tokenCalibration", () => {
  beforeEach(() => {
    resetTokenCalibration();
  });

  it("starts with factor 1.0", () => {
    expect(tokenCalibration.factor).toBe(1.0);
    expect(tokenCalibration.sampleCount).toBe(0);
  });

  it("updates factor on first sample", () => {
    updateTokenCalibration(100, 150);
    expect(tokenCalibration.factor).toBeCloseTo(1.5, 1);
    expect(tokenCalibration.sampleCount).toBe(1);
  });

  it("uses EMA for subsequent samples", () => {
    updateTokenCalibration(100, 150); // factor = 1.5
    updateTokenCalibration(100, 100); // ratio=1.0, EMA: 0.3*1.0 + 0.7*1.5 = 1.35
    expect(tokenCalibration.factor).toBeCloseTo(1.35, 1);
    expect(tokenCalibration.sampleCount).toBe(2);
  });

  it("rejects extreme ratios", () => {
    updateTokenCalibration(100, 500); // ratio=5.0 exceeds max 3.0
    expect(tokenCalibration.factor).toBe(1.0);
    expect(tokenCalibration.sampleCount).toBe(0);
  });

  it("resets correctly", () => {
    updateTokenCalibration(100, 150);
    resetTokenCalibration();
    expect(tokenCalibration.factor).toBe(1.0);
    expect(tokenCalibration.sampleCount).toBe(0);
  });
});

// ===================================================================
// P2-1: Message importance scoring
// ===================================================================

describe("scoreMessageImportance", () => {
  it("system messages have high base score", () => {
    expect(scoreMessageImportance(msg("system", "sys prompt"))).toBeGreaterThanOrEqual(9);
  });

  it("error-containing messages score higher", () => {
    const errorMsg = msg("assistant", "遇到了一个 Error: null pointer");
    const normalMsg = msg("assistant", "一切正常，已完成任务");
    expect(scoreMessageImportance(errorMsg)).toBeGreaterThan(
      scoreMessageImportance(normalMsg)
    );
  });

  it("architecture-related messages score higher", () => {
    const archMsg = msg("user", "请按照这个架构 architecture 设计方案实现");
    const simpleMsg = msg("user", "请帮我修改一下");
    expect(scoreMessageImportance(archMsg)).toBeGreaterThan(
      scoreMessageImportance(simpleMsg)
    );
  });

  it("very long tool outputs have lower score", () => {
    const longTool: LiteLLMMessage = {
      role: "tool",
      content: "x".repeat(3000),
      name: "read_file",
    };
    const shortTool: LiteLLMMessage = {
      role: "tool",
      content: "ok",
      name: "read_file",
    };
    expect(scoreMessageImportance(longTool)).toBeLessThan(
      scoreMessageImportance(shortTool)
    );
  });
});

// ===================================================================
// P2-3: Fixed tool message merging
// ===================================================================

describe("mergeConsecutiveToolMessages (fixed)", () => {
  it("preserves tool_call_id info in merged content", () => {
    const assistant: LiteLLMMessage = {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "call-1", type: "function", function: { name: "read_file", arguments: "{}" } },
        { id: "call-2", type: "function", function: { name: "grep", arguments: "{}" } },
      ],
    };

    const tool1: LiteLLMMessage = {
      role: "tool",
      content: "file content",
      tool_call_id: "call-1",
      name: "read_file",
    };

    const tool2: LiteLLMMessage = {
      role: "tool",
      content: "grep results",
      tool_call_id: "call-2",
      name: "grep",
    };

    const merged = mergeConsecutiveToolMessages([assistant, tool1, tool2]);

    // Assistant + one merged tool message
    expect(merged.length).toBe(2);
    expect(merged[1].role).toBe("tool");
    // The merged content should reference the second tool_call_id
    expect(merged[1].content).toContain("call-2");
    expect(merged[1].content).toContain("grep results");
    expect(merged[1].content).toContain("file content");
  });

  it("removes merged tool_call from assistant tool_calls", () => {
    const assistant: LiteLLMMessage = {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "call-1", type: "function", function: { name: "read_file", arguments: "{}" } },
        { id: "call-2", type: "function", function: { name: "grep", arguments: "{}" } },
      ],
    };

    const tool1: LiteLLMMessage = {
      role: "tool",
      content: "file content",
      tool_call_id: "call-1",
      name: "read_file",
    };

    const tool2: LiteLLMMessage = {
      role: "tool",
      content: "grep results",
      tool_call_id: "call-2",
      name: "grep",
    };

    const merged = mergeConsecutiveToolMessages([assistant, tool1, tool2]);

    // The assistant's tool_calls should only have call-1 (call-2 was merged in)
    expect(merged[0].tool_calls?.length).toBe(1);
    expect(merged[0].tool_calls?.[0].id).toBe("call-1");
  });

  it("does not merge non-consecutive tool messages", () => {
    const messages: LiteLLMMessage[] = [
      msg("tool" as any, "result1"),
      msg("assistant", "thinking"),
      msg("tool" as any, "result2"),
    ];
    // Assign required fields
    messages[0] = { ...messages[0], tool_call_id: "c1", name: "t1" };
    messages[2] = { ...messages[2], tool_call_id: "c2", name: "t2" };

    const merged = mergeConsecutiveToolMessages(messages);
    expect(merged.length).toBe(3);
  });
});
