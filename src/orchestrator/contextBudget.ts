import type { LiteLLMMessage, LiteLLMToolDefinition } from "../lib/piAiBridge";
import {
  CALIBRATION_EMA_ALPHA,
  CALIBRATION_MAX,
  CALIBRATION_MIN,
  TOOL_STRUCTURAL_OVERHEAD,
} from "./contextPolicy";

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
 * Classify characters and estimate token count with per-script ratios.
 *
 * The calibration factor (default 1.0) can be dynamically adjusted by
 * comparing this estimate against real API-reported token counts.
 * See {@link tokenCalibration}.
 */
export function estimateTokensFromText(
  text: string,
  calibrationFactor: number = tokenCalibration.factor,
): number {
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

  return Math.ceil(raw * calibrationFactor);
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
// Incremental token tracking for hot-loop usage
// ---------------------------------------------------------------------------
// In the orchestration loop, `estimateTokensForMessages` is called 3-8 times
// per turn on the same (or nearly-same) messages array.  Each call re-scans
// every message's full text, which becomes expensive as context grows.
//
// `MessageTokenTracker` maintains a per-message token cache keyed by object
// identity (WeakRef) and content length.  When messages are appended or
// spliced the tracker incrementally updates only the changed portion.
// ---------------------------------------------------------------------------

/**
 * Tracks token counts for a mutable messages array with O(1) amortized
 * lookups after the initial scan.  Call `update(messages)` whenever the
 * array may have changed; it returns the total token count.
 *
 * Accuracy guarantee: uses the same `estimateTokensForMessage` function,
 * so results are identical to the non-cached version.  The cache is
 * invalidated per-message when content length changes (covers in-place
 * content mutation such as tool message compression).
 */
export class MessageTokenTracker {
  private cachedTokens: WeakMap<LiteLLMMessage, { contentLen: number; toolCallsLen: number; tokens: number }> = new WeakMap();
  private lastMessages: LiteLLMMessage[] = [];
  private lastTotal = 0;

  /**
   * Recompute the total token count, reusing cached per-message values
   * when the message object and its content length haven't changed.
   */
  update(messages: LiteLLMMessage[]): number {
    // Fast path: same array reference, same length, last element unchanged
    if (
      messages === this.lastMessages &&
      messages.length > 0 &&
      this.lastTotal > 0
    ) {
      // Check only the tail (most common mutation is append)
      const lastMsg = messages[messages.length - 1];
      const cached = this.cachedTokens.get(lastMsg);
      const contentLen = (lastMsg.content ?? "").length;
      const toolCallsLen = lastMsg.tool_calls ? JSON.stringify(lastMsg.tool_calls).length : 0;
      if (cached && cached.contentLen === contentLen && cached.toolCallsLen === toolCallsLen) {
        return this.lastTotal;
      }
    }

    let total = 0;
    for (const msg of messages) {
      const contentLen = (msg.content ?? "").length;
      const toolCallsLen = msg.tool_calls ? JSON.stringify(msg.tool_calls).length : 0;
      const cached = this.cachedTokens.get(msg);

      if (cached && cached.contentLen === contentLen && cached.toolCallsLen === toolCallsLen) {
        total += cached.tokens;
      } else {
        const tokens = estimateTokensForMessage(msg);
        this.cachedTokens.set(msg, { contentLen, toolCallsLen, tokens });
        total += tokens;
      }
    }

    this.lastMessages = messages;
    this.lastTotal = total;
    return total;
  }

  /**
   * Notify the tracker that a message was appended.  This is O(1) — it
   * computes tokens only for the new message and adds to the running total.
   */
  notifyAppend(messages: LiteLLMMessage[], appendedMessage: LiteLLMMessage): number {
    const tokens = estimateTokensForMessage(appendedMessage);
    const contentLen = (appendedMessage.content ?? "").length;
    const toolCallsLen = appendedMessage.tool_calls ? JSON.stringify(appendedMessage.tool_calls).length : 0;
    this.cachedTokens.set(appendedMessage, { contentLen, toolCallsLen, tokens });
    this.lastMessages = messages;
    this.lastTotal += tokens;
    return this.lastTotal;
  }

  /** Reset all cached state (e.g. after context compression replaces the array). */
  invalidate(): void {
    this.cachedTokens = new WeakMap();
    this.lastMessages = [];
    this.lastTotal = 0;
  }

  /** Current cached total (may be stale if `update` hasn't been called). */
  get total(): number {
    return this.lastTotal;
  }
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

// ---------------------------------------------------------------------------
// P1-3: Dynamic calibration via API-reported token counts
// ---------------------------------------------------------------------------
// After each LLM call we know: (estimated tokens, actual tokens).
// We maintain an exponential moving average of the ratio actual/estimated
// and use it to correct future estimates.
//
// Calibration is per-model because different tokenizers have different
// chars-per-token characteristics (e.g. cl100k_base vs o200k_base).
// ---------------------------------------------------------------------------

export interface TokenCalibrationState {
  factor: number;
  sampleCount: number;
}

const calibrationByModel = new Map<string, TokenCalibrationState>();

// Default / active calibration — resolves to the active model's state.
// Kept as a module-level reference for backward compatibility with
// estimateTokensFromText()'s default parameter.
export const tokenCalibration: TokenCalibrationState = {
  factor: 1.0,
  sampleCount: 0,
};

function getCalibrationForModel(modelId: string): TokenCalibrationState {
  let state = calibrationByModel.get(modelId);
  if (!state) {
    state = { factor: 1.0, sampleCount: 0 };
    calibrationByModel.set(modelId, state);
  }
  return state;
}

/**
 * Update calibration for a specific model.  When `modelId` is provided the
 * per-model state is updated *and* the shared `tokenCalibration` singleton
 * is synced to that model's state (so that subsequent `estimateTokensFromText`
 * calls without an explicit factor automatically use the latest value).
 */
export function updateTokenCalibration(
  estimatedTokens: number,
  actualTokens: number,
  modelId?: string,
): void {
  if (estimatedTokens <= 0 || actualTokens <= 0) return;

  const ratio = actualTokens / estimatedTokens;
  if (ratio < CALIBRATION_MIN || ratio > CALIBRATION_MAX) return;

  const target = modelId ? getCalibrationForModel(modelId) : tokenCalibration;

  if (target.sampleCount === 0) {
    target.factor = ratio;
  } else {
    target.factor =
      CALIBRATION_EMA_ALPHA * ratio +
      (1 - CALIBRATION_EMA_ALPHA) * target.factor;
  }
  target.sampleCount += 1;

  // Keep the shared singleton in sync with the model that was just updated.
  if (modelId) {
    tokenCalibration.factor = target.factor;
    tokenCalibration.sampleCount = target.sampleCount;
  }
}

export function resetTokenCalibration(modelId?: string): void {
  if (modelId) {
    calibrationByModel.delete(modelId);
  } else {
    calibrationByModel.clear();
  }
  tokenCalibration.factor = 1.0;
  tokenCalibration.sampleCount = 0;
}

export function getTokenCalibrationFactor(modelId?: string): number {
  if (modelId) {
    return getCalibrationForModel(modelId).factor;
  }
  return tokenCalibration.factor;
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
  /** Pre-computed token overhead for tool definitions sent with every request. */
  toolDefinitionTokens?: number;
}

export interface ContextSummarizer {
  canSummarize: () => boolean;
  summarize: (messagesToSummarize: LiteLLMMessage[]) => Promise<string>;
  markSummarized: () => void;
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

  const lastUserContent =
    [...messages]
      .reverse()
      .find((m) => m.role === "user" && (m.content ?? "").trim())?.content ?? "";

  const ensureUserPresence = (nextMessages: LiteLLMMessage[]): LiteLLMMessage[] => {
    if (nextMessages.some((m) => m.role === "user")) return nextMessages;
    if (!lastUserContent.trim()) return nextMessages;
    return [
      ...nextMessages.slice(0, pinnedLen),
      { role: "user", content: lastUserContent },
      ...nextMessages.slice(pinnedLen),
    ];
  };

  let usedSummary = false;
  let usedTruncation = false;
  let next: LiteLLMMessage[];

  if (oldMessages.length < policy.minMessagesToSummarize) {
    usedTruncation = true;
    next = ensureUserPresence([
      ...pinned,
      {
        role: "system",
        content:
          "[系统提示] 之前的对话历史由于达到上下文长度限制已被截断。请基于现有的最新信息继续工作。",
      },
      ...recentMessages,
    ]);
  } else if (summarizer && summarizer.canSummarize()) {
    const summary = await summarizer.summarize(oldMessages);
    summarizer.markSummarized();
    usedSummary = true;
    next = ensureUserPresence([
      ...pinned,
      {
        role: "system",
        content: `[对话历史摘要] 以下是之前 ${oldMessages.length} 条对话消息的压缩摘要：\n\n${summary}\n\n请基于此摘要和后续最新消息继续工作。`,
      },
      ...recentMessages,
    ]);
  } else {
    usedTruncation = true;
    next = ensureUserPresence([
      ...pinned,
      {
        role: "system",
        content:
          "[系统提示] 由于达到上下文长度限制，之前的对话历史已被截断（摘要冷却窗口内或不可用，已跳过生成摘要）。请基于现有的最新信息继续工作。",
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

