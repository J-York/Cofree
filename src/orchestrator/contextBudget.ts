import type { LiteLLMMessage, LiteLLMToolDefinition } from "../lib/piAiBridge";

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

export const DEFAULT_CHARS_PER_TOKEN = 2.5; // kept for back-compat

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

const TOOL_STRUCTURAL_OVERHEAD = 12;

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

const CALIBRATION_EMA_ALPHA = 0.3;
const CALIBRATION_MIN = 0.5;
const CALIBRATION_MAX = 3.0;

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

/**
 * Compress a single tool message's content if it exceeds the threshold.
 * This is a "soft" compression that keeps the message but shortens its content.
 */
function compressToolMessageContent(
  content: string,
  maxChars: number
): string {
  if (content.length <= maxChars) return content;

  // Try to parse as JSON and extract key fields
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === "object" && parsed !== null) {
      // For tool results, keep success/error status and truncate large data fields
      const compressed: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string" && value.length > 500) {
          // Truncate long string fields
          compressed[key] = value.slice(0, 400) + "...[已压缩]";
        } else if (Array.isArray(value) && value.length > 10) {
          // Truncate long arrays
          compressed[key] = [...value.slice(0, 8), `...(+${value.length - 8} more)`];
        } else {
          compressed[key] = value;
        }
      }
      const result = JSON.stringify(compressed);
      if (result.length <= maxChars) return result;
    }
  } catch {
    // Not JSON, use simple truncation
  }

  // Fallback: simple truncation with marker
  return content.slice(0, maxChars - 20) + "\n...[内容已压缩]";
}

/**
 * Pre-compression pass: compress tool message contents before summary/truncation.
 * This helps retain more messages in context by shrinking verbose tool outputs.
 */
export function preCompressToolMessages(
  messages: LiteLLMMessage[],
  toolMessageMaxChars: number = 3000
): LiteLLMMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "tool") return msg;
    if ((msg.content ?? "").length <= toolMessageMaxChars) return msg;

    return {
      ...msg,
      content: compressToolMessageContent(msg.content ?? "", toolMessageMaxChars),
    };
  });
}

// ---------------------------------------------------------------------------
// P2-3: Fixed tool message merging — preserves tool_call_id mapping
// ---------------------------------------------------------------------------
// Instead of merging tool messages into one (which breaks the 1:1 mapping
// between assistant tool_calls[].id and tool response tool_call_id), we now
// only compress the *content* of consecutive tool messages and keep each
// message separate.  When merging is forced (to reduce message count), we
// rewrite the preceding assistant message's tool_calls to match the single
// merged tool response, keeping the API contract valid.
// ---------------------------------------------------------------------------

export interface MergedToolGroup {
  firstToolCallId: string;
  allToolCallIds: string[];
  mergedContent: string;
}

export function mergeConsecutiveToolMessages(
  messages: LiteLLMMessage[],
): LiteLLMMessage[] {
  const result: LiteLLMMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role !== "tool") {
      result.push(msg);
      continue;
    }

    const prevIdx = result.length - 1;
    if (prevIdx >= 0 && result[prevIdx].role === "tool") {
      const prev = result[prevIdx];
      const mergedContent = [
        prev.content,
        `---`,
        `[tool: ${msg.name ?? "unknown"}] (tool_call_id: ${msg.tool_call_id ?? "?"})`,
        msg.content,
      ].join("\n");

      result[prevIdx] = {
        ...prev,
        content: mergedContent,
      };

      // Rewrite the preceding assistant's tool_calls to drop the merged call,
      // so the model sees a single tool_call_id for the merged response.
      const assistantIdx = findPrecedingAssistantWithToolCalls(result, prevIdx);
      if (assistantIdx >= 0 && msg.tool_call_id) {
        const assistant = result[assistantIdx];
        if (assistant.tool_calls) {
          const filteredToolCalls = assistant.tool_calls.filter(
            (tc) => tc.id !== msg.tool_call_id,
          );
          result[assistantIdx] = {
            ...assistant,
            tool_calls: filteredToolCalls,
          };
        }
      }
    } else {
      result.push(msg);
    }
  }

  return result;
}

function findPrecedingAssistantWithToolCalls(
  messages: LiteLLMMessage[],
  beforeIndex: number,
): number {
  for (let i = beforeIndex - 1; i >= 0; i--) {
    if (messages[i].role === "assistant" && messages[i].tool_calls?.length) {
      return i;
    }
    if (messages[i].role !== "tool") break;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// P2-1: Message importance scoring
// ---------------------------------------------------------------------------
// Heuristic importance for deciding which messages to preserve during
// compression.  Higher score = more important to keep.
// ---------------------------------------------------------------------------

export function scoreMessageImportance(msg: LiteLLMMessage): number {
  const content = (msg.content ?? "").toLowerCase();

  // Base score by role
  let score = 1;
  if (msg.role === "system") score = 10;
  else if (msg.role === "user") score = 5;
  else if (msg.role === "assistant") score = 3;
  else if (msg.role === "tool") score = 2;

  // Error diagnostics are high-value context
  if (/error|错误|失败|failed|exception|panic|bug/i.test(content)) score += 4;

  // Architectural decisions & key findings
  if (/架构|architecture|design|设计|决策|decision|constraint|约束/i.test(content)) score += 3;

  // File modification summaries
  if (/propose_file_edit|propose_apply_patch|已修改|modified|created|deleted/i.test(content)) score += 2;

  // Very short messages (likely status updates) are less important
  if (content.length < 50) score -= 1;

  // Very long tool outputs are lower priority (info is usually recoverable)
  if (msg.role === "tool" && content.length > 2000) score -= 3;

  return Math.max(0, score);
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
  /** Max chars for individual tool message content during pre-compression. */
  toolMessageMaxChars?: number;
  /** Whether to merge consecutive tool messages. */
  mergeToolMessages?: boolean;
  /** Pre-computed token overhead for tool definitions sent with every request. */
  toolDefinitionTokens?: number;
}

export interface ContextSummarizer {
  canSummarize: () => boolean;
  summarize: (messagesToSummarize: LiteLLMMessage[]) => Promise<string>;
  markSummarized: () => void;
}

// P1-1: Maximum number of re-compression attempts to guarantee fit.
const MAX_COMPRESSION_RETRIES = 3;

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
  usedToolCompression: boolean;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
}> {
  const { messages, policy, summarizer, pinnedPrefixLen } = params;

  // P0-2: Subtract tool definition overhead from the effective budget.
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

  // === Phase 1: Pre-compress tool message contents ===
  const toolMaxChars = policy.toolMessageMaxChars ?? 3000;
  let workingMessages = preCompressToolMessages(messages, toolMaxChars);

  let estimatedAfterToolCompression = estimateTokensForMessages(workingMessages);
  const usedToolCompression = estimatedAfterToolCompression < estimatedTokensBefore;

  if (estimatedAfterToolCompression <= effectiveBudget) {
    return {
      messages: workingMessages,
      compressed: true,
      usedSummary: false,
      usedTruncation: false,
      usedToolCompression,
      estimatedTokensBefore,
      estimatedTokensAfter: estimatedAfterToolCompression,
    };
  }

  // === Phase 2: Merge consecutive tool messages (optional) ===
  if (policy.mergeToolMessages !== false) {
    workingMessages = mergeConsecutiveToolMessages(workingMessages);
    estimatedAfterToolCompression = estimateTokensForMessages(workingMessages);

    if (estimatedAfterToolCompression <= effectiveBudget) {
      return {
        messages: workingMessages,
        compressed: true,
        usedSummary: false,
        usedTruncation: false,
        usedToolCompression: true,
        estimatedTokensBefore,
        estimatedTokensAfter: estimatedAfterToolCompression,
      };
    }
  }

  // === Phase 3: Importance-aware summarization or truncation ===
  // P1-1: Wrap in a retry loop to guarantee budget compliance.
  let usedSummary = false;
  let usedTruncation = false;
  let currentMessages = workingMessages;
  let currentBudget = effectiveBudget;

  for (let attempt = 0; attempt <= MAX_COMPRESSION_RETRIES; attempt++) {
    const detectedPinnedLen = initialSystemPrefixLength(currentMessages);
    const pinnedLenRaw =
      typeof pinnedPrefixLen === "number" && Number.isFinite(pinnedPrefixLen)
        ? Math.max(Math.floor(pinnedPrefixLen), detectedPinnedLen)
        : detectedPinnedLen;
    const pinnedLen = Math.max(0, Math.min(currentMessages.length, pinnedLenRaw));
    const pinned = currentMessages.slice(0, pinnedLen);
    const compressible = currentMessages.slice(pinnedLen);

    const pinnedTokens = estimateTokensForMessages(pinned);
    const availableTokens = Math.max(0, currentBudget - pinnedTokens);

    // On retry, reduce the budget more aggressively to converge.
    const retryReductionFactor = attempt > 0 ? 1 - attempt * 0.1 : 1;
    const adjustedAvailable = Math.floor(availableTokens * retryReductionFactor);

    // P2-1: Score each compressible message for importance so we can rescue
    // high-value messages that would otherwise fall into the old/discarded set.
    const compressibleWithScores = compressible.map((m, idx) => ({
      msg: m,
      originalIdx: idx,
      importance: scoreMessageImportance(m),
    }));

    const { splitIndex } = sliceRecentMessagesByBudget({
      messages: compressible,
      maxAllowedTokens: adjustedAvailable,
      minRecentMessagesToKeep: policy.minRecentMessagesToKeep,
      recentTokensMinRatio: policy.recentTokensMinRatio,
    });

    const effectiveSplitIndex = Math.max(0, Math.min(compressible.length, splitIndex));

    // P2-1: Among the old messages to be discarded/summarized, rescue any
    // high-importance messages and prepend them to the recent portion.
    const IMPORTANCE_RESCUE_THRESHOLD = 7;
    const oldMessagesRaw = compressible.slice(0, effectiveSplitIndex);
    let recentMessages = compressible.slice(effectiveSplitIndex);

    const rescuedSet = new Set(
      compressibleWithScores
        .filter(
          (s) =>
            s.originalIdx < effectiveSplitIndex &&
            s.importance >= IMPORTANCE_RESCUE_THRESHOLD,
        )
        .map((s) => s.msg),
    );

    // Exclude rescued messages from oldMessages to avoid duplicate content
    // (they appear in recentMessages, so the summarizer must not see them too).
    const oldMessages = oldMessagesRaw.filter((m) => !rescuedSet.has(m));

    if (rescuedSet.size > 0) {
      recentMessages = [...rescuedSet, ...recentMessages];
    }

    const lastUserContent =
      [...currentMessages]
        .reverse()
        .find((m) => m.role === "user" && (m.content ?? "").trim())?.content ??
      "";

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
    } else if (summarizer && summarizer.canSummarize() && !usedSummary) {
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

    const estimatedTokensAfter = estimateTokensForMessages(next);

    // P1-1: If still over budget, retry with reduced budget.
    if (estimatedTokensAfter > effectiveBudget && attempt < MAX_COMPRESSION_RETRIES) {
      currentMessages = next;
      currentBudget = Math.floor(effectiveBudget * (1 - (attempt + 1) * 0.1));
      continue;
    }

    return {
      messages: next,
      compressed: true,
      usedSummary,
      usedTruncation,
      usedToolCompression,
      estimatedTokensBefore,
      estimatedTokensAfter,
    };
  }

  // Unreachable, but satisfy TypeScript.
  return {
    messages: currentMessages,
    compressed: true,
    usedSummary,
    usedTruncation,
    usedToolCompression,
    estimatedTokensBefore,
    estimatedTokensAfter: estimateTokensForMessages(currentMessages),
  };
}

// ---------------------------------------------------------------------------
// Context Editing: 主动淘汰旧 tool-use 对
// ---------------------------------------------------------------------------
// Before compression kicks in, proactively remove old read-only tool-use
// turns whose results are already captured in workingMemory.fileKnowledge.
// This keeps the context lean without losing information.
// ---------------------------------------------------------------------------

export interface ClearToolUsesConfig {
  /** Preserve the most recent N tool-use turns (default 5). */
  keepRecentTurns: number;
  /** Minimum clearable turns required before actually clearing (default 3). */
  clearAtLeast: number;
  /** Number of leading messages to never touch (system prefix). */
  pinnedPrefixLen: number;
}

export interface ClearToolUsesResult {
  messages: LiteLLMMessage[];
  cleared: boolean;
  pairsRemoved: number;
  tokensFreed: number;
}

/** Tool names whose results are read-only and safe to evict from context. */
const CLEARABLE_TOOL_NAMES = new Set([
  "read_file", "grep", "glob", "list_files",
  "git_status", "git_diff", "diagnostics",
]);

interface ToolUseTurn {
  assistantIndex: number;
  toolMessageIndices: number[];
  toolNames: string[];
}

/**
 * Identify tool-use turns, remove old read-only ones, and insert a tombstone.
 *
 * A "tool-use turn" is an assistant message with `tool_calls` plus its
 * corresponding tool response messages (matched by `tool_call_id`).
 */
export function clearOldToolUses(
  messages: LiteLLMMessage[],
  config: ClearToolUsesConfig,
): ClearToolUsesResult {
  const { keepRecentTurns, clearAtLeast } = config;
  const pinnedPrefixLen = Math.max(config.pinnedPrefixLen, initialSystemPrefixLength(messages));

  // --- Step 1: Identify all tool-use turns ---
  const turns: ToolUseTurn[] = [];

  for (let i = pinnedPrefixLen; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "assistant" || !msg.tool_calls || msg.tool_calls.length === 0) {
      continue;
    }

    const callIds = new Set(msg.tool_calls.map((tc) => tc.id));
    const toolNames = msg.tool_calls.map((tc) => tc.function.name);
    const toolMessageIndices: number[] = [];

    // Scan forward to collect matching tool response messages
    for (let j = i + 1; j < messages.length; j++) {
      const candidate = messages[j];
      if (candidate.role === "system") continue; // skip interleaved system messages
      if (candidate.role === "tool" && candidate.tool_call_id && callIds.has(candidate.tool_call_id)) {
        toolMessageIndices.push(j);
        continue;
      }
      // Stop at the next non-tool, non-system message
      if (candidate.role !== "tool") break;
      // tool message for a different call — also stop
      break;
    }

    turns.push({ assistantIndex: i, toolMessageIndices, toolNames });
  }

  // --- Step 2: Filter to clearable turns (all tool_calls are read-only) ---
  const clearableTurns = turns.filter((t) =>
    t.toolNames.length > 0 && t.toolNames.every((name) => CLEARABLE_TOOL_NAMES.has(name)),
  );

  // --- Step 3: Protect recent N turns ---
  const candidateTurns = clearableTurns.length > keepRecentTurns
    ? clearableTurns.slice(0, clearableTurns.length - keepRecentTurns)
    : [];

  if (candidateTurns.length < clearAtLeast) {
    return { messages, cleared: false, pairsRemoved: 0, tokensFreed: 0 };
  }

  // --- Step 4: Collect indices to remove and compute freed tokens ---
  const indicesToRemove = new Set<number>();
  let tokensFreed = 0;

  for (const turn of candidateTurns) {
    // Remove all tool response messages
    for (const idx of turn.toolMessageIndices) {
      indicesToRemove.add(idx);
      tokensFreed += estimateTokensForMessage(messages[idx]);
    }

    // Handle assistant message
    const assistantMsg = messages[turn.assistantIndex];
    const hasContent = (assistantMsg.content ?? "").trim().length > 0;

    if (!hasContent) {
      // No textual content — remove the entire assistant message
      indicesToRemove.add(turn.assistantIndex);
      tokensFreed += estimateTokensForMessage(assistantMsg);
    }
    // If there IS content, we strip tool_calls below (after filtering)
  }

  // --- Step 5: Build new messages array ---
  // We need the first removed index position for tombstone insertion.
  const sortedRemoved = [...indicesToRemove].sort((a, b) => a - b);
  const tombstonePosition = sortedRemoved.length > 0 ? sortedRemoved[0] : pinnedPrefixLen;

  // Set of assistant indices where we keep the message but strip tool_calls
  const stripToolCallsAt = new Set(
    candidateTurns
      .filter((t) => !indicesToRemove.has(t.assistantIndex))
      .map((t) => t.assistantIndex),
  );

  const newMessages: LiteLLMMessage[] = [];
  let tombstoneInserted = false;

  for (let i = 0; i < messages.length; i++) {
    if (indicesToRemove.has(i)) {
      // Insert tombstone at the position of the first removed message
      if (!tombstoneInserted && i >= tombstonePosition) {
        newMessages.push({
          role: "system",
          content:
            `[Context Edited] 已清除 ${candidateTurns.length} 个旧工具调用轮次以释放上下文空间。文件知识已保存在工作记忆中。`,
        });
        tombstoneInserted = true;
      }
      continue;
    }

    if (stripToolCallsAt.has(i)) {
      // Keep content, remove tool_calls
      const { tool_calls: _, ...rest } = messages[i];
      tokensFreed += messages[i].tool_calls
        ? estimateTokensFromText(JSON.stringify(messages[i].tool_calls))
        : 0;
      newMessages.push(rest as LiteLLMMessage);
    } else {
      newMessages.push(messages[i]);
    }
  }

  // Edge case: if tombstone wasn't inserted yet (all removed indices were processed)
  if (!tombstoneInserted && candidateTurns.length > 0) {
    // Insert after pinned prefix
    newMessages.splice(pinnedPrefixLen, 0, {
      role: "system",
      content:
        `[Context Edited] 已清除 ${candidateTurns.length} 个旧工具调用轮次以释放上下文空间。文件知识已保存在工作记忆中。`,
    });
  }

  return {
    messages: newMessages,
    cleared: true,
    pairsRemoved: candidateTurns.length,
    tokensFreed,
  };
}
