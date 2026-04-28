/**
 * Tool-loop prompt scaffolding: tail-pinned system-slot maintenance for the
 * dynamic context (working-memory) plus pruning of tail-appended transient
 * reminders.
 *
 *
 * Tail-pinned slots are placed AFTER the conversation history. pi-ai's
 * adapter (see `toPiAiContext` in piAiBridge.ts) converts any system message
 * that follows a non-system message into a `[System] ...` user message. As a
 * result, tail-pinned slots never enter the cacheable system-prompt prefix —
 * keeping working-memory churn from invalidating the prefix cache. This was
 * a deliberate trade-off (vs head-pinned slots) made to recover OpenAI
 * prompt-cache hit rate, which collapsed to ~20% under head-pinned churn.
 *
 * Pinned slots maintain a deterministic relative order (PINNED_SLOT_ORDER):
 * identical content always lands in the same relative position regardless
 * of which slot was set first this turn. This byte-stability is what lets
 * the cache survive when neither slot's content changed.
 *
 * Kept separate from `src/agents/promptAssembly.ts` (which builds the
 * initial static agent prompt) — this module mutates the live `messages`
 * array as the tool loop runs.
 */

import type { LiteLLMMessage } from "../lib/piAiBridge";
import {
  serializeWorkingMemory,
  type WorkingMemory,
} from "./workingMemory";

export const PINNED_SLOT_KEYS = {
  WORKING_MEMORY: "[工作记忆刷新]",
} as const;

export type PinnedSlotKey =
  (typeof PINNED_SLOT_KEYS)[keyof typeof PINNED_SLOT_KEYS];

/**
 * Declared insertion order (low → high). When `setPinnedSlot` runs, the new
 * slot is placed AFTER any existing slot with a lower-or-equal order, and
 * BEFORE any with a higher order. This means a turn that sets WORKING_MEMORY
 * ends up byte-identical to a turn that sets them
 * in the other order — required for cache hit stability.
 */
const PINNED_SLOT_ORDER: ReadonlyArray<PinnedSlotKey> = [
  PINNED_SLOT_KEYS.WORKING_MEMORY,
];

/** Back-compat re-export — original consumers may import these. */
export const WORKING_MEMORY_NOTE_PREFIX = PINNED_SLOT_KEYS.WORKING_MEMORY;

const PINNED_KEY_PREFIXES: ReadonlyArray<string> = Object.values(PINNED_SLOT_KEYS);

function findExistingSlotKey(content: string): string | undefined {
  return PINNED_KEY_PREFIXES.find((k) => content.startsWith(k));
}

/**
 * Idempotently set a tail-pinned system slot identified by its key prefix.
 * Removes any existing message with the same prefix, then appends the new
 * content at the tail of the message list, preserving PINNED_SLOT_ORDER
 * across multiple slots. Empty content clears the slot.
 *
 * The slot lives at the tail so it does not enter the cacheable system-prompt
 * prefix (pi-ai re-tags trailing system messages as `[System] ...` user
 * messages). As long as the conversation history before the slot is
 * unchanged, OpenAI / Anthropic prefix caches remain warm even when this
 * slot's content churns.
 */
export function setPinnedSlot(
  messages: LiteLLMMessage[],
  key: PinnedSlotKey,
  content: string,
): void {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role === "system" && typeof m.content === "string" && m.content.startsWith(key)) {
      messages.splice(i, 1);
    }
  }

  const trimmed = content.trim();
  if (!trimmed) {
    return;
  }

  const myOrder = PINNED_SLOT_ORDER.indexOf(key);
  let insertAt = messages.length;

  // Walk back from the tail through the contiguous run of pinned slots.
  // Insert just before any higher-order slot we find (so they remain in
  // PINNED_SLOT_ORDER); stop once we hit a slot of equal-or-lower order
  // or any non-slot message (conversation history).
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.role !== "system" || typeof msg.content !== "string") break;
    const matchedKey = findExistingSlotKey(msg.content);
    if (!matchedKey) break;
    const matchedOrder = PINNED_SLOT_ORDER.indexOf(matchedKey as PinnedSlotKey);
    if (matchedOrder > myOrder) {
      insertAt = i;
    } else {
      break;
    }
  }

  messages.splice(insertAt, 0, { role: "system", content: trimmed });
}

/**
 * M3: replace older read_file tool results in the message stream with stubs
 * for any path whose current content is cached in working memory. The most
 * recent read_file result for each path is left untouched (it provided the
 * snapshot the LLM is currently reasoning about); earlier copies become
 * "[文件 X 已重新读取，旧版本省略]" so the same content body never sits in the
 * conversation more than once.
 *
 * If a path has been invalidated (apply_patch dropped its cached content),
 * older read_file results for that path are rewritten to a stale-warning
 * stub so the LLM doesn't act on outdated bytes.
 *
 * Returns the number of messages rewritten.
 */
export function dedupeStaleFileReads(
  messages: LiteLLMMessage[],
  workingMemory: WorkingMemory,
): number {
  if (workingMemory.fileKnowledge.size === 0) return 0;

  // Walk back-to-front to find each path's MOST RECENT read_file tool result.
  const seenLatestPerPath = new Map<string, number>();
  const readFileResults: Array<{ index: number; path: string }> = [];

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.role !== "tool" || !msg.content) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(msg.content);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const obj = parsed as Record<string, unknown>;
    const path = typeof obj.relative_path === "string" ? obj.relative_path.trim() : "";
    if (!path) continue;
    const hasContentPreview =
      typeof obj.content_preview === "string" && obj.content_preview.length > 0;
    if (!hasContentPreview) continue;
    if (obj.ok !== true) continue;

    if (!seenLatestPerPath.has(path)) {
      seenLatestPerPath.set(path, i);
    }
    readFileResults.push({ index: i, path });
  }

  let rewriteCount = 0;
  for (const { index, path } of readFileResults) {
    const fk = workingMemory.fileKnowledge.get(path);
    if (!fk) continue;
    const isLatest = seenLatestPerPath.get(path) === index;
    if (isLatest && fk.content) {
      // Latest read AND content still cached — keep the original message.
      continue;
    }

    let stubMessage: string;
    if (!fk.content) {
      // Slot was invalidated (apply_patch). All copies — including the latest —
      // are now stale.
      stubMessage =
        `文件 ${path} 已被修改（apply_patch 通过）。此次旧读取的内容已过时，` +
        `如需最新版本请重新调用 read_file。`;
    } else {
      stubMessage =
        `文件 ${path} 已重新读取，旧版本省略以避免重复占用 context。` +
        `如需查看当前内容请参考工作记忆 slot 或重新 read_file。`;
    }

    const stubEnvelope = JSON.stringify({
      ok: true,
      relative_path: path,
      stale: true,
      hint: stubMessage,
    });
    if (messages[index].content !== stubEnvelope) {
      messages[index] = { ...messages[index], content: stubEnvelope };
      rewriteCount += 1;
    }
  }

  return rewriteCount;
}

/**
 * Remove stale tail-appended system reminders (efficiency warnings, turn-count
 * notes) that accumulate between tool turns. Keeps only the most recent N
 * post-prefix system messages. Head-pinned slots are protected by
 * `pinnedPrefixLen`; the working-memory slot is additionally whitelisted in
 * case it has fallen out of the head prefix.
 */
export function pruneStaleSystemMessages(
  messages: LiteLLMMessage[],
  pinnedPrefixLen: number,
  maxInterstitialSystemMsgs: number,
): LiteLLMMessage[] {
  const interstitialIndices: number[] = [];

  for (let i = pinnedPrefixLen; i < messages.length; i++) {
    const msg = messages[i];
    if (
      msg.role === "system" &&
      !msg.content.startsWith(PINNED_SLOT_KEYS.WORKING_MEMORY)
    ) {
      interstitialIndices.push(i);
    }
  }

  if (interstitialIndices.length <= maxInterstitialSystemMsgs) {
    return messages;
  }

  const toRemove = new Set(
    interstitialIndices.slice(0, interstitialIndices.length - maxInterstitialSystemMsgs),
  );

  return messages.filter((_, idx) => !toRemove.has(idx));
}

export function upsertWorkingMemoryContextMessage(params: {
  messages: LiteLLMMessage[];
  workingMemory: WorkingMemory;
  tokenBudget: number;
  query: string;
  focusedPaths?: string[];
}): void {
  const memoryContext = serializeWorkingMemory(
    params.workingMemory,
    params.tokenBudget,
    {
      query: params.query,
      focusedPaths: params.focusedPaths,
    },
  );

  const trimmed = memoryContext.trim();
  setPinnedSlot(
    params.messages,
    PINNED_SLOT_KEYS.WORKING_MEMORY,
    trimmed ? `${PINNED_SLOT_KEYS.WORKING_MEMORY}\n${trimmed}` : "",
  );
}

/**
 * Build working memory content string (returns instead of injecting).
 * Used by the context note buffer for cache-friendly delivery.
 */
export function buildWorkingMemoryContent(params: {
  workingMemory: WorkingMemory;
  tokenBudget: number;
  query: string;
  focusedPaths?: string[];
}): string {
  const memoryContext = serializeWorkingMemory(
    params.workingMemory,
    params.tokenBudget,
    {
      query: params.query,
      focusedPaths: params.focusedPaths,
    },
  );
  const trimmed = memoryContext.trim();
  return trimmed ? `${PINNED_SLOT_KEYS.WORKING_MEMORY}\n${trimmed}` : "";
}

