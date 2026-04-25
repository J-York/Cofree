// ---------------------------------------------------------------------------
// Context policy: all constants that control what goes into the LLM context,
// how large it's allowed to be, and how it is compressed when oversized.
//
// This file is the single source of truth for context-sizing knobs. Logic
// (estimation, compression, summarization) lives elsewhere; only values live
// here. Grouped by concern so the surface of each Phase 2–4 refactor is
// visible at a glance.
// ---------------------------------------------------------------------------

// ============================================================================
// Token estimation (see contextBudget.ts → estimateTokensFromText)
// ============================================================================

/** Back-compat fallback chars-per-token ratio. Hot path uses multi-script estimator instead. */
export const DEFAULT_CHARS_PER_TOKEN = 2.5;

/** Fixed structural overhead (type/function/name keys) added per tool definition. */
export const TOOL_STRUCTURAL_OVERHEAD = 12;

// ============================================================================
// Compression policy — global
// ============================================================================

/** Below this count of old messages, skip summarization and truncate instead. */
export const MIN_MESSAGES_TO_SUMMARIZE = 4;

// ============================================================================
// Compression policy — single policy (no tier branching)
// ============================================================================
//
// 2026-era models all have ≥128k context windows and most sessions never hit
// the compression path. One set of knobs works fine for every window size;
// the char-level caps that actually mattered (tool output) now scale with
// budget instead of tier (see computeMaxToolOutputChars).
// ============================================================================

export const COMPRESSION_PARAMS = {
  minRecentMessagesToKeep: 16,
  recentTokensMinRatio: 0.5,
  outputReserveRatio: 0.10,
  softBudgetRatio: 0.85,
} as const;

// ============================================================================
// Tool output caps (see toolCallAnalysis.ts → trim paths at tool-result entry)
// ============================================================================

/**
 * Single char cap for any tool result injected into LLM context, derived from
 * the active model's prompt budget. Roughly: "one tool output should not exceed
 * ~1/8 of the prompt budget, up to 40k chars".
 *
 * Rationale: with 1M-window models the old flat 15k cap was wasteful; with
 * 32k-window models 40k would overflow. Scaling by budget gives the right
 * ceiling for both extremes with no per-tool dispatch.
 */
export function computeMaxToolOutputChars(promptBudgetTokens: number): number {
  const byBudget = Math.floor((promptBudgetTokens * 3.5) / 8);
  return Math.max(4000, Math.min(40000, byBudget));
}

// ============================================================================
// Explicit context (@file / @folder attachments and .cofreerc context rules)
// ============================================================================

export const MAX_CONTEXT_ATTACHMENTS = 8;
export const MIN_ATTACHMENT_BUDGET_TOKENS = 800;
export const MAX_ATTACHMENT_BUDGET_TOKENS = 5000;
export const MAX_FOLDER_SAMPLE_FILES = 4;
export const MAX_RULE_CONTEXT_FILES = 6;
export const MIN_RULE_BUDGET_TOKENS = 400;
export const MAX_RULE_BUDGET_TOKENS = 2400;

// ============================================================================
// Working memory — in-context size limits
// ============================================================================

export const MAX_DISCOVERED_FACTS = 50;
export const MAX_FILE_SUMMARY_CHARS = 200;
export const MAX_RETRIEVED_FILES = 12;
export const MAX_RETRIEVED_FACTS = 10;

// ============================================================================
// Working memory — checkpoint persistence limits (disk, not LLM context)
// ============================================================================

export const CHECKPOINT_WM_MAX_FILE_SUMMARY_CHARS = 2000;
export const CHECKPOINT_WM_MAX_FACT_CONTENT_CHARS = 2000;
export const CHECKPOINT_WM_MAX_FACT_SOURCE_CHARS = 2000;
export const CHECKPOINT_WM_MAX_PROJECT_CONTEXT_CHARS = 8000;

/** Cap on persisted file-content slots (M3). 32k chars ≈ ~8k tokens upper bound. */
export const CHECKPOINT_WM_MAX_FILE_CONTENT_CHARS = 32_000;
/** In-memory cap per file slot — enough for most real source files; bigger files are stored truncated with a marker. */
export const FILE_SLOT_MAX_CONTENT_CHARS = 64_000;

// ============================================================================
// Summarization cache / chunking
// ============================================================================

export const SUMMARY_CACHE_TTL_MS = 10 * 60 * 1000;
export const SUMMARY_CACHE_MAX_ENTRIES = 100;
export const SUMMARY_CHUNK_MAX_CHARS = 8000;
