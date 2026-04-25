/**
 * Tool-loop prompt scaffolding: pinned system-slot maintenance for the head
 * prefix block (working-memory, workspace-refresh) plus pruning of
 * tail-appended transient reminders, plus the async workspace-context
 * refresher.
 *
 * Head pinned slots have a deterministic order (PINNED_SLOT_ORDER): identical
 * slot content always lands at the same byte offset regardless of which slot
 * was set first this turn. This byte-stability is the prerequisite for prompt
 * caching (M1) — Anthropic / OpenAI cache hits depend on the cached prefix
 * being unchanged across turns.
 *
 * Kept separate from `src/agents/promptAssembly.ts` (which builds the
 * initial static agent prompt) — this module mutates the live `messages`
 * array as the tool loop runs.
 */

import type { LiteLLMMessage } from "../lib/piAiBridge";
import { initialSystemPrefixLength } from "./contextBudget";
import {
  serializeWorkingMemory,
  type WorkingMemory,
} from "./workingMemory";
import {
  type CofreeRcConfig,
} from "../lib/cofreerc";
import {
  summarizeWorkspaceFiles,
  type WorkspaceOverviewBudget,
} from "./readOnlyWorkspaceService";
import { clearRepoMapCaches, generateRepoMap } from "./repoMapService";

export const PINNED_SLOT_KEYS = {
  WORKSPACE_REFRESH: "[工作区上下文更新]",
  WORKING_MEMORY: "[工作记忆刷新]",
} as const;

export type PinnedSlotKey =
  (typeof PINNED_SLOT_KEYS)[keyof typeof PINNED_SLOT_KEYS];

/**
 * Declared insertion order (low → high). When `setPinnedSlot` runs, the new
 * slot is placed AFTER any existing slot with a lower-or-equal order, and
 * BEFORE any with a higher order. This means a turn that sets WORKING_MEMORY
 * before WORKSPACE_REFRESH ends up byte-identical to a turn that sets them
 * in the other order — required for cache hit stability.
 */
const PINNED_SLOT_ORDER: ReadonlyArray<PinnedSlotKey> = [
  PINNED_SLOT_KEYS.WORKSPACE_REFRESH,
  PINNED_SLOT_KEYS.WORKING_MEMORY,
];

/** Back-compat re-export — original consumers may import these. */
export const WORKING_MEMORY_NOTE_PREFIX = PINNED_SLOT_KEYS.WORKING_MEMORY;
export const WORKSPACE_REFRESH_NOTE_PREFIX = PINNED_SLOT_KEYS.WORKSPACE_REFRESH;

const PINNED_KEY_PREFIXES: ReadonlyArray<string> = Object.values(PINNED_SLOT_KEYS);

function findExistingSlotKey(content: string): string | undefined {
  return PINNED_KEY_PREFIXES.find((k) => content.startsWith(k));
}

/**
 * Idempotently set a head-pinned system slot identified by its key prefix.
 * Removes any existing message with the same prefix, then inserts the new
 * content at the canonical position determined by PINNED_SLOT_ORDER. Empty
 * content clears the slot.
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
  const headEnd = initialSystemPrefixLength(messages);
  let insertAt = headEnd;

  // Walk the head system block; place the new slot before the first existing
  // slot whose order is strictly higher than ours. Non-slot system messages
  // (initial agent prompt, runtime context) are left at the very front.
  for (let i = 0; i < headEnd; i += 1) {
    const msg = messages[i];
    const matchedKey = findExistingSlotKey(msg.content);
    if (!matchedKey) continue;
    const matchedOrder = PINNED_SLOT_ORDER.indexOf(matchedKey as PinnedSlotKey);
    if (matchedOrder >= 0 && matchedOrder > myOrder) {
      insertAt = i;
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
 * Refresh workspace context (overview + repo-map) and inject as a system
 * message. This allows the LLM to see updated workspace state after file
 * modifications.
 */
export async function refreshWorkspaceContext(params: {
  messages: LiteLLMMessage[];
  workspacePath: string;
  projectConfig: CofreeRcConfig;
  normalizedPrompt: string;
  sessionFocusedPaths: string[];
  turnNumber: number;
  contextLimitTokens: number;
}): Promise<void> {
  const {
    messages,
    workspacePath,
    projectConfig,
    normalizedPrompt,
    sessionFocusedPaths,
    turnNumber,
    contextLimitTokens,
  } = params;

  let refreshNote = "";

  // Refresh workspace overview
  try {
    const overviewBudget: WorkspaceOverviewBudget | undefined = projectConfig.overviewBudget;
    const overview = await summarizeWorkspaceFiles(
      workspacePath,
      projectConfig.ignorePatterns && projectConfig.ignorePatterns.length > 0
        ? projectConfig.ignorePatterns
        : null,
      overviewBudget
    );
    const overviewPrompt = `项目概览（已更新）：\n${overview}`;
    refreshNote = overviewPrompt;
  } catch (e) {
    console.warn("[Workspace Refresh] Failed to regenerate workspace overview", e);
  }

  // Clear repo-map cache and regenerate
  if (projectConfig.repoMap?.enabled !== false) {
    try {
      // Force cache invalidation to get fresh data
      clearRepoMapCaches();

      const repoMapBudget = Math.min(
        4000,
        Math.max(500, Math.floor(contextLimitTokens * 0.03)),
      );
      const repoMap = await generateRepoMap(
        workspacePath,
        projectConfig.ignorePatterns && projectConfig.ignorePatterns.length > 0
          ? projectConfig.ignorePatterns
          : null,
        projectConfig.repoMap?.tokenBudget ?? repoMapBudget,
        {
          taskDescription: normalizedPrompt,
          prioritizedPaths: sessionFocusedPaths,
          maxFiles: projectConfig.repoMap?.maxFiles,
        },
      );
      if (repoMap) {
        refreshNote = refreshNote ? `${refreshNote}\n\n${repoMap}` : repoMap;
        console.log(
          `[Workspace Refresh] Repo-map regenerated at turn ${turnNumber} (~${repoMap.length} chars)`,
        );
      }
    } catch (e) {
      console.warn("[Workspace Refresh] Failed to regenerate repo-map", e);
    }
  }

  if (refreshNote) {
    setPinnedSlot(
      messages,
      PINNED_SLOT_KEYS.WORKSPACE_REFRESH,
      `${PINNED_SLOT_KEYS.WORKSPACE_REFRESH}\n${refreshNote}`,
    );
    console.log(`[Workspace Refresh] Context refreshed at turn ${turnNumber}`);
  }
}
