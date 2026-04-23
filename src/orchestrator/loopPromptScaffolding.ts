/**
 * Tool-loop prompt scaffolding: pinned system-note maintenance for
 * working-memory, todo-plan, and workspace-refresh notes, plus the
 * async workspace-context refresher.
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

export const WORKING_MEMORY_NOTE_PREFIX = "[工作记忆刷新]";
export const WORKSPACE_REFRESH_NOTE_PREFIX = "[工作区上下文更新]";

/**
 * Remove stale interstitial system messages that accumulate between tool
 * turns.  Keeps only the most recent N system messages outside of the
 * pinned prefix and the final block.
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
      !msg.content.startsWith(WORKING_MEMORY_NOTE_PREFIX)
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

/**
 * Replace-or-insert a single system message identified by a prefix. All
 * older copies with the same prefix are removed first, then the new
 * content is inserted near the initial system-prefix block so the note
 * stays pinned to the top of the conversation.
 */
export function upsertPinnedSystemMessage(params: {
  messages: LiteLLMMessage[];
  prefix: string;
  content: string;
  insertionIndex?: number;
}): void {
  for (let index = params.messages.length - 1; index >= 0; index -= 1) {
    const message = params.messages[index];
    if (
      message.role === "system"
      && typeof message.content === "string"
      && message.content.startsWith(params.prefix)
    ) {
      params.messages.splice(index, 1);
    }
  }

  const normalizedContent = params.content.trim();
  if (!normalizedContent) {
    return;
  }

  const currentPrefixLen = initialSystemPrefixLength(params.messages);
  const requestedIndex =
    typeof params.insertionIndex === "number" && Number.isFinite(params.insertionIndex)
      ? Math.floor(params.insertionIndex)
      : currentPrefixLen;
  const insertAt = Math.max(0, Math.min(currentPrefixLen, requestedIndex));

  params.messages.splice(insertAt, 0, {
    role: "system",
    content: normalizedContent,
  });
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

  if (!memoryContext.trim()) {
    return;
  }

  upsertPinnedSystemMessage({
    messages: params.messages,
    prefix: WORKING_MEMORY_NOTE_PREFIX,
    content: `${WORKING_MEMORY_NOTE_PREFIX}\n${memoryContext}`,
  });
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
}): Promise<void> {
  const { messages, workspacePath, projectConfig, normalizedPrompt, sessionFocusedPaths, turnNumber } = params;

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

      const contextLimit = 128000; // Use default context limit
      const repoMapBudget = Math.min(
        4000,
        Math.max(500, Math.floor(contextLimit * 0.03)),
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
    // Inject the refreshed context as a system message
    upsertPinnedSystemMessage({
      messages,
      prefix: WORKSPACE_REFRESH_NOTE_PREFIX,
      content: `${WORKSPACE_REFRESH_NOTE_PREFIX}\n${refreshNote}`,
    });
    console.log(`[Workspace Refresh] Context refreshed at turn ${turnNumber}`);
  }
}
