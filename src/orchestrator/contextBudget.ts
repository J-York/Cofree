import type { LiteLLMMessage, LiteLLMToolDefinition } from "../lib/piAiBridge";
import { TOOL_STRUCTURAL_OVERHEAD } from "./contextPolicy";

// ---------------------------------------------------------------------------
// P0-1: Multi-script token estimation
// ---------------------------------------------------------------------------
// Reference: OpenAI cl100k_base / o200k_base empirical data, tokenx project
// (github.com/johannschopplich/tokenx), and community benchmarks.
//
// Chars-per-token by script:
//   - CJK ideographs  : ~0.6 chars/token  (1 char ≈ 1.5–2 tokens)
//   - Latin / Cyrillic : ~4   chars/token
//   - Code punctuation : ~2   chars/token  ({, }, ;, =, etc.)
//   - Whitespace/newline: ~6  chars/token
//   - Digits           : ~3   chars/token
// ---------------------------------------------------------------------------

// Re-export for back-compat (no external importers as of Phase 1).
export { DEFAULT_CHARS_PER_TOKEN } from "./contextPolicy";

// BMP CJK ranges + Supplementary Ideographic Plane (Extension B–F, Compat Supplement).
// Using the `u` flag so \u{xxxxx} escapes work for code points above U+FFFF.
const CJK_RANGES = /[\u2E80-\u2FFF\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\u3100-\u312F\u3200-\u32FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{20000}-\u{2A6DF}\u{2A700}-\u{2B73F}\u{2B740}-\u{2B81F}\u{2B820}-\u{2CEAF}\u{2CEB0}-\u{2EBEF}\u{2F800}-\u{2FA1F}\u{30000}-\u{3134F}]/u;
const CODE_PUNCT = /[{}()\[\];:=<>+\-*/%&|^~!@#$`\\]/;

/**
 * Classify characters and estimate token count with per-script ratios. Static
 * multi-script weights (no dynamic per-model calibration); with prompt caching
 * the ±15% drift on uncached input is irrelevant to billing.
 */
export function estimateTokensFromText(text: string): number {
  const s = text ?? "";
  if (s.length === 0) return 0;

  let cjk = 0;
  let latin = 0;
  let codePunct = 0;
  let digit = 0;
  let whitespace = 0;

  // Use for-of to iterate by Unicode code points so that supplementary
  // plane characters (e.g. CJK Extension B–F) are handled as single units
  // instead of being split into surrogate-pair halves.
  for (const ch of s) {
    if (ch === " " || ch === "\n" || ch === "\r" || ch === "\t") {
      whitespace++;
    } else if (CJK_RANGES.test(ch)) {
      cjk++;
    } else if (CODE_PUNCT.test(ch)) {
      codePunct++;
    } else if (ch >= "0" && ch <= "9") {
      digit++;
    } else {
      latin++;
    }
  }

  const raw =
    cjk * 1.6 +        // ~0.6 chars/token → 1.6 tokens/char
    latin / 4 +         // ~4 chars/token
    codePunct / 2 +     // ~2 chars/token
    digit / 3 +         // ~3 chars/token
    whitespace / 6;     // ~6 chars/token

  return Math.ceil(raw);
}

export function estimateTokensForMessage(message: LiteLLMMessage): number {
  const base = estimateTokensFromText(message.content ?? "");

  const toolCallsText = message.tool_calls
    ? JSON.stringify(message.tool_calls)
    : "";
  const toolCalls = toolCallsText ? estimateTokensFromText(toolCallsText) : 0;

  // Per-message framing overhead (role, separators, etc.)
  const overhead = 4;

  return base + toolCalls + overhead;
}

export function estimateTokensForMessages(messages: LiteLLMMessage[]): number {
  return messages.reduce((sum, msg) => sum + estimateTokensForMessage(msg), 0);
}

// ---------------------------------------------------------------------------
// P0-2: Tool definition token overhead estimation
// ---------------------------------------------------------------------------
// Tool schemas are serialized as JSON and included in every API call.
// Each tool has ~12 tokens of structural overhead (type, function, name keys)
// plus the tokenized content of name, description, and parameter schema.
// ---------------------------------------------------------------------------

export function estimateTokensForToolDefinitions(
  tools: LiteLLMToolDefinition[],
): number {
  if (!tools || tools.length === 0) return 0;

  let total = 0;
  for (const tool of tools) {
    const nameTokens = estimateTokensFromText(tool.function.name);
    const descTokens = estimateTokensFromText(tool.function.description ?? "");
    const paramsTokens = estimateTokensFromText(
      JSON.stringify(tool.function.parameters),
    );
    total += TOOL_STRUCTURAL_OVERHEAD + nameTokens + descTokens + paramsTokens;
  }

  // Namespace overhead: the outer "tools" array wrapper
  total += 4;

  return total;
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

  // Invariant: the recent slice must contain at least one user message so the
  // compressed conversation remains a valid prompt (LLMs require a user turn).
  // If the budget-driven slice missed all users, walk further back until one
  // is included. Only the search for a user is unbounded; budget is allowed
  // to overflow here because the alternative — sending an LLM request with no
  // user message — is strictly worse.
  const sliceHasUser = (start: number): boolean => {
    for (let i = start; i < messages.length; i++) {
      if (messages[i].role === "user") return true;
    }
    return false;
  };
  while (splitIndex > 0 && !sliceHasUser(splitIndex)) {
    splitIndex -= 1;
    recentTokens += estimateTokensForMessage(messages[splitIndex]);
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
  /** Pre-computed token overhead for tool definitions sent with every request. */
  toolDefinitionTokens?: number;
}

export interface ContextSummarizer {
  summarize: (messagesToSummarize: LiteLLMMessage[]) => Promise<string>;
}

/**
 * Compress messages to fit within the prompt budget.
 *
 * Two-stage flow (replaces the prior 5-stage pipeline with pre-compress +
 * merge + importance-rescue + retry loop):
 *
 *   1. If total tokens already fit the budget, return as-is.
 *   2. Split into `pinned prefix | old | recent`; replace `old` with a single
 *      summary system message (or a "[历史已截断]" marker when there aren't
 *      enough messages to summarize).
 *
 * We rely on the summarizer to do a decent job in one pass. If it doesn't,
 * the correct fix is to improve the summarizer prompt, not to add importance
 * scoring and retry loops on top of it.
 */
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
  /** Retained for back-compat with callers/logs; always false in the new flow. */
  usedToolCompression: boolean;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
}> {
  const { messages, policy, summarizer, pinnedPrefixLen } = params;

  const toolDefOverhead = policy.toolDefinitionTokens ?? 0;
  const effectiveBudget = Math.max(0, policy.maxPromptTokens - toolDefOverhead);

  const estimatedTokensBefore = estimateTokensForMessages(messages);
  if (estimatedTokensBefore <= effectiveBudget) {
    return {
      messages,
      compressed: false,
      usedSummary: false,
      usedTruncation: false,
      usedToolCompression: false,
      estimatedTokensBefore,
      estimatedTokensAfter: estimatedTokensBefore,
    };
  }

  const detectedPinnedLen = initialSystemPrefixLength(messages);
  const pinnedLenRaw =
    typeof pinnedPrefixLen === "number" && Number.isFinite(pinnedPrefixLen)
      ? Math.max(Math.floor(pinnedPrefixLen), detectedPinnedLen)
      : detectedPinnedLen;
  const pinnedLen = Math.max(0, Math.min(messages.length, pinnedLenRaw));
  const pinned = messages.slice(0, pinnedLen);
  const compressible = messages.slice(pinnedLen);

  const pinnedTokens = estimateTokensForMessages(pinned);
  const availableTokens = Math.max(0, effectiveBudget - pinnedTokens);

  const { splitIndex } = sliceRecentMessagesByBudget({
    messages: compressible,
    maxAllowedTokens: availableTokens,
    minRecentMessagesToKeep: policy.minRecentMessagesToKeep,
    recentTokensMinRatio: policy.recentTokensMinRatio,
  });

  const effectiveSplitIndex = Math.max(0, Math.min(compressible.length, splitIndex));
  const oldMessages = compressible.slice(0, effectiveSplitIndex);
  const recentMessages = compressible.slice(effectiveSplitIndex);

  const assertUserPresence = (nextMessages: LiteLLMMessage[]): LiteLLMMessage[] => {
    if (nextMessages.some((m) => m.role === "user")) {
      return nextMessages;
    }
    // Reaching here means upstream slicing produced a compressed conversation
    // with zero user messages — should be unreachable given pinnedLen + recent
    // slice logic. Crash loudly instead of silently re-injecting the last user
    // message; a silent fix masks the underlying bug.
    throw new Error(
      `[contextBudget] Compressed messages have no user role` +
        ` | pinnedLen=${pinnedLen}` +
        ` | oldMessages=${oldMessages.length}` +
        ` | recentMessages=${recentMessages.length}` +
        ` | totalIn=${messages.length}`,
    );
  };

  let usedSummary = false;
  let usedTruncation = false;
  let next: LiteLLMMessage[];

  if (oldMessages.length < policy.minMessagesToSummarize || !summarizer) {
    usedTruncation = true;
    next = assertUserPresence([
      ...pinned,
      {
        role: "system",
        content:
          "[系统提示] 之前的对话历史由于达到上下文长度限制已被截断。请基于现有的最新信息继续工作。",
      },
      ...recentMessages,
    ]);
  } else {
    const summary = await summarizer.summarize(oldMessages);
    usedSummary = true;
    next = assertUserPresence([
      ...pinned,
      {
        role: "system",
        content: `[对话历史摘要] 以下是之前 ${oldMessages.length} 条对话消息的压缩摘要：\n\n${summary}\n\n请基于此摘要和后续最新消息继续工作。`,
      },
      ...recentMessages,
    ]);
  }

  return {
    messages: next,
    compressed: true,
    usedSummary,
    usedTruncation,
    usedToolCompression: false,
    estimatedTokensBefore,
    estimatedTokensAfter: estimateTokensForMessages(next),
  };
}

