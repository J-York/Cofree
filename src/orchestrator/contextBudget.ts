import type { LiteLLMMessage } from "../lib/litellm";

export const DEFAULT_CHARS_PER_TOKEN = 2.5;

export function estimateTokensFromText(text: string): number {
  return Math.ceil((text ?? "").length / DEFAULT_CHARS_PER_TOKEN);
}

export function estimateTokensForMessage(message: LiteLLMMessage): number {
  const base = estimateTokensFromText(message.content ?? "");

  // tool_calls payload can be large; include it in the estimate to avoid under-budgeting.
  const toolCallsText = message.tool_calls
    ? JSON.stringify(message.tool_calls)
    : "";
  const toolCalls = toolCallsText ? estimateTokensFromText(toolCallsText) : 0;

  // Minimal per-message overhead approximation.
  const overhead = 4;

  return base + toolCalls + overhead;
}

export function estimateTokensForMessages(messages: LiteLLMMessage[]): number {
  return messages.reduce((sum, msg) => sum + estimateTokensForMessage(msg), 0);
}

export function initialSystemPrefixLength(messages: LiteLLMMessage[]): number {
  let idx = 0;
  while (idx < messages.length && messages[idx]?.role === "system") {
    idx += 1;
  }
  return idx;
}

export function adjustSplitIndexToAvoidOrphanToolMessages(
  messages: LiteLLMMessage[],
  splitIndex: number
): number {
  let idx = splitIndex;

  // Do not start kept messages with tool role; tool messages require a preceding assistant tool_calls.
  while (idx > 0 && messages[idx]?.role === "tool") {
    idx -= 1;
  }

  return idx;
}

export function sliceRecentMessagesByBudget(params: {
  messages: LiteLLMMessage[];
  maxAllowedTokens: number;
  minRecentMessagesToKeep: number;
  recentTokensMinRatio: number;
}): { splitIndex: number; recentTokens: number } {
  const { messages, maxAllowedTokens, minRecentMessagesToKeep, recentTokensMinRatio } =
    params;

  const minRecentTokens = Math.floor(maxAllowedTokens * recentTokensMinRatio);
  let recentTokens = 0;
  let kept = 0;
  let splitIndex = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    const tokens = estimateTokensForMessage(messages[i]);

    // Always keep at least N recent messages.
    if (kept < minRecentMessagesToKeep) {
      recentTokens += tokens;
      kept += 1;
      splitIndex = i;
      continue;
    }

    // After we satisfy the minimum recent messages, keep adding until reaching minRecentTokens,
    // but never exceed 60% of maxAllowedTokens to avoid starving oldMessages.
    if (
      recentTokens < minRecentTokens &&
      recentTokens + tokens <= maxAllowedTokens * 0.6
    ) {
      recentTokens += tokens;
      kept += 1;
      splitIndex = i;
      continue;
    }

    break;
  }

  splitIndex = adjustSplitIndexToAvoidOrphanToolMessages(messages, splitIndex);
  return { splitIndex, recentTokens };
}

export interface ContextCompressionPolicy {
  /** Prompt token budget (excluding an output safety buffer handled by the caller). */
  maxPromptTokens: number;
  minMessagesToSummarize: number;
  minRecentMessagesToKeep: number;
  recentTokensMinRatio: number;
}

export interface ContextSummarizer {
  canSummarize: () => boolean;
  summarize: (messagesToSummarize: LiteLLMMessage[]) => Promise<string>;
  markSummarized: () => void;
}

export async function compressMessagesToFitBudget(params: {
  messages: LiteLLMMessage[];
  policy: ContextCompressionPolicy;
  summarizer?: ContextSummarizer;
  pinnedPrefixLen?: number;
}): Promise<{
  messages: LiteLLMMessage[];
  compressed: boolean;
  usedSummary: boolean;
  usedTruncation: boolean;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
}> {
  const { messages, policy, summarizer, pinnedPrefixLen } = params;

  const estimatedTokensBefore = estimateTokensForMessages(messages);
  if (estimatedTokensBefore <= policy.maxPromptTokens) {
    return {
      messages,
      compressed: false,
      usedSummary: false,
      usedTruncation: false,
      estimatedTokensBefore,
      estimatedTokensAfter: estimatedTokensBefore,
    };
  }

  const detectedPinnedLen = initialSystemPrefixLength(messages);
  const pinnedLenRaw =
    typeof pinnedPrefixLen === "number" && Number.isFinite(pinnedPrefixLen)
      ? Math.floor(pinnedPrefixLen)
      : detectedPinnedLen;
  const pinnedLen = Math.max(0, Math.min(messages.length, pinnedLenRaw));
  const pinned = messages.slice(0, pinnedLen);
  const compressible = messages.slice(pinnedLen);

  const pinnedTokens = estimateTokensForMessages(pinned);
  const availableTokens = Math.max(0, policy.maxPromptTokens - pinnedTokens);

  const { splitIndex } = sliceRecentMessagesByBudget({
    messages: compressible,
    maxAllowedTokens: availableTokens,
    minRecentMessagesToKeep: policy.minRecentMessagesToKeep,
    recentTokensMinRatio: policy.recentTokensMinRatio,
  });

  const effectiveSplitIndex = Math.max(0, Math.min(compressible.length, splitIndex));
  const oldMessages = compressible.slice(0, effectiveSplitIndex);
  const recentMessages = compressible.slice(effectiveSplitIndex);

  const lastUserContent =
    [...messages]
      .reverse()
      .find((m) => m.role === "user" && (m.content ?? "").trim())?.content ??
    "";

  let usedSummary = false;
  let usedTruncation = false;

  const ensureUserPresence = (nextMessages: LiteLLMMessage[]): LiteLLMMessage[] => {
    if (nextMessages.some((m) => m.role === "user")) {
      return nextMessages;
    }
    if (!lastUserContent.trim()) {
      return nextMessages;
    }
    return [
      ...nextMessages.slice(0, pinnedLen),
      { role: "user", content: lastUserContent },
      ...nextMessages.slice(pinnedLen),
    ];
  };

  // Only summarize if there are enough old messages to warrant it.
  if (oldMessages.length < policy.minMessagesToSummarize) {
    usedTruncation = true;
    const next = ensureUserPresence([
      ...pinned,
      {
        role: "system",
        content:
          "[系统提示] 之前的对话历史由于达到上下文长度限制已被截断。请基于现有的最新信息继续工作。",
      },
      ...recentMessages,
    ]);

    const estimatedTokensAfter = estimateTokensForMessages(next);
    return {
      messages: next,
      compressed: true,
      usedSummary,
      usedTruncation,
      estimatedTokensBefore,
      estimatedTokensAfter,
    };
  }

  if (summarizer && summarizer.canSummarize()) {
    const summary = await summarizer.summarize(oldMessages);
    summarizer.markSummarized();
    usedSummary = true;

    const next = ensureUserPresence([
      ...pinned,
      {
        role: "system",
        content: `[对话历史摘要] 以下是之前 ${oldMessages.length} 条对话消息的压缩摘要：\n\n${summary}\n\n请基于此摘要和后续最新消息继续工作。`,
      },
      ...recentMessages,
    ]);

    const estimatedTokensAfter = estimateTokensForMessages(next);
    return {
      messages: next,
      compressed: true,
      usedSummary,
      usedTruncation,
      estimatedTokensBefore,
      estimatedTokensAfter,
    };
  }

  usedTruncation = true;
  const next = ensureUserPresence([
    ...pinned,
    {
      role: "system",
      content:
        "[系统提示] 由于达到上下文长度限制，之前的对话历史已被截断（摘要冷却窗口内或不可用，已跳过生成摘要）。请基于现有的最新信息继续工作。",
    },
    ...recentMessages,
  ]);

  const estimatedTokensAfter = estimateTokensForMessages(next);
  return {
    messages: next,
    compressed: true,
    usedSummary,
    usedTruncation,
    estimatedTokensBefore,
    estimatedTokensAfter,
  };
}
