/**
 * Cofree - AI Programming Cafe
 * File: src/orchestrator/planningService.ts
 * Milestone: 3
 * Task: 3.5
 * Status: In Progress
 * Owner: Codex-GPT-5
 * Last Modified: 2026-03-01
 * Description: Native tool-calling orchestration loop with explicit HITL gate generation.
 */

import { invoke } from "@tauri-apps/api/core";
import { recordLLMAudit } from "../lib/auditLog";
import {
  gatewaySummarize,
  type LiteLLMMessage,
  type LiteLLMToolDefinition,
} from "../lib/piAiBridge";
import {
  DEFAULT_TOOL_PERMISSIONS,
  isActiveModelLocal,
  getActiveVendor,
  getActiveManagedModel,
  resolveEffectiveContextTokenLimit,
  type AppSettings,
  type ToolPermissions,
} from "../lib/settingsStore";
import type {
  ActionProposal,
  ApplyPatchActionProposal,
  OrchestrationPlan,
  PlanStep,
} from "./types";
import {
  addPlanStep,
  appendPlanStepNote,
  attachActionToPlanStep,
  buildTodoSystemPrompt,
  clonePlanState,
  derivePlanWorkflowState,
  formatTodoPlanBlock,
  normalizeTodoPlanState,
  setActivePlanStep,
  setPlanStepStatus,
  syncPlanStateWithActions,
  type TodoPlanState,
} from "./todoPlanState";
import {
  summarizeWorkspaceFiles,
  type WorkspaceOverviewBudget,
} from "./readOnlyWorkspaceService";
import {
  loadCofreeRc,
  buildCofreeRcPromptFragment,
  type CofreeRcConfig,
} from "../lib/cofreerc";
import { generateRepoMap, clearRepoMapCaches } from "./repoMapService";
import { buildExplicitContextNote } from "./explicitContextService";
import { SummaryCache } from "../lib/summaryCache";
import {
  clearOldToolUses,
  compressMessagesToFitBudget,
  estimateTokensForToolDefinitions,
  initialSystemPrefixLength,
  MessageTokenTracker,
  updateTokenCalibration,
} from "./contextBudget";
import type {
  ResolvedAgentRuntime,
  ConversationAgentBinding,
} from "../agents/types";
import { resolveAgentRuntime } from "../agents/resolveAgentRuntime";
import { assembleSystemPrompt, assembleRuntimeContext } from "../agents/promptAssembly";
import {
  matchSkills,
  resolveSkills,
  discoverGlobalSkills,
  discoverWorkspaceSkills,
  mergeDiscoveredSkills,
  type SkillEntry,
  type ResolvedSkill,
} from "../lib/skillStore";
import { convertCofreeRcSkillEntries } from "../lib/cofreerc";
import type { ChatContextAttachment } from "../lib/contextAttachments";
import { runWithConcurrencyLimit } from "../lib/concurrency";
import {
  executeToolCompletionForTurn,
  sanitizeMessagesForToolCalling,
  type RequestRecord,
  type ToolCallRecord,
} from "./llmToolLoop";
import {
  detectPseudoToolCallNarration,
  detectPseudoToolJsonTranscript,
  summarizeToolArgs,
  trimToolContentForContext,
} from "./toolCallAnalysis";
import {
  buildCreatePathRepairMessage,
  buildPatchPreflightRepairMessage,
  buildPseudoToolCallCompatibilityDiagnostic,
  buildPseudoToolCallRepairMessage,
  buildReadOnlyTurnsWarningMessage,
  buildSameFileEditFailureMessage,
  buildSearchNotFoundRepairMessage,
  buildShellDialectRepairInstruction,
  buildToolNotFoundWarningMessage,
  shouldForceReadOnlySummary,
  shouldRetryPseudoToolCall,
  shouldStopForConsecutiveFailures,
  shouldStopForToolNotFound,
  shouldWarnForToolNotFound,
  MAX_CREATE_HINT_REPAIR_ROUNDS,
  MAX_PATCH_REPAIR_ROUNDS,
  MAX_SAME_FILE_EDIT_FAILURES,
  MAX_SEARCH_NOT_FOUND_REPAIR_ROUNDS,
  MAX_SHELL_DIALECT_REPAIR_ROUNDS,
} from "./repairPolicies";
import {
  executeToolCall as executeToolCallInternal,
  executeToolCallWithRetry as executeToolCallWithRetryInternal,
  type SensitiveWriteAutoExecutionPolicy,
  type ToolExecutionResult,
  type ToolExecutorDeps,
} from "./toolExecutor";
import type {
  ToolExecutionStatus,
  ToolExecutionTrace,
} from "./toolTraceTypes";
import {
  createWorkingMemory,
  restoreWorkingMemory,
  extractFileKnowledge,
  serializeWorkingMemory,
  snapshotWorkingMemory,
  type WorkingMemory,
  type WorkingMemorySnapshot,
} from "./workingMemory";
import type { AskUserRequest } from "./askUserService";

const TOOL_LOOP_CHECKPOINT_TURNS = 50;
const TOOL_LOOP_EFFICIENCY_WARNING_THRESHOLD = 40;


// --- Phase 4: Context management budgets ---
const SUMMARY_CACHE_TTL_MS = 10 * 60 * 1000;
const SUMMARY_CACHE_MAX_ENTRIES = 100;
const BASE_SUMMARY_COOLDOWN_MS = 120 * 1000;

const MIN_MESSAGES_TO_SUMMARIZE = 4;

// --- Context Editing: proactive tool-use eviction (defaults for small windows) ---
const CONTEXT_EDIT_CLEAR_AT_LEAST = 3;

// ---------------------------------------------------------------------------
// Adaptive compression parameters based on model context window size.
// Large-window models (>= 100k) can afford much more relaxed thresholds;
// small-window models (<32k) need the aggressive defaults.
// ---------------------------------------------------------------------------

interface AdaptiveCompressionParams {
  toolMessageMaxChars: number;
  minRecentMessagesToKeep: number;
  recentTokensMinRatio: number;
  contextEditTriggerTokenRatio: number;
  contextEditKeepRecentTurns: number;
  contextEditTriggerEveryNTurns: number;
  outputReserveRatio: number;
  softBudgetRatio: number;
  compressionSafeZoneRatio: number;
}

function computeAdaptiveCompressionParams(limitTokens: number): AdaptiveCompressionParams {
  if (limitTokens >= 100_000) {
    return {
      toolMessageMaxChars: 8000,
      minRecentMessagesToKeep: 20,
      recentTokensMinRatio: 0.5,
      contextEditTriggerTokenRatio: 0.92,
      contextEditKeepRecentTurns: 16,
      contextEditTriggerEveryNTurns: 16,
      outputReserveRatio: 0.10,
      softBudgetRatio: 0.95,
      compressionSafeZoneRatio: 0.72,
    };
  }
  if (limitTokens >= 32_000) {
    return {
      toolMessageMaxChars: 5000,
      minRecentMessagesToKeep: 12,
      recentTokensMinRatio: 0.45,
      contextEditTriggerTokenRatio: 0.88,
      contextEditKeepRecentTurns: 10,
      contextEditTriggerEveryNTurns: 12,
      outputReserveRatio: 0.12,
      softBudgetRatio: 0.92,
      compressionSafeZoneRatio: 0.68,
    };
  }
  return {
    toolMessageMaxChars: 3000,
    minRecentMessagesToKeep: 8,
    recentTokensMinRatio: 0.4,
    contextEditTriggerTokenRatio: 0.85,
    contextEditKeepRecentTurns: 8,
    contextEditTriggerEveryNTurns: 8,
    outputReserveRatio: 0.15,
    softBudgetRatio: 0.9,
    compressionSafeZoneRatio: 0.62,
  };
}

function evaluateCompressionSafeZone(params: {
  tokenTracker: MessageTokenTracker;
  messages: LiteLLMMessage[];
  promptBudgetTarget: number;
  safeZoneRatio: number;
}): { currentTokens: number; compressionSafeZone: number; skipCompression: boolean } {
  const currentTokens = params.tokenTracker.update(params.messages);
  const compressionSafeZone = params.promptBudgetTarget * params.safeZoneRatio;
  return {
    currentTokens,
    compressionSafeZone,
    skipCompression: currentTokens <= compressionSafeZone,
  };
}

// P2-2: Dynamic cooldown state — tracks token growth to adjust cooldown.
// Capped at MAX_TRACKED_WORKSPACES to prevent unbounded memory growth.
const MAX_TRACKED_WORKSPACES = 20;
const TRACKER_STALE_MS = 30 * 60 * 1000; // evict entries idle for >30 min

const tokenGrowthTracker = new Map<string, { timestamps: number[]; tokenCounts: number[] }>();

function evictStaleTrackers(now: number): void {
  if (tokenGrowthTracker.size <= MAX_TRACKED_WORKSPACES) return;

  for (const [key, tracker] of tokenGrowthTracker) {
    const lastTs = tracker.timestamps[tracker.timestamps.length - 1] ?? 0;
    if (now - lastTs > TRACKER_STALE_MS) {
      tokenGrowthTracker.delete(key);
    }
  }

  // Hard cap: if still over limit, remove oldest entries.
  while (tokenGrowthTracker.size > MAX_TRACKED_WORKSPACES) {
    const oldestKey = tokenGrowthTracker.keys().next().value as string | undefined;
    if (!oldestKey) break;
    tokenGrowthTracker.delete(oldestKey);
  }
}

function computeDynamicCooldownMs(workspacePath: string | undefined, currentTokens: number): number {
  const ws = workspacePath?.trim() || "";
  if (!ws) return BASE_SUMMARY_COOLDOWN_MS;

  const now = Date.now();
  evictStaleTrackers(now);

  let tracker = tokenGrowthTracker.get(ws);
  if (!tracker) {
    tracker = { timestamps: [], tokenCounts: [] };
    tokenGrowthTracker.set(ws, tracker);
  }

  tracker.timestamps.push(now);
  tracker.tokenCounts.push(currentTokens);

  // Keep only the last 10 samples
  while (tracker.timestamps.length > 10) {
    tracker.timestamps.shift();
    tracker.tokenCounts.shift();
  }

  if (tracker.timestamps.length < 2) return BASE_SUMMARY_COOLDOWN_MS;

  const timeDelta = tracker.timestamps[tracker.timestamps.length - 1] - tracker.timestamps[0];
  const tokenDelta = tracker.tokenCounts[tracker.tokenCounts.length - 1] - tracker.tokenCounts[0];

  if (timeDelta <= 0) return BASE_SUMMARY_COOLDOWN_MS;

  const growthRate = tokenDelta / (timeDelta / 1000);

  if (growthRate > 500) return 45_000;
  if (growthRate > 200) return 60_000;
  return BASE_SUMMARY_COOLDOWN_MS;
}

// P1-2: Max chars per chunk for map-reduce summarization
const SUMMARY_CHUNK_MAX_CHARS = 8000;

const MAX_MULTI_ARTIFACT_REMINDER_ROUNDS = 2;
const MAX_PROPOSED_ACTIONS_PER_BATCH = 5;


const MAX_LLM_REQUEST_RETRIES = 3;
const LLM_RETRY_BASE_DELAY_MS = 1000;
const LLM_RETRY_MAX_DELAY_MS = 15000;

const INCREMENTAL_CHECKPOINT_INTERVAL = 10;
const MAX_ABSOLUTE_TURNS = 150;

const WORKING_MEMORY_NOTE_PREFIX = "[工作记忆刷新]";
const TODO_PLAN_NOTE_PREFIX = "[Todo Plan]";
const WORKING_MEMORY_REFRESH_INTERVAL = 6;

// --- Tool-calling reinforcement interval ---
const TOOL_CALLING_REINFORCEMENT_INTERVAL = 20;
const TOOL_CALLING_REINFORCEMENT_NOTE_PREFIX = "[工具调用提醒]";

function computeWorkingMemoryFingerprint(wm: WorkingMemory): string {
  return `${wm.fileKnowledge.size}`;
}


/**
 * Remove stale interstitial system messages that accumulate between tool
 * turns.  Keeps only the most recent N system messages outside of the
 * pinned prefix and the final block.
 */
function pruneStaleSystemMessages(
  messages: LiteLLMMessage[],
  pinnedPrefixLen: number,
  maxInterstitialSystemMsgs: number,
): LiteLLMMessage[] {
  const interstitialIndices: number[] = [];

  for (let i = pinnedPrefixLen; i < messages.length; i++) {
    const msg = messages[i];
    if (
      msg.role === "system" &&
      !msg.content.startsWith(WORKING_MEMORY_NOTE_PREFIX) &&
      !msg.content.startsWith(TODO_PLAN_NOTE_PREFIX)
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
 * Find the nearest line boundary before or at the given index.
 */
function truncateAtLineEnd(content: string, maxIndex: number): number {
  if (maxIndex >= content.length) return content.length;
  const lastNewline = content.lastIndexOf("\n", maxIndex);
  return lastNewline >= 0 ? lastNewline + 1 : maxIndex;
}

/**
 * Find the nearest line boundary after or at the given index.
 */
function truncateAtLineStart(content: string, minIndex: number): number {
  if (minIndex <= 0) return 0;
  const nextNewline = content.indexOf("\n", minIndex);
  return nextNewline >= 0 ? nextNewline + 1 : minIndex;
}

/**
 * Smart truncation that preserves both head and tail of content.
 * Truncates from the middle while respecting line boundaries.
 * @param content The string to truncate
 * @param maxLength Maximum allowed length
 * @param headRatio Ratio of head content to preserve (0-1), defaults to 0.5
 */
function smartTruncate(
  content: string,
  maxLength: number,
  headRatio = 0.5
): string {
  if (content.length <= maxLength) return content;

  const ellipsis = "\n\n...[已截断中间部分]...\n\n";
  const availableLength = maxLength - ellipsis.length;
  if (availableLength <= 0) return content.slice(0, maxLength);

  const headTarget = Math.floor(availableLength * headRatio);
  const tailTarget = availableLength - headTarget;

  const headEnd = truncateAtLineEnd(content, headTarget);
  const tailStart = truncateAtLineStart(content, content.length - tailTarget);

  // Avoid overlap
  if (headEnd >= tailStart) {
    return content.slice(0, maxLength);
  }

  return content.slice(0, headEnd) + ellipsis + content.slice(tailStart);
}

function upsertPinnedSystemMessage(params: {
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

function upsertWorkingMemoryContextMessage(params: {
  messages: LiteLLMMessage[];
  workingMemory: WorkingMemory;
  tokenBudget: number;
  query: string;
  focusedPaths?: string[];
}): void {
  const memoryContext = serializeWorkingMemory(
    params.workingMemory,
    params.tokenBudget,
    undefined,
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

const WORKSPACE_REFRESH_NOTE_PREFIX = "[工作区上下文更新]";

/**
 * Refresh workspace context (overview + repo-map) and inject as a system message.
 * This allows the LLM to see updated workspace state after file modifications.
 */
async function refreshWorkspaceContext(params: {
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

function upsertTodoPlanContextMessage(messages: LiteLLMMessage[], planState: TodoPlanState): string {
  const todoPrompt = buildTodoSystemPrompt(planState);
  upsertPinnedSystemMessage({
    messages,
    prefix: TODO_PLAN_NOTE_PREFIX,
    content: todoPrompt,
    insertionIndex: 2,
  });
  return todoPrompt;
}

function normalizeFocusedPathList(paths: string[] | undefined): string[] {
  return [...new Set(
    (paths ?? [])
      .map((path) => path.trim().replace(/\\/g, "/").replace(/^\/+/, ""))
      .filter(Boolean),
  )];
}



const INTERNAL_TOOL_NAMES = ["update_plan"] as const;

interface InitialPlanSeed extends TodoPlanState {
  source: "fallback" | "planner" | "existing";
}



const TOOL_DEFINITIONS: LiteLLMToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "list_files",
      description:
        "List files and directories under a workspace-relative path. Returns name, type, size, modification time. Up to 120 entries.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          relative_path: {
            type: "string",
            description:
              "Workspace-relative directory path. Empty means workspace root.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a text file. Returns content with line number prefixes ('行号│内容'), total_lines, showing_lines. " +
        "Line number prefixes are display-only — do NOT include them in propose_file_edit search/anchor. " +
        "Large files (400+ lines): use start_line/end_line to read in ~300-line segments.",
      parameters: {
        type: "object",
        required: ["relative_path"],
        additionalProperties: false,
        properties: {
          relative_path: {
            type: "string",
            minLength: 1,
            description: "Workspace-relative file path.",
          },
          start_line: {
            type: "number",
            minimum: 1,
            description: "1-based start line for partial read.",
          },
          end_line: {
            type: "number",
            minimum: 1,
            description: "1-based end line (inclusive) for partial read.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_status",
      description:
        "Get git status: modified, staged, untracked, deleted files. Returns empty for non-git directories.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_diff",
      description:
        "Get unified diff of uncommitted changes. Optionally filter to a single file. Returns empty for non-git directories.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          file_path: {
            type: "string",
            description: "Optional file path to filter diff.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description:
        "Search file contents using regex. Returns matching lines with file paths and line numbers. " +
        "Use BEFORE read_file to locate code. Auto-excludes .git, node_modules, target, dist, build.",
      parameters: {
        type: "object",
        required: ["pattern"],
        additionalProperties: false,
        properties: {
          pattern: {
            type: "string",
            minLength: 1,
            description: "Regex pattern to search for.",
          },
          include_glob: {
            type: "string",
            description: "Optional glob to restrict search (e.g. '*.ts').",
          },
          max_results: {
            type: "number",
            minimum: 1,
            maximum: 200,
            description: "Max matching lines. Defaults to 50.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob",
      description:
        "Find files by glob pattern. Returns paths sorted by modification time. Auto-excludes .git, node_modules, etc.",
      parameters: {
        type: "object",
        required: ["pattern"],
        additionalProperties: false,
        properties: {
          pattern: {
            type: "string",
            minLength: 1,
            description: "Glob pattern (e.g. '**/*.tsx', 'src/**/*.test.ts').",
          },
          max_results: {
            type: "number",
            minimum: 1,
            maximum: 500,
            description: "Max files to return. Defaults to 100.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_apply_patch",
      description:
        "Submit a SINGLE-FILE unified diff patch for HITL approval. Use only when explicit patch is requested. Multi-file patches rejected.",
      parameters: {
        type: "object",
        required: ["patch"],
        additionalProperties: false,
        properties: {
          patch: {
            type: "string",
            description:
              "Unified diff for ONE file. Must include 'diff --git' header. New files: '--- /dev/null'. Deletes: '+++ /dev/null'.",
          },
          description: {
            type: "string",
            description: "Optional description.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_file_edit",
      description: [
        "Propose a single-file text edit for HITL approval. Operations:",
        "- REPLACE (default): relative_path + (search OR start_line/end_line) + replace/content",
        "- INSERT: operation='insert', content + (anchor OR line), position='before'|'after'",
        "- DELETE: operation='delete' + (search OR start_line/end_line)",
        "- CREATE: operation='create', content (+ overwrite=true to overwrite existing)",
        "",
        "Rules: search/anchor must exactly match file content (no line number prefixes '行号│'). relative_path is REQUIRED.",
      ].join("\n"),
      parameters: {
        type: "object",
        required: ["relative_path"],
        additionalProperties: false,
        properties: {
          relative_path: {
            type: "string",
            minLength: 1,
            description: "Workspace-relative file path.",
          },
          operation: {
            type: "string",
            enum: ["replace", "insert", "delete", "create"],
            description:
              "Edit operation. Defaults to 'replace' for backward compatibility.",
          },
          search: {
            type: "string",
            description:
              "For replace/delete-in-file: exact snippet to find. For backward-compatible insert, may be used as anchor.",
          },
          replace: {
            type: "string",
            description:
              "For replace: replacement text. For backward-compatible insert/create, may be used as inserted/content text.",
          },
          anchor: {
            type: "string",
            description: "For insert: exact anchor snippet in file.",
          },
          line: {
            type: "number",
            minimum: 1,
            description:
              "For insert: 1-based target line used as insertion anchor.",
          },
          start_line: {
            type: "number",
            minimum: 1,
            description:
              "For replace/delete: optional 1-based start line of the target range.",
          },
          end_line: {
            type: "number",
            minimum: 1,
            description:
              "For replace/delete: optional 1-based end line of the target range.",
          },
          content: {
            type: "string",
            description: "For insert/create: inserted or full file content.",
          },
          position: {
            type: "string",
            enum: ["before", "after"],
            description:
              "For insert: insert before or after anchor. Defaults to 'after'.",
          },
          replace_all: {
            type: "boolean",
            description:
              "For replace: replace all matches. For backward compatibility, also used as generic apply_all flag.",
          },
          apply_all: {
            type: "boolean",
            description:
              "For replace/insert/delete-in-file: apply operation to all matches.",
          },
          overwrite: {
            type: "boolean",
            description:
              "For create: when true and file already exists, update file content instead of failing.",
          },
          description: {
            type: "string",
            description: "Optional short description for reviewers.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_shell",
      description:
        "Propose a shell command for HITL approval. Windows: PowerShell; Unix: sh. " +
        "Non-interactive (stdin=/dev/null, CI=true) — use --yes/-y for prompts. " +
        "Long-running commands auto-move to background after block_until_ms deadline.",
      parameters: {
        type: "object",
        required: ["shell"],
        additionalProperties: false,
        properties: {
          shell: {
            type: "string",
            minLength: 1,
            description: "Shell command. Windows: PowerShell syntax; Unix: POSIX shell.",
          },
          timeout_ms: {
            type: "number",
            minimum: 1000,
            maximum: 600000,
            description: "Hard timeout in ms. Defaults to 120000.",
          },
          block_until_ms: {
            type: "number",
            minimum: 1000,
            maximum: 600000,
            description: "Max wait before moving to background. Auto-inferred by command type.",
          },
          execution_mode: {
            type: "string",
            enum: ["foreground", "background"],
            description: "'background' for dev servers/watchers. Usually auto-detected.",
          },
          ready_url: {
            type: "string",
            description: "URL to probe for background command readiness.",
          },
          ready_timeout_ms: {
            type: "number",
            minimum: 1000,
            maximum: 120000,
            description: "Readiness timeout for background commands. Defaults to 20000.",
          },
          description: {
            type: "string",
            description: "Optional description.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_shell_job",
      description:
        "Check if a background shell job is still running. Returns status, exit_code, stdout, stderr when completed.",
      parameters: {
        type: "object",
        required: ["job_id"],
        additionalProperties: false,
        properties: {
          job_id: {
            type: "string",
            description: "The job_id from propose_shell background result.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_plan",
      description:
        "Update the todo plan: mark steps active/completed/blocked/failed/skipped, add notes, or append new steps. No workspace side effects.",
      parameters: {
        type: "object",
        required: ["operation", "step_id"],
        additionalProperties: false,
        properties: {
          operation: {
            type: "string",
            enum: ["set_active", "complete", "block", "fail", "skip", "note", "add"],
            description: "Operation to perform.",
          },
          step_id: {
            type: "string",
            minLength: 1,
            description: "Target step id.",
          },
          title: {
            type: "string",
            description: "Required for 'add'. Step title.",
          },
          summary: {
            type: "string",
            description: "Optional step summary for 'add'.",
          },
          owner: {
            type: "string",
            enum: ["planner", "coder", "tester", "debugger", "reviewer"],
            description: "Optional owner for 'add'.",
          },
          note: {
            type: "string",
            description: "Optional note.",
          },
          after_step_id: {
            type: "string",
            description: "Insertion anchor for 'add'.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "diagnostics",
      description:
        "Get compilation errors/warnings. Auto-detects project type (TypeScript, Rust, Python, Go).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          changed_files: {
            type: "array",
            items: { type: "string" },
            description: "Optional file paths to filter diagnostics.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch",
      description:
        "Fetch content from a URL. Max 512KB, truncated if larger.",
      parameters: {
        type: "object",
        required: ["url"],
        additionalProperties: false,
        properties: {
          url: {
            type: "string",
            minLength: 1,
            description: "URL to fetch.",
          },
          max_size: {
            type: "number",
            minimum: 1024,
            maximum: 524288,
            description: "Max content size in bytes. Defaults to 512KB.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_user",
      description:
        "Ask the user a question and wait for response. Pauses execution until answered. " +
        "Provide options for multiple-choice. '其他' option auto-appended when options given.",
      parameters: {
        type: "object",
        required: ["question"],
        additionalProperties: false,
        properties: {
          question: {
            type: "string",
            minLength: 1,
            description: "Question to ask.",
          },
          context: {
            type: "string",
            description: "Optional context.",
          },
          options: {
            type: "array",
            items: { type: "string" },
            description: "Optional predefined choices.",
          },
          allow_multiple: {
            type: "boolean",
            description: "Allow multiple selections. Defaults to false.",
          },
          required: {
            type: "boolean",
            description: "Whether answer is required. Defaults to true.",
          },
        },
      },
    },
  },
];

export type PlanningSessionPhase = "default";


export function estimateRequestedArtifactCount(prompt: string): number {
  const normalized = prompt.trim();
  if (!normalized) {
    return 0;
  }

  // --- New pattern: Chinese numeral + "个文件" (e.g. "三个文件", "3个文件") ---
  const chineseNumWordMap: Record<string, number> = {
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };
  const cnNumMatch = normalized.match(
    /([二两三四五六七八九十]|\d+)\s*个\s*文件/
  );
  if (cnNumMatch) {
    const raw = cnNumMatch[1];
    const parsed = chineseNumWordMap[raw] ?? Number(raw);
    if (parsed >= 2) return parsed;
  }

  // --- New pattern: English "<N> (separate|distinct|new)? files" ---
  const enNumMatch = normalized.match(
    /(\d+)\s+(?:separate\s+|distinct\s+|new\s+)?files?\b/i
  );
  if (enNumMatch) {
    const parsed = Number(enNumMatch[1]);
    if (parsed >= 2) return parsed;
  }

  // --- New pattern: split/enumeration with 、 (e.g. "拆分成HTML、CSS、JS") ---
  const splitMatch = normalized.match(/拆分[成为]?\s*(.+)/);
  if (splitMatch) {
    const tail = splitMatch[1];
    const parts = tail
      .split(/[、，,\s+和and]+/i)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length >= 2) return parts.length;
  }

  if (
    /(完整.{0,4}(前端|网页|页面)|完整的前端|完整前端|complete\s+(frontend|web\s*page)|full\s+(frontend|web\s*app))/i.test(
      normalized
    )
  ) {
    return 3;
  }

  const segments = normalized
    .split(/(?:\s+and\s+|\s+plus\s+|以及|并且|还有|和|，|,|；|;|、)/i)
    .map((segment) => segment.trim())
    .filter(Boolean);

  const artifactPattern =
    /(?:\.py\b|\.html\b|\.css\b|\.js\b|\.jsx\b|\.ts\b|\.tsx\b|\.json\b|python|html|css|javascript|typescript|脚本|页面|网页|文件)/i;
  const explicitCount = segments.filter((segment) =>
    artifactPattern.test(segment)
  ).length;
  if (explicitCount > 0) {
    return explicitCount;
  }

  return artifactPattern.test(normalized) ? 1 : 0;
}

function collectPatchedFiles(patch: string): string[] {
  const files = new Set<string>();
  for (const rawLine of patch.split(/\r?\n/)) {
    const line = rawLine.trim();
    const diffMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (diffMatch) {
      if (diffMatch[1] && diffMatch[1] !== "/dev/null") {
        files.add(diffMatch[1]);
      }
      if (diffMatch[2] && diffMatch[2] !== "/dev/null") {
        files.add(diffMatch[2]);
      }
      continue;
    }

    const plusMatch = line.match(/^\+\+\+\s+b\/(.+)$/);
    if (plusMatch?.[1]) {
      files.add(plusMatch[1]);
    }
  }

  return Array.from(files);
}

/**
 * True when every patch targets a non-empty, known file set and no workspace path
 * appears in more than one patch. Used to decide whether a shared atomic batch group is safe.
 */
function applyPatchTargetsAreDisjointForBatching(
  patchActions: ApplyPatchActionProposal[],
): boolean {
  if (patchActions.length <= 1) {
    return true;
  }
  const pathCounts = new Map<string, number>();
  for (const action of patchActions) {
    const files = collectPatchedFiles(action.payload.patch)
      .map((file) => file.trim())
      .filter(Boolean);
    if (files.length === 0) {
      return false;
    }
    const uniqInPatch = new Set(files);
    for (const file of uniqInPatch) {
      pathCounts.set(file, (pathCounts.get(file) ?? 0) + 1);
    }
  }
  for (const count of pathCounts.values()) {
    if (count > 1) {
      return false;
    }
  }
  return true;
}

function countPlannedArtifacts(actions: ActionProposal[]): number {
  const artifacts = new Set<string>();

  for (const action of actions) {
    if (action.type === "apply_patch") {
      const patchFiles = collectPatchedFiles(action.payload.patch);
      if (patchFiles.length > 0) {
        patchFiles.forEach((file) => artifacts.add(`file:${file}`));
        continue;
      }
    }

    artifacts.add(`action:${action.id}`);
  }

  return artifacts.size;
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function detectPatchOperationKinds(patch: string): string[] {
  const kinds = new Set<string>();
  for (const rawLine of patch.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("new file mode ")) {
      kinds.add("create");
      continue;
    }
    if (line.startsWith("deleted file mode ")) {
      kinds.add("delete");
      continue;
    }
    if (line.startsWith("rename from ") || line.startsWith("rename to ")) {
      kinds.add("rename");
      continue;
    }
    if (line.startsWith("@@")) {
      kinds.add("modify");
    }
  }
  if (!kinds.size) {
    kinds.add("modify");
  }
  return Array.from(kinds).sort();
}

function hashText(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}


function stableMessageHashKey(
  messages: LiteLLMMessage[],
  workspacePath?: string
): string {
  const normalized = messages
    .map((m) => {
      const toolCalls = m.tool_calls ? JSON.stringify(m.tool_calls) : "";
      const toolCallId = (m as any).tool_call_id
        ? String((m as any).tool_call_id)
        : "";
      const name = (m as any).name ? String((m as any).name) : "";
      return [m.role, m.content ?? "", toolCalls, toolCallId, name].join(
        "\u001f"
      );
    })
    .join("\u001e");
  const scope = workspacePath?.trim() ? `ws:${workspacePath.trim()}` : "ws:";
  return `${scope}:${hashText(normalized)}`;
}

const summaryCache = new SummaryCache({
  ttlMs: SUMMARY_CACHE_TTL_MS,
  maxEntries: SUMMARY_CACHE_MAX_ENTRIES,
});

// Cooldown is per workspace to reduce oscillation on retries.
const lastSummaryAtMsByWorkspace = new Map<string, number>();

function canSummarizeNow(workspacePath: string | undefined, currentTokens?: number): boolean {
  const ws = workspacePath?.trim() || "";
  if (!ws) return true;
  const last = lastSummaryAtMsByWorkspace.get(ws) ?? 0;
  // P2-2: Use dynamic cooldown based on token growth rate.
  const cooldown = computeDynamicCooldownMs(workspacePath, currentTokens ?? 0);
  return Date.now() - last >= cooldown;
}

function markSummarizedNow(workspacePath: string | undefined): void {
  const ws = workspacePath?.trim() || "";
  if (!ws) return;
  lastSummaryAtMsByWorkspace.set(ws, Date.now());
}


function buildAgentToolDefs(runtime: ResolvedAgentRuntime): LiteLLMToolDefinition[] {
  const enabled = new Set<string>([...runtime.enabledTools, ...INTERNAL_TOOL_NAMES]);
  return TOOL_DEFINITIONS.filter((td) => enabled.has(td.function.name));
}

export class LocalOnlyPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalOnlyPolicyError";
  }
}

export interface ToolCallEvent {
  type: "start" | "end";
  callId: string;
  toolName: string;
  argsPreview?: string;
  result?: ToolExecutionStatus;
  resultPreview?: string;
}

export interface RunPlanningSessionInput {
  prompt: string;
  settings: AppSettings;
  /** Agent identifier or conversation binding. Determines system prompt, tool set, and sub-agent permissions. */
  agentId?: string | ConversationAgentBinding;
  phase?: PlanningSessionPhase;
  conversationHistory?: Array<{
    role: "user" | "assistant" | "tool";
    content: string;
    tool_calls?: any[];
    tool_call_id?: string;
    name?: string;
  }>;
  contextAttachments?: ChatContextAttachment[];
  isContinuation?: boolean;
  internalSystemNote?: string;
  existingPlan?: OrchestrationPlan | null;
  blockedActionFingerprints?: string[];
  signal?: AbortSignal;
  onAssistantChunk?: (chunk: string) => void;
  onToolCallEvent?: (event: ToolCallEvent) => void;
  /** Called with the estimated context token count after each LLM turn (including tool results). */
  onContextUpdate?: (estimatedTokens: number) => void;
  /** Called periodically during the tool loop with partial results for incremental checkpoint persistence. */
  onLoopCheckpoint?: (checkpoint: {
    turn: number;
    proposedActions: ActionProposal[];
    planState: TodoPlanState;
    toolTrace: ToolExecutionTrace[];
    assistantReply: string;
    /** P3-1: Working memory snapshot for checkpoint persistence. */
    workingMemorySnapshot?: import("./workingMemory").WorkingMemorySnapshot;
  }) => void;
  /** Called when the plan state (todo list) or proposed actions list changes during the tool loop. */
  onPlanStateUpdate?: (
    planState: TodoPlanState,
    proposedActions: ActionProposal[]
  ) => void;
  /** Session ID for ask_user tool to track user responses. */
  sessionId?: string;
  /** Called when the AI invokes the ask_user tool. The UI should show a dialog and call submitUserResponse when done. */
  onAskUserRequest?: (request: AskUserRequest) => void;
  /** P3-2: Restored working memory snapshot from a previous checkpoint. */
  restoredWorkingMemory?: WorkingMemorySnapshot;
  /** Explicitly selected skill IDs from @-mention. When provided, auto-matching is skipped. */
  explicitSkillIds?: string[];
}

export interface PlanningSessionResult {
  assistantReply: string;
  plan: OrchestrationPlan;
  toolTrace: ToolExecutionTrace[];
  assistantToolCalls?: LiteLLMMessage["tool_calls"];
  workingMemorySnapshot?: WorkingMemorySnapshot;
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
  };
}




function normalizeMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (
          item &&
          typeof item === "object" &&
          "type" in item &&
          (item as Record<string, unknown>).type === "text" &&
          "text" in item &&
          typeof (item as Record<string, unknown>).text === "string"
        ) {
          return (item as Record<string, string>).text;
        }
        return "";
      })
      .join("");
  }

  return "";
}




function formatVendorProtocolLabel(protocol: string): string {
  switch (protocol) {
    case "openai-responses":
      return "OpenAI Responses";
    case "anthropic-messages":
      return "Anthropic Messages";
    case "openai-chat-completions":
    default:
      return "OpenAI Chat Completions";
  }
}


// ---------------------------------------------------------------------------
// P1-2: Map-reduce summarization
// ---------------------------------------------------------------------------
// Instead of truncating combined content to 12000 chars, we split messages
// into chunks that each fit within SUMMARY_CHUNK_MAX_CHARS, summarize each
// chunk independently (Map), then combine the chunk summaries and produce
// a final reduced summary (Reduce).
//
// Reference: LangChain MapReduceChain pattern.
// ---------------------------------------------------------------------------

const SUMMARY_SYSTEM_PROMPT = [
  "你是一个代码助手内置的上下文压缩引擎。你的任务是将冗长的对话历史压缩为高密度的摘要，保留对后续工作至关重要的事实与技术上下文。",
  "请使用高度结构化、简明扼要的语言（中文）输出，严格控制在 800 字以内，并包含以下部分：",
  "【核心目标】用户最初的需求是什么？",
  "【已完成变更】涉及哪些文件的修改？具体做了什么（给出关键函数或组件名）？",
  "【收集到的事实】发现的重要错误信息、项目的架构约束、特殊的配置结构等。",
  "【当前进展与下一步】任务停在哪里？接下来立即需要解决的是什么？",
].join("\n");


function formatMessagesForSummary(msgs: LiteLLMMessage[]): string {
  return msgs
    .map((msg) => {
      const roleLabel =
        msg.role === "user"
          ? "用户"
          : msg.role === "assistant"
            ? "助手"
            : msg.role;
      // Safely extract text from multimodal content (content may be an array
      // of {type:"text", text:"..."} objects in some providers).
      const text = normalizeMessageContent(msg.content);
      return `[${roleLabel}] ${text}`;
    })
    .join("\n---\n");
}


async function summarizeSingleChunk(
  content: string,
  settings: AppSettings,
  systemPrompt: string,
): Promise<string | null> {
  const messages: LiteLLMMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content },
  ];

  try {
    const response = await gatewaySummarize(messages, settings);
    const payload = JSON.parse(response.body) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return payload.choices?.[0]?.message?.content?.trim() ?? null;
  } catch (error) {
    console.warn(
      `[Context] summarizeSingleChunk 失败 | content.length=${content.length}`,
      error,
    );
    return null;
  }
}

async function requestSummary(
  messagesToSummarize: LiteLLMMessage[],
  settings: AppSettings,
  options?: {
    workspacePath?: string;
  }
): Promise<string> {
  const cacheKey = stableMessageHashKey(
    messagesToSummarize,
    options?.workspacePath
  );
  const cached = summaryCache.get(cacheKey);
  if (cached) {
    console.log(`[Context] 摘要命中缓存 (${messagesToSummarize.length} messages)`);
    return cached;
  }

  console.log(`[Context] 开始上下文摘要压缩 | ${messagesToSummarize.length} messages`);
  const sumT0 = performance.now();

  const combinedContent = formatMessagesForSummary(messagesToSummarize);

  // Single-pass summarization: truncate to fit budget, then one LLM call.
  // For long content, keep the tail (most recent context is most relevant).
  const contentForSummary =
    combinedContent.length <= SUMMARY_CHUNK_MAX_CHARS
      ? combinedContent
      : "(早期对话已省略)...\n" + combinedContent.slice(-SUMMARY_CHUNK_MAX_CHARS);

  const result = await summarizeSingleChunk(
    contentForSummary,
    settings,
    SUMMARY_SYSTEM_PROMPT,
  );
  if (result) {
    const elapsed = ((performance.now() - sumT0) / 1000).toFixed(2);
    console.log(`[Context] 摘要完成 | ${elapsed}s | ${result.length} chars`);
    summaryCache.set(cacheKey, result);
    return result;
  }

  // Fallback when summarization fails
  const userMessages = messagesToSummarize.filter((m) => m.role === "user");
  const fallbackLines = userMessages
    .map((m) => m.content.slice(0, 100))
    .slice(0, 5);
  const fallback = `[自动摘要] 之前的对话包含 ${messagesToSummarize.length
    } 条消息。用户主要请求：${fallbackLines.join("；")}`;
  summaryCache.set(cacheKey, fallback);
  return fallback;
}

function normalizeConversationHistory(
  conversationHistory: RunPlanningSessionInput["conversationHistory"]
): LiteLLMMessage[] {
  if (!conversationHistory?.length) {
    return [];
  }

  const filtered = conversationHistory.filter(
    (message) =>
      message.content ||
      message.role === "tool" ||
      (message.role === "assistant" &&
        message.tool_calls &&
        message.tool_calls.length > 0)
  );

  // Collect all tool_call_ids that have matching tool-role responses so we can
  // strip orphaned tool_calls from assistant messages.  The OpenAI API rejects
  // requests where an assistant message contains tool_calls without a
  // corresponding tool-role message (error: "No tool output found for function
  // call …").  This happens when the orchestrator loop's internal tool results
  // are not persisted to the UI message list (they live only inside the loop).
  const answeredToolCallIds = new Set(
    filtered
      .filter((m) => m.role === "tool" && m.tool_call_id)
      .map((m) => m.tool_call_id as string),
  );

  return filtered.map((message) => {
    const m: LiteLLMMessage = {
      role: message.role as any,
      content: message.content.trim(),
    };
    if (message.tool_calls) {
      // Only keep tool_calls whose results are present in the history.
      const validCalls = message.tool_calls.filter(
        (tc) => answeredToolCallIds.has(tc.id),
      );
      if (validCalls.length > 0) {
        m.tool_calls = validCalls;
      }
    }
    if (message.role === "tool" && message.tool_call_id) {
      m.tool_call_id = message.tool_call_id;
    }
    if (message.role === "tool" && message.name) {
      m.name = message.name;
    }
    return m;
  });
}



function createActionId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}


function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("The operation was aborted.", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isRetriableLLMError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") {
    return false;
  }
  const raw = error instanceof Error ? error.message : String(error);
  const lower = raw.toLowerCase();
  // Rate limit (429)
  if (lower.includes("429") || lower.includes("rate limit") || lower.includes("too many requests")) {
    return true;
  }
  // Server errors (500, 502, 503, 504)
  if (/(?:^|\D)(500|502|503|504)(?:\D|$)/.test(lower)) {
    return true;
  }
  // Network / transport errors
  if (
    lower.includes("timeout") ||
    lower.includes("超时") ||
    lower.includes("timed out") ||
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("network") ||
    lower.includes("connection refused") ||
    lower.includes("bad gateway") ||
    lower.includes("gateway") ||
    lower.includes("upstream")
  ) {
    return true;
  }
  return false;
}

function computeRetryDelay(attempt: number): number {
  const delay = LLM_RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
  const jitter = delay * 0.2 * Math.random();
  return Math.min(delay + jitter, LLM_RETRY_MAX_DELAY_MS);
}




const toolExecutorDeps: ToolExecutorDeps = {
  createActionId,
  nowIso,
  actionFingerprint,
  setActivePlanStep,
  setPlanStepStatus,
  addPlanStep,
  appendPlanStepNote,
  formatTodoPlanBlock,
  smartTruncate,
};

async function executeToolCall(
  call: ToolCallRecord,
  workspacePath: string,
  toolPermissions: ToolPermissions = DEFAULT_TOOL_PERMISSIONS,
  settings?: AppSettings,
  projectConfig?: CofreeRcConfig,
  enabledToolNames?: string[],
  planState?: TodoPlanState,
  workingMemory?: WorkingMemory,
  signal?: AbortSignal,
  turn?: number,
  _focusedPaths?: string[],
  sessionId?: string,
  onAskUserRequest?: (request: AskUserRequest) => void,
  autoExecutionPolicy: SensitiveWriteAutoExecutionPolicy = "allow",
): Promise<ToolExecutionResult> {
  return executeToolCallInternal(
    call,
    workspacePath,
    toolExecutorDeps,
    toolPermissions,
    settings,
    projectConfig,
    enabledToolNames,
    planState,
    workingMemory,
    signal,
    turn,
    _focusedPaths,
    sessionId,
    onAskUserRequest,
    autoExecutionPolicy,
  );
}

async function executeToolCallWithRetry(
  call: ToolCallRecord,
  workspacePath: string,
  toolPermissions: ToolPermissions = DEFAULT_TOOL_PERMISSIONS,
  settings?: AppSettings,
  projectConfig?: CofreeRcConfig,
  enabledToolNames?: string[],
  planState?: TodoPlanState,
  workingMemory?: WorkingMemory,
  signal?: AbortSignal,
  turn?: number,
  _focusedPaths?: string[],
  sessionId?: string,
  onAskUserRequest?: (request: AskUserRequest) => void,
  autoExecutionPolicy: SensitiveWriteAutoExecutionPolicy = "allow",
): Promise<{
  result: ToolExecutionResult;
  trace: ToolExecutionTrace;
}> {
  return executeToolCallWithRetryInternal(
    call,
    workspacePath,
    toolExecutorDeps,
    toolPermissions,
    settings,
    projectConfig,
    enabledToolNames,
    planState,
    workingMemory,
    signal,
    turn,
    _focusedPaths,
    sessionId,
    onAskUserRequest,
    autoExecutionPolicy,
  );
}


/**
 * Discover, match, and resolve skills for the current request.
 * Merges skills from three sources: global (~/.cofree/skills/), workspace
 * (.cofree/skills/), .cofreerc, and user-registered custom skills in settings.
 */
async function resolveMatchedSkills(
  settings: AppSettings,
  projectConfig: CofreeRcConfig | undefined,
  userMessage: string,
  focusedPaths: string[],
  explicitSkillIds?: string[],
): Promise<ResolvedSkill[]> {
  try {
    // 1. Collect all skill definitions from various sources
    const allSkillDefs: SkillEntry[] = [];
    const workspacePath = settings.workspacePath.trim();

    const [globalSkills, workspaceSkills] = await Promise.all([
      discoverGlobalSkills(),
      workspacePath ? discoverWorkspaceSkills(workspacePath) : Promise.resolve([]),
    ]);
    allSkillDefs.push(...globalSkills, ...workspaceSkills);

    // .cofreerc skills
    if (projectConfig?.skills?.length && workspacePath) {
      allSkillDefs.push(...convertCofreeRcSkillEntries(projectConfig, workspacePath));
    }

    // Merge with user-registered skills from settings (preserves enabled state)
    const mergedRegistry = mergeDiscoveredSkills(settings.skills, allSkillDefs);

    // 2. If explicit skill IDs provided, resolve them directly (skip keyword matching)
    if (explicitSkillIds && explicitSkillIds.length > 0) {
      const explicitSkills = explicitSkillIds
        .map((id) => mergedRegistry.find((s) => s.id === id))
        .filter((s): s is SkillEntry => s != null && s.enabled);
      console.debug(
        "[skills] Explicit skill selection",
        explicitSkills.map((skill) => ({ id: skill.id, name: skill.name })),
      );
      return resolveSkills(explicitSkills);
    }

    // 3. Auto-match skills against the user message and focused files
    const matched = matchSkills(mergedRegistry, userMessage, focusedPaths);
    if (matched.length === 0) {
      console.debug("[skills] No matched skills", {
        registrySize: mergedRegistry.length,
        focusedPathCount: focusedPaths.length,
      });
      return [];
    }
    console.debug(
      "[skills] Matched skills",
      matched.map((skill) => ({ id: skill.id, name: skill.name, source: skill.source })),
    );

    // 3. Resolve matched skills (load their instructions)
    return resolveSkills(matched);
  } catch (error) {
    // Skill resolution should never block the main loop
    console.warn("[skills] Failed to resolve matched skills", error);
    return [];
  }
}

async function runNativeToolCallingLoop(
  prompt: string,
  settings: AppSettings,
  runtime: ResolvedAgentRuntime,
  phase: PlanningSessionPhase,
  conversationHistory: LiteLLMMessage[],
  initialPlanState: TodoPlanState,
  internalSystemNote?: string,
  blockedActionFingerprints: string[] = [],
  signal?: AbortSignal,
  onAssistantChunk?: (chunk: string) => void,
  isContinuation?: boolean,
  projectConfig?: CofreeRcConfig,
  onToolCallEvent?: (event: ToolCallEvent) => void,
  onContextUpdate?: (estimatedTokens: number) => void,
  onLoopCheckpoint?: RunPlanningSessionInput["onLoopCheckpoint"],
  onPlanStateUpdate?: RunPlanningSessionInput["onPlanStateUpdate"],
  focusedPaths: string[] = [],
  sessionId?: string,
  onAskUserRequest?: (request: AskUserRequest) => void,
  restoredWorkingMemory?: WorkingMemorySnapshot,
  explicitSkillIds?: string[],
): Promise<{
  assistantReply: string;
  requestRecords: RequestRecord[];
  proposedActions: ActionProposal[];
  planState: TodoPlanState;
  toolTrace: ToolExecutionTrace[];
  assistantToolCalls?: LiteLLMMessage["tool_calls"];
  assistantToolCallsFromFinalTurn?: boolean;
  workingMemorySnapshot?: WorkingMemorySnapshot;
}> {
  const activeTools = buildAgentToolDefs(runtime);
  const enabledToolNames = [...runtime.enabledTools, ...INTERNAL_TOOL_NAMES];
  const planState = normalizeTodoPlanState(clonePlanState(initialPlanState));
  // Merge tool permissions: runtime (agent-specific) take priority, then .cofreerc overrides
  const basePermissions = runtime.toolPermissions as unknown as ToolPermissions;
  const toolPermissions: ToolPermissions = projectConfig?.toolPermissions
    ? ({
      ...basePermissions,
      ...projectConfig.toolPermissions,
    } as ToolPermissions)
    : basePermissions;
  // --- Skill matching & resolution ---
  const resolvedSkills = await resolveMatchedSkills(
    settings,
    projectConfig,
    prompt,
    focusedPaths,
    explicitSkillIds,
  );
  const agentSystemPrompt = assembleSystemPrompt(runtime, resolvedSkills);
  const effectiveRuntimeContext = assembleRuntimeContext(runtime, settings.workspacePath, INTERNAL_TOOL_NAMES);
  const requestedArtifactCount =
    phase === "default" ? estimateRequestedArtifactCount(prompt) : 0;
  const blockedFingerprints = blockedActionFingerprints
    .map((value) => value.trim())
    .filter(Boolean);
  // P0-1: Materialized set for O(1) lookups in processToolResult and sub-agent paths
  const blockedFingerprintSet = new Set(blockedFingerprints);

  const messages: LiteLLMMessage[] = [
    { role: "system", content: agentSystemPrompt },
    { role: "system", content: effectiveRuntimeContext },
    ...(blockedFingerprints.length > 0
      ? [
        {
          role: "system" as const,
          content: [
            "系统提示：以下动作指纹已在之前轮次执行或处理完成，禁止再次提出相同动作。",
            ...blockedFingerprints.map((fingerprint) => `- ${fingerprint}`),
            "如果没有新的必要动作，请直接给出最终总结。",
          ].join("\n"),
        },
      ]
      : []),
    ...(internalSystemNote?.trim()
      ? [{ role: "system" as const, content: internalSystemNote.trim() }]
      : []),
    ...conversationHistory,
    // Continuation must still include a real user-role message.
    // Some providers degrade tool-calling behavior or stop early when the last turn is system-only.
    ...(isContinuation
      ? [
        {
          role: "system" as const,
          content: `[任务上下文] 用户的原始请求是："${prompt}"。本轮是自动续跑（continuation），请基于已完成的工作继续完成剩余交付物。如果所有交付物均已完成，直接简短汇报。`,
        },
        { role: "user" as const, content: prompt },
      ]
      : [{ role: "user" as const, content: prompt }]),
  ];
  console.log(
    `[Loop] 会话开始 | phase=${phase} | continuation=${isContinuation ? "yes" : "no"}`
  );
  let lastTodoPlanPrompt = upsertTodoPlanContextMessage(messages, planState);

  const requestRecords: RequestRecord[] = [];
  const proposedActions: ActionProposal[] = [];
  const toolTrace: ToolExecutionTrace[] = [];
  let lastAssistantToolCalls: LiteLLMMessage["tool_calls"] | undefined;
  let patchRepairRounds = 0;
  let createHintRepairRounds = 0;
  let shellDialectRepairRounds = 0;
  let multiArtifactReminderRounds = 0;
  let toolNotFoundStrikes = 0;
  let consecutiveFailureTurns = 0;
  let searchNotFoundRepairRounds = 0;
  let pseudoToolCallRepairRounds = 0;
  let fileEditFailureTracker = new Map<string, number>(); // relativePath → consecutive fail count
  let consecutiveReadOnlyTurns = 0;
  let toolChoiceOverride: "auto" | "none" | undefined = undefined;
  let lastWorkingMemoryFingerprint = "";

  // --- Workspace context refresh tracking ---
  let hasModifiedFiles = false; // Track if files have been edited/created
  let lastWorkspaceRefreshTurn = -1; // Last turn when workspace context was refreshed

  // --- Context window management ---
  const limitTokens = resolveEffectiveContextTokenLimit(settings);
  const adaptiveParams = computeAdaptiveCompressionParams(limitTokens);

  // --- Shared Working Memory for multi-agent collaboration ---
  // P3-2: Restore from checkpoint snapshot if available, otherwise create fresh
  const workingMemory = restoredWorkingMemory
    ? restoreWorkingMemory(restoredWorkingMemory)
    : createWorkingMemory({
        maxTokenBudget: Math.floor(
          Math.max(0, limitTokens - Math.min(8000, Math.max(512, Math.floor(limitTokens * adaptiveParams.outputReserveRatio)))) * adaptiveParams.softBudgetRatio * 0.2
        ),
        projectContext: internalSystemNote?.slice(0, 500) ?? "",
      });
  if (restoredWorkingMemory) {
    console.log(
      `[Loop] Working memory restored from checkpoint | files=${workingMemory.fileKnowledge.size}`
    );
  }
  const currentWorkingMemorySnapshot = (): WorkingMemorySnapshot | undefined =>
    snapshotWorkingMemory(workingMemory);
  const outputBufferTokens = Math.min(
    8000,
    Math.max(512, Math.floor(limitTokens * adaptiveParams.outputReserveRatio))
  );
  const hardPromptBudget = Math.max(0, limitTokens - outputBufferTokens);
  const softPromptBudget = Math.floor(hardPromptBudget * adaptiveParams.softBudgetRatio);
  const promptBudgetTarget = softPromptBudget > 0 ? softPromptBudget : hardPromptBudget;

  // P0-2: Pre-compute tool definition overhead and pass to compression policy.
  const toolDefTokens = estimateTokensForToolDefinitions(activeTools);
  console.log(`[Loop] 工具定义 token 开销: ~${toolDefTokens} tokens (${activeTools.length} tools)`);

  // Incremental token tracker — avoids re-scanning all messages on every call.
  const tokenTracker = new MessageTokenTracker();

  const estimateCurrentTokens = (): number => tokenTracker.update(messages);

  const replaceMessages = (nextMessages: LiteLLMMessage[]): void => {
    if (nextMessages === messages) {
      return;
    }
    messages.splice(0, messages.length, ...nextMessages);
    tokenTracker.invalidate();
  };

  const emitContextUpdate = (): number => {
    const estimatedTokens = estimateCurrentTokens();
    onContextUpdate?.(estimatedTokens);
    return estimatedTokens;
  };

  const compressionPolicy = {
    maxPromptTokens: promptBudgetTarget,
    minMessagesToSummarize: MIN_MESSAGES_TO_SUMMARIZE,
    minRecentMessagesToKeep: adaptiveParams.minRecentMessagesToKeep,
    recentTokensMinRatio: adaptiveParams.recentTokensMinRatio,
    toolMessageMaxChars: adaptiveParams.toolMessageMaxChars,
    mergeToolMessages: true,
    toolDefinitionTokens: toolDefTokens,
  };

  const summarizer = {
    canSummarize: () => canSummarizeNow(settings.workspacePath, estimateCurrentTokens()),
    summarize: (messagesToSummarize: LiteLLMMessage[]) =>
      requestSummary(messagesToSummarize, settings, {
        workspacePath: settings.workspacePath,
      }),
    markSummarized: () => markSummarizedNow(settings.workspacePath),
  };

  for (let turn = 0; ; turn += 1) {
    if (turn >= MAX_ABSOLUTE_TURNS) {
      console.warn(`[Loop] 达到绝对轮次上限 (${MAX_ABSOLUTE_TURNS})，强制终止`);
      return {
        assistantReply: `已达到工具调用轮次硬上限（${MAX_ABSOLUTE_TURNS} 轮），已自动终止。请检查任务复杂度或拆分为更小的子任务。`,
        requestRecords,
        proposedActions,
        planState,
        toolTrace,
        assistantToolCalls: lastAssistantToolCalls,
        workingMemorySnapshot: currentWorkingMemorySnapshot(),
      };
    }

    if (turn > 0 && turn % TOOL_LOOP_CHECKPOINT_TURNS === 0) {
      console.log(`[Loop] 已运行 ${turn} 轮，到达检查点，暂停等待用户确认`);
      return {
        assistantReply: `已经持续调用了 ${turn} 轮工具，任务仍在进行中。如果需要继续，请回复「继续」。`,
        requestRecords,
        proposedActions,
        planState,
        toolTrace,
        assistantToolCalls: lastAssistantToolCalls,
        workingMemorySnapshot: currentWorkingMemorySnapshot(),
      };
    }

    // Incremental checkpoint: persist partial progress every N turns
    if (turn > 0 && turn % INCREMENTAL_CHECKPOINT_INTERVAL === 0 && onLoopCheckpoint) {
      try {
        const assistantMsgs = messages.filter((m) => m.role === "assistant");
        const lastReply = assistantMsgs.length > 0 ? assistantMsgs[assistantMsgs.length - 1].content : "";
        onLoopCheckpoint({
          turn,
          proposedActions: [...proposedActions],
          planState: clonePlanState(planState),
          toolTrace: [...toolTrace],
          assistantReply: lastReply,
          // P3-1: Include working memory snapshot for checkpoint persistence
          workingMemorySnapshot: currentWorkingMemorySnapshot(),
        });
        console.log(`[Loop] 增量检查点已保存 | turn=${turn} | actions=${proposedActions.length} | traces=${toolTrace.length}`);
      } catch (checkpointError) {
        console.warn(`[Loop] 增量检查点保存失败:`, checkpointError);
      }
    }

    const currentTodoPlanPrompt = buildTodoSystemPrompt(planState);
    if (currentTodoPlanPrompt !== lastTodoPlanPrompt) {
      lastTodoPlanPrompt = upsertTodoPlanContextMessage(messages, planState);
    }

    if (turn > 0) {
      const currentFingerprint = computeWorkingMemoryFingerprint(workingMemory);
      const hasMemoryContent = currentFingerprint !== "0:0:0:0";
      const memoryChanged = hasMemoryContent && currentFingerprint !== lastWorkingMemoryFingerprint;
      const isRefreshTurn = turn % WORKING_MEMORY_REFRESH_INTERVAL === 0;

      if (hasMemoryContent && (memoryChanged || isRefreshTurn)) {
        upsertWorkingMemoryContextMessage({
          messages,
          workingMemory,
          tokenBudget: Math.floor(promptBudgetTarget * 0.12),
          query: prompt,
          focusedPaths,
        });
        lastWorkingMemoryFingerprint = currentFingerprint;
      }

      // --- Workspace context refresh ---
      if (settings.workspacePath && projectConfig) {
        const refreshConfig = projectConfig.workspaceRefresh;
        const refreshEnabled = refreshConfig?.enabled !== false; // Default: true
        const refreshInterval = refreshConfig?.turnInterval ?? 20; // Default: 20 turns
        const refreshOnFileChange = refreshConfig?.onFileChange !== false; // Default: true

        const shouldRefreshByTurn = refreshEnabled && refreshInterval > 0 &&
          (turn - lastWorkspaceRefreshTurn) >= refreshInterval;
        const shouldRefreshByFileChange = refreshEnabled && refreshOnFileChange &&
          hasModifiedFiles && (turn - lastWorkspaceRefreshTurn) >= 5; // Min 5 turns between refreshes

        if (shouldRefreshByTurn || shouldRefreshByFileChange) {
          try {
            await refreshWorkspaceContext({
              messages,
              workspacePath: settings.workspacePath,
              projectConfig,
              normalizedPrompt: prompt,
              sessionFocusedPaths: focusedPaths,
              turnNumber: turn,
            });
            lastWorkspaceRefreshTurn = turn;
            hasModifiedFiles = false; // Reset file modification flag
            console.log(
              `[Loop] Workspace context refreshed (trigger: ${shouldRefreshByTurn ? 'turn-interval' : 'file-change'})`
            );
          } catch (e) {
            console.warn("[Loop] Failed to refresh workspace context", e);
          }
        }
      }
    }

    const pinnedPrefixLen = initialSystemPrefixLength(messages);

    const estTokensAtTurnStart = estimateCurrentTokens();
    console.log(
      `[Loop] ── Turn ${turn + 1} ── messages=${messages.length} | ~${estTokensAtTurnStart} tokens`
    );

    if (turn === TOOL_LOOP_EFFICIENCY_WARNING_THRESHOLD) {
      messages.push({
        role: "system",
        content: [
          `系统提示：你已经使用了 ${turn} 轮工具调用。`,
          "请注意效率，优先使用 grep/glob 批量搜索而非逐个文件阅读。",
          "如果任务已基本完成，请尽快给出最终总结；如果确实需要继续，请集中处理剩余关键步骤。",
        ].join("\n"),
      });
    }

    // --- Tool calling reinforcement for long conversations ---
    // GPT models tend to "forget" to use native tool calling after many turns.
    // Periodically reinforce the tool calling mechanism.
    if (
      turn > 0 &&
      turn % TOOL_CALLING_REINFORCEMENT_INTERVAL === 0 &&
      toolChoiceOverride !== "none"
    ) {
      const existingReinforcement = messages.findIndex(
        (m) => m.role === "system" && m.content.startsWith(TOOL_CALLING_REINFORCEMENT_NOTE_PREFIX),
      );
      if (existingReinforcement >= pinnedPrefixLen) {
        messages.splice(existingReinforcement, 1);
      }
      messages.push({
        role: "system",
        content: [
          TOOL_CALLING_REINFORCEMENT_NOTE_PREFIX,
          "重要：你必须通过原生工具调用（function calling / tool_calls）来使用工具。",
          "不要在回复文本中描述、转录或模拟工具调用。直接发送 tool_calls 即可。",
          `可用工具: [${enabledToolNames.join(", ")}]`,
        ].join("\n"),
      });
    }

    // --- Prune stale interstitial system messages ---
    // Limit accumulated system messages to prevent context pollution.
    const maxInterstitialSysMsgs = Math.max(6, Math.ceil(turn * 0.3));
    const prunedMessages = pruneStaleSystemMessages(messages, pinnedPrefixLen, maxInterstitialSysMsgs);
    if (prunedMessages.length < messages.length) {
      const removed = messages.length - prunedMessages.length;
      replaceMessages(prunedMessages);
      console.log(`[Loop] 清理陈旧系统消息: 移除 ${removed} 条`);
    }

    // --- Context Editing: 主动淘汰旧 tool-use 对 ---
    const shouldEditByTurns = adaptiveParams.contextEditTriggerEveryNTurns > 0
      && turn > 0 && turn % adaptiveParams.contextEditTriggerEveryNTurns === 0;
    const shouldEditByTokens = estimateCurrentTokens() >
      promptBudgetTarget * adaptiveParams.contextEditTriggerTokenRatio;

    if (shouldEditByTurns || shouldEditByTokens) {
      const editResult = clearOldToolUses(messages, {
        keepRecentTurns: adaptiveParams.contextEditKeepRecentTurns,
        clearAtLeast: CONTEXT_EDIT_CLEAR_AT_LEAST,
        pinnedPrefixLen,
      });
      if (editResult.cleared) {
        replaceMessages(editResult.messages);
        console.log(
          `[Loop] Context Editing: 清除 ${editResult.pairsRemoved} 个旧 tool-use 轮次 | ` +
          `释放 ~${editResult.tokensFreed} tokens | 剩余 ${messages.length} messages`
        );
      }
    }

    // 现有的 compression pipeline 继续执行
    // 安全区：如果 token 用量低于预算的阈值，跳过压缩管道以避免不必要的截断
    const safeZoneEval = evaluateCompressionSafeZone({
      tokenTracker,
      messages,
      promptBudgetTarget,
      safeZoneRatio: adaptiveParams.compressionSafeZoneRatio,
    });
    const compression = safeZoneEval.skipCompression
      ? {
        compressed: false,
        messages,
        usedSummary: false,
        usedTruncation: false,
        usedToolCompression: false,
        estimatedTokensBefore: safeZoneEval.currentTokens,
        estimatedTokensAfter: safeZoneEval.currentTokens,
      }
      : await compressMessagesToFitBudget({
        messages,
        policy: compressionPolicy,
        summarizer,
        pinnedPrefixLen,
      });
    if (compression.compressed && compression.messages !== messages) {
      const beforeLen = messages.length;
      replaceMessages(compression.messages);
      const afterTokens = estimateCurrentTokens();
      console.log(
        `[Loop] 上下文压缩: ${beforeLen} → ${messages.length} messages | ~${afterTokens} tokens`
      );
    }
    // File knowledge is already tracked in working memory; no need to inject
    // a separate "known files" system message after compression.
    emitContextUpdate();

    let completion;
    {
      let lastLLMError: unknown;
      let llmRetryAttempt = 0;
      for (; llmRetryAttempt < MAX_LLM_REQUEST_RETRIES; llmRetryAttempt += 1) {
        try {
          const turnRequest = await executeToolCompletionForTurn(
            messages,
            settings,
            runtime,
            activeTools,
            turn,
            signal,
            onAssistantChunk,
            onToolCallEvent,
            toolChoiceOverride,
          );
          // Reset override after use
          toolChoiceOverride = undefined;
          completion = turnRequest.completion;
          console.log(
            `[Loop][ModeResult] turn=${turn + 1} | mode=${turnRequest.requestMode} | fallback=${turnRequest.fallbackTriggered}` +
            (llmRetryAttempt > 0 ? ` | retryAttempt=${llmRetryAttempt}` : ""),
          );
          break;
        } catch (error) {
          lastLLMError = error;
          const currentTokens = estimateCurrentTokens();
          const errorMsg = error instanceof Error ? error.message : String(error);
          const retriable = isRetriableLLMError(error);
          const hasRetriesLeft = llmRetryAttempt + 1 < MAX_LLM_REQUEST_RETRIES;
          console.error(
            `[Loop][Failure] tool completion failed | turn=${turn + 1} | attempt=${llmRetryAttempt + 1}/${MAX_LLM_REQUEST_RETRIES}` +
            ` | retriable=${retriable} | ~tokens=${currentTokens} | messages=${messages.length}` +
            ` | model=${settings.model} | error=${errorMsg}`,
          );
          if (!retriable || !hasRetriesLeft) {
            throw error;
          }
          const delay = computeRetryDelay(llmRetryAttempt);
          console.log(
            `[Loop][Retry] 等待 ${Math.round(delay)}ms 后重试 (attempt ${llmRetryAttempt + 2}/${MAX_LLM_REQUEST_RETRIES})`
          );
          await sleep(delay, signal);
        }
      }
      if (!completion) {
        throw lastLLMError ?? new Error("LLM 请求在重试后仍然失败。");
      }
    }
    requestRecords.push(completion.requestRecord);
    messages.push(completion.assistantMessage);
    if (completion.assistantMessage.tool_calls?.length) {
      lastAssistantToolCalls = completion.assistantMessage.tool_calls;
    }

    // P1-3: Update token calibration with actual API-reported values (per-model).
    if (completion.requestRecord.inputTokens) {
      const estBeforeCall = estimateCurrentTokens() + toolDefTokens;
      updateTokenCalibration(estBeforeCall, completion.requestRecord.inputTokens, settings.model);
    }

    // Handle finish_reason=length: the model was truncated and may have
    // incomplete tool calls. Pop the truncated response and ask to retry
    // with a shorter output or to summarize and use tools.
    if (
      completion.finishReason === "length" &&
      completion.toolCalls.length === 0 &&
      !completion.assistantMessage.content.trim()
    ) {
      console.warn(
        `[Loop] Turn ${turn + 1}: 响应被 max_tokens 截断且无有效内容，请求模型缩短输出后重试`,
      );
      messages.pop();
      messages.push({
        role: "system",
        content: [
          "系统提示：你的上一次回复因为超出最大 token 限制而被截断，系统没有收到完整的回复或工具调用。",
          "请用更简洁的方式回复。如果需要使用工具，直接发送工具调用，不要输出冗长的分析文本。",
          "如果要修改文件，每次只修改一个文件的一小段，避免在单次回复中生成过多内容。",
        ].join("\n"),
      });
      continue;
    }

    if (
      completion.finishReason === "length" &&
      completion.toolCalls.length > 0
    ) {
      console.warn(
        `[Loop] Turn ${turn + 1}: 响应被截断但包含 ${completion.toolCalls.length} 个工具调用，继续处理已解析的调用`,
      );
    }

    if (!completion.toolCalls.length) {
      if (completion.droppedToolCalls > 0) {
        console.warn(`[Loop] Turn ${turn + 1}: ${completion.droppedToolCalls} 个工具调用因格式畸形被丢弃，要求模型重试`);
        messages.pop();
        messages.push({
          role: "system",
          content: [
            `系统提示：模型尝试了 ${completion.droppedToolCalls} 个工具调用，但全部因格式畸形被丢弃（缺少 function.name 或 arguments 不是字符串）。`,
            `可用工具: [${enabledToolNames.join(", ")}]`,
            "请使用正确的工具调用格式重试。",
          ].join("\n"),
        });
        continue;
      }

      const pseudoToolCallReason = toolChoiceOverride !== "none"
        ? (
          detectPseudoToolCallNarration(
            completion.assistantMessage.content,
            enabledToolNames,
          ) ?? detectPseudoToolJsonTranscript(completion.assistantMessage.content)
        )
        : null;
      if (
        pseudoToolCallReason &&
        shouldRetryPseudoToolCall(pseudoToolCallRepairRounds)
      ) {
        pseudoToolCallRepairRounds += 1;
        messages.pop();
        console.warn(
          `[Loop] Turn ${turn + 1}: detected pseudo tool-call narration without native tool_calls (${pseudoToolCallReason}), requesting retry`,
        );
        messages.push({
          role: "system",
          content: buildPseudoToolCallRepairMessage(enabledToolNames),
        });
        continue;
      }

      if (pseudoToolCallReason) {
        const protocol = (runtime.vendorProtocol || "openai-chat-completions");
        const protocolLabel = formatVendorProtocolLabel(protocol);
        console.warn(
          `[Loop] Turn ${turn + 1}: pseudo tool-call output persisted after repair (${pseudoToolCallReason}); returning compatibility diagnostic`,
        );
        return {
          assistantReply: buildPseudoToolCallCompatibilityDiagnostic(protocolLabel),
          requestRecords,
          proposedActions,
          planState,
          toolTrace,
          assistantToolCalls:
            completion.assistantMessage.tool_calls ?? lastAssistantToolCalls,
          assistantToolCallsFromFinalTurn:
            (completion.assistantMessage.tool_calls?.length ?? 0) > 0,
          workingMemorySnapshot: currentWorkingMemorySnapshot(),
        };
      }

      console.log(`[Loop] Turn ${turn + 1} 结束: 模型返回文本回复 (无工具调用)`);
      const finalText = completion.assistantMessage.content.trim();
      return {
        assistantReply: finalText,
        requestRecords,
        proposedActions,
        planState,
        toolTrace,
        assistantToolCalls:
          completion.assistantMessage.tool_calls ?? lastAssistantToolCalls,
        assistantToolCallsFromFinalTurn:
          (completion.assistantMessage.tool_calls?.length ?? 0) > 0,
        workingMemorySnapshot: currentWorkingMemorySnapshot(),
      };
    }

    const toolNames = completion.toolCalls.map((tc) => tc.function.name);
    console.log(
      `[Loop] Turn ${turn + 1} | 收到 ${completion.toolCalls.length} 个工具调用: [${toolNames.join(", ")}]`
    );

    const actionCountBeforeTurn = proposedActions.length;
    let patchPreflightFailure: string | null = null;
    let createPathUsageFailure: string | null = null;
    let shellDialectRepairInstruction: string | null = null;
    let searchNotFoundFailure: string | null = null;
    let turnHasToolNotFound = false;
    let turnSuccessCount = 0;
    let turnFailureCount = 0;
    let turnDedupHitCount = 0;

    // Helper: execute a single tool call and collect results
    const executeSingleToolCall = async (toolCall: ToolCallRecord) => {
      onToolCallEvent?.({
        type: "start",
        callId: toolCall.id,
        toolName: toolCall.function.name,
        argsPreview: summarizeToolArgs(toolCall.function.name, toolCall.function.arguments),
      });

      const toolT0 = performance.now();
      const { result: toolResult, trace } = await executeToolCallWithRetry(
        toolCall,
        settings.workspacePath,
        toolPermissions,
        settings,
        projectConfig,
        enabledToolNames,
        planState,
        workingMemory,
        signal,
        turn,
        focusedPaths,
        sessionId,
        onAskUserRequest,
      );
      const toolMs = (performance.now() - toolT0).toFixed(0);

      onToolCallEvent?.({
        type: "end",
        callId: toolCall.id,
        toolName: toolCall.function.name,
        result: trace.status,
        resultPreview: trace.resultPreview,
      });

      console.log(
        `[Tool] ${toolCall.function.name} → ${trace.status} | ${toolMs}ms` +
        (trace.retried ? ` (retried ×${trace.attempts})` : "") +
        (trace.status === "failed" ? ` | ${trace.errorCategory}: ${trace.errorMessage}` : "")
      );

      return { toolCall, toolResult, trace };
    };

    // Helper: process a tool result (update counters, extract knowledge, push messages)
    const processToolResult = (
      toolCall: ToolCallRecord,
      toolResult: ToolExecutionResult,
      trace: ToolExecutionTrace,
    ) => {
      toolTrace.push(trace);

      if (toolResult.success === false) {
        turnFailureCount += 1;
        if (toolResult.errorCategory === "tool_not_found") {
          turnHasToolNotFound = true;
        }
      } else {
        turnSuccessCount += 1;

        // Track file modifications for workspace refresh
        if (toolCall.function.name === "propose_file_edit" || toolCall.function.name === "propose_apply_patch") {
          hasModifiedFiles = true;
        }

        // Detect dedup cache hits
        try {
          const parsedContent = JSON.parse(toolResult.content);
          if (parsedContent.status === "cached") {
            turnDedupHitCount += 1;
          }
        } catch { /* not JSON or not cached */ }

        try {
          const parsedArgs = JSON.parse(toolCall.function.arguments || "{}");
          const knowledge = extractFileKnowledge(
            toolCall.function.name,
            parsedArgs,
            toolResult.content,
            "main",
            turn,
          );
          if (knowledge) {
            workingMemory.fileKnowledge.set(knowledge.relativePath, knowledge);
          }
        } catch {
          // Ignore parse errors for working memory extraction
        }
      }

      if (
        toolResult.success === false &&
        toolResult.errorCategory === "validation" &&
        (toolCall.function.name === "propose_apply_patch" ||
          toolCall.function.name === "propose_file_edit") &&
        (toolResult.errorMessage ?? "").includes("Patch 预检失败")
      ) {
        patchPreflightFailure = toolResult.errorMessage ?? "Patch 预检失败";
      }
      if (
        toolResult.success === false &&
        toolResult.errorCategory === "validation" &&
        toolCall.function.name === "propose_file_edit" &&
        ((toolResult.errorMessage ?? "")
          .toLowerCase()
          .includes("invalid target path") ||
          (toolResult.errorMessage ?? "")
            .toLowerCase()
            .includes("no such file or directory"))
      ) {
        createPathUsageFailure = toolResult.errorMessage ?? "目标路径不存在";
      }
      if (
        toolResult.success === false &&
        toolResult.errorCategory === "validation" &&
        toolCall.function.name === "propose_file_edit" &&
        ((toolResult.errorMessage ?? "").includes("片段未找到"))
      ) {
        searchNotFoundFailure = toolResult.errorMessage ?? "search 片段未找到";
      }
      if (
        toolCall.function.name === "propose_file_edit" &&
        toolResult.success === false &&
        toolResult.errorCategory === "validation"
      ) {
        try {
          const editArgs = JSON.parse(toolCall.function.arguments || "{}");
          const editPath = editArgs.relative_path ?? "";
          if (editPath) {
            fileEditFailureTracker.set(editPath, (fileEditFailureTracker.get(editPath) ?? 0) + 1);
          }
        } catch { /* ignore */ }
      } else if (
        toolCall.function.name === "propose_file_edit" &&
        toolResult.success !== false
      ) {
        try {
          const editArgs = JSON.parse(toolCall.function.arguments || "{}");
          const editPath = editArgs.relative_path ?? "";
          if (editPath) {
            fileEditFailureTracker.delete(editPath);
          }
        } catch { /* ignore */ }
      }
      const shellRepairHint = buildShellDialectRepairInstruction(
        toolCall,
        toolResult,
      );
      if (shellRepairHint) {
        shellDialectRepairInstruction = shellRepairHint;
      }
      // P0-1: Collect proposed actions from tool results, filtering blocked fingerprints
      const incomingActions: ActionProposal[] = [];
      if (toolResult.proposedActions && toolResult.proposedActions.length > 0) {
        incomingActions.push(...toolResult.proposedActions);
      } else if (toolResult.proposedAction) {
        incomingActions.push(toolResult.proposedAction);
      }
      for (const action of incomingActions) {
        const fp = action.fingerprint || actionFingerprint(action);
        if (blockedFingerprintSet.has(fp)) {
          console.warn(
            `[Planning][ProcessToolResult] Suppressing blocked action in-loop | type=${action.type} | fingerprint=${fp}`
          );
          continue;
        }
        // P5-2: Mark action origin for audit trail
        if (!action.origin) {
          action.origin = "main_agent";
        }
        const linkedAction = attachActionToPlanStep(planState, action);
        proposedActions.push(linkedAction);
      }
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        name: toolCall.function.name,
        content: trimToolContentForContext(
          toolCall.function.name,
          toolResult.content,
          { smartTruncate },
        ),
      });
    };

    // --- Phase 4: Split tool calls into parallelizable groups ---
    // Read-only tools have no side effects and can safely run in parallel.
    // Write/mutation tools (propose_*, update_plan, shell-related) must run
    // serially to preserve ordering dependencies.
    // Task (sub-agent) calls have their own parallel execution path.
    const PARALLEL_SAFE_TOOL_NAMES = new Set([
      "read_file", "grep", "glob", "list_files",
      "git_status", "git_diff", "diagnostics",
      "web_search", "web_fetch",
      "check_shell_job",
    ]);
    const MAX_PARALLEL_READ_TOOLS = 15;

    const readOnlyCalls = completion.toolCalls.filter(
      (tc) => PARALLEL_SAFE_TOOL_NAMES.has(tc.function.name),
    );
    const mutationCalls = completion.toolCalls.filter(
      (tc) => !PARALLEL_SAFE_TOOL_NAMES.has(tc.function.name),
    );

    let planMutatedThisTurn = false;

    // 1. Execute read-only tools in parallel (no ordering dependencies)
    if (readOnlyCalls.length > 1) {
      console.log(`[Orchestrator] 并行执行 ${readOnlyCalls.length} 个只读工具调用`);
      const readResults = await runWithConcurrencyLimit(
        readOnlyCalls.map((tc) => () => executeSingleToolCall(tc)),
        MAX_PARALLEL_READ_TOOLS,
      );
      for (const settled of readResults) {
        if (settled.status === "fulfilled") {
          const { toolCall, toolResult, trace } = settled.value;
          processToolResult(toolCall, toolResult, trace);
        } else {
          console.error(`[Orchestrator] 并行只读工具执行异常:`, settled.reason);
        }
      }
    } else if (readOnlyCalls.length === 1) {
      const { toolCall, toolResult, trace } = await executeSingleToolCall(readOnlyCalls[0]);
      processToolResult(toolCall, toolResult, trace);
    }

    // 2. Execute mutation tools serially (they may have ordering dependencies)
    for (const toolCall of mutationCalls) {
      const { toolResult, trace } = await executeSingleToolCall(toolCall);
      processToolResult(toolCall, toolResult, trace);
      if (
        toolCall.function.name === "update_plan" ||
        toolCall.function.name.startsWith("propose_")
      ) {
        planMutatedThisTurn = true;
      }
    }


    if (planMutatedThisTurn && onPlanStateUpdate) {
      try {
        const clonedActions = JSON.parse(JSON.stringify(proposedActions));
        onPlanStateUpdate(clonePlanState(planState), clonedActions);
      } catch (err) {
        console.warn(`[Loop] onPlanStateUpdate failed:`, err);
      }
    }

    // Notify caller of updated context size after all tool results are added
    emitContextUpdate();

    // --- 重复读取提醒：当本轮大部分 read_file 都命中缓存时，注入已知文件清单 ---
    if (turnDedupHitCount > 0 && turnDedupHitCount >= Math.ceil(turnSuccessCount * 0.5)) {
      const knownFilesList = [...workingMemory.fileKnowledge.entries()]
        .sort((a, b) => (b[1].lastReadTurn ?? 0) - (a[1].lastReadTurn ?? 0))
        .slice(0, 20)
        .map(([path, fk]) => `- ${path} (${fk.totalLines}行, ${fk.language ?? "?"}): ${fk.summary}`)
        .join("\n");
      console.log(`[Loop] Turn ${turn + 1}: ${turnDedupHitCount}/${turnSuccessCount} 个工具调用命中去重缓存`);
      messages.push({
        role: "system",
        content: [
          `系统提示：本轮 ${turnDedupHitCount} 个文件读取命中了去重缓存，说明你正在重复读取已知文件。`,
          "以下是你已经读取过的文件及其摘要，请直接利用这些信息，不要再次读取：",
          knownFilesList,
          "请基于已有信息继续推进任务，而非重复读取。如需特定代码片段，请用 start_line/end_line 精确读取。",
        ].join("\n"),
      });
    }

    // --- 连续纯读取检测 ---
    const turnHasPropose = completion.toolCalls.some(tc => tc.function.name.startsWith("propose_"));
    const turnHasTaskDelegation = completion.toolCalls.some(tc => tc.function.name === "task");

    if (!turnHasPropose && !turnHasTaskDelegation && turnSuccessCount > 0) {
      consecutiveReadOnlyTurns += 1;
    } else {
      consecutiveReadOnlyTurns = 0;
    }

    if (shouldForceReadOnlySummary(consecutiveReadOnlyTurns)) {
      console.log(`[Loop] 连续 ${consecutiveReadOnlyTurns} 轮纯读取，强制要求总结`);
      messages.push({
        role: "system",
        content: buildReadOnlyTurnsWarningMessage(consecutiveReadOnlyTurns),
      });
      toolChoiceOverride = "none";
      consecutiveReadOnlyTurns = 0;
    }

    // --- Circuit breaker: tool_not_found ---
    if (turnHasToolNotFound) {
      toolNotFoundStrikes += 1;
    } else {
      toolNotFoundStrikes = 0;
    }
    if (shouldStopForToolNotFound(toolNotFoundStrikes)) {
      console.warn(`[Loop] 熔断: tool_not_found 连续 ${toolNotFoundStrikes} 轮，终止循环`);
      return {
        assistantReply:
          "模型多次调用不存在的工具，已自动终止。请检查模型能力或切换至更强的模型。",
        requestRecords,
        proposedActions,
        planState,
        toolTrace,
        workingMemorySnapshot: currentWorkingMemorySnapshot(),
      };
    }
    if (shouldWarnForToolNotFound(toolNotFoundStrikes)) {
      messages.push({
        role: "system",
        content: buildToolNotFoundWarningMessage(toolNotFoundStrikes, enabledToolNames),
      });
    }

    // --- Circuit breaker: consecutive all-failure turns ---
    if (turnSuccessCount === 0 && turnFailureCount > 0) {
      consecutiveFailureTurns += 1;
    } else {
      consecutiveFailureTurns = 0;
    }
    if (shouldStopForConsecutiveFailures(consecutiveFailureTurns)) {
      console.warn(`[Loop] 熔断: 连续 ${consecutiveFailureTurns} 轮全部失败，终止循环`);
      return {
        assistantReply:
          "连续多轮工具调用全部失败，已自动终止。请检查工具参数或任务描述后重试。",
        requestRecords,
        proposedActions,
        planState,
        toolTrace,
        workingMemorySnapshot: currentWorkingMemorySnapshot(),
      };
    }

    // --- Circuit breaker: same-file consecutive edit failures ---
    for (const [filePath, failCount] of fileEditFailureTracker) {
      if (failCount >= MAX_SAME_FILE_EDIT_FAILURES) {
        console.warn(`[Loop] 熔断: 文件 ${filePath} 连续编辑失败 ${failCount} 次`);
        messages.push({
          role: "system",
          content: buildSameFileEditFailureMessage(filePath, failCount),
        });
        fileEditFailureTracker.delete(filePath);
        break;
      }
    }

    // Repair hints: trigger when the current turn produced no new actions (i.e. the
    // failure prevented creating a proposal). Previously gated on `!proposedActions.length`
    // which silently skipped repairs when earlier turns had already accumulated actions.
    const noNewActionsThisTurn = proposedActions.length === actionCountBeforeTurn;

    if (
      noNewActionsThisTurn &&
      patchPreflightFailure &&
      patchRepairRounds < MAX_PATCH_REPAIR_ROUNDS
    ) {
      patchRepairRounds += 1;
      messages.push({
        role: "system",
        content: buildPatchPreflightRepairMessage(patchPreflightFailure),
      });
      continue;
    }

    if (
      noNewActionsThisTurn &&
      createPathUsageFailure &&
      createHintRepairRounds < MAX_CREATE_HINT_REPAIR_ROUNDS
    ) {
      createHintRepairRounds += 1;
      messages.push({
        role: "system",
        content: buildCreatePathRepairMessage(createPathUsageFailure),
      });
      continue;
    }

    if (
      noNewActionsThisTurn &&
      searchNotFoundFailure &&
      searchNotFoundRepairRounds < MAX_SEARCH_NOT_FOUND_REPAIR_ROUNDS
    ) {
      searchNotFoundRepairRounds += 1;
      messages.push({
        role: "system",
        content: buildSearchNotFoundRepairMessage(searchNotFoundFailure),
      });
      continue;
    }

    if (
      noNewActionsThisTurn &&
      shellDialectRepairInstruction &&
      shellDialectRepairRounds < MAX_SHELL_DIALECT_REPAIR_ROUNDS
    ) {
      shellDialectRepairRounds += 1;
      messages.push({
        role: "system",
        content: shellDialectRepairInstruction,
      });
      continue;
    }

    const plannedArtifacts = countPlannedArtifacts(proposedActions);

    if (requestedArtifactCount > 1) {
      if (
        plannedArtifacts > 0 &&
        plannedArtifacts < requestedArtifactCount &&
        multiArtifactReminderRounds < MAX_MULTI_ARTIFACT_REMINDER_ROUNDS &&
        proposedActions.length < MAX_PROPOSED_ACTIONS_PER_BATCH
      ) {
        multiArtifactReminderRounds += 1;
        messages.push({
          role: "system",
          content: [
            "系统提示：用户请求包含多个交付物。",
            `当前已提出 ${plannedArtifacts} 个交付物相关动作，目标至少 ${requestedArtifactCount} 个。`,
            "请继续提出剩余缺失交付物的审批动作；不要重复已有动作。",
            "仅在所有请求交付物都已覆盖，或确实无法继续时，才停止工具调用。",
          ].join("\n"),
        });
        continue;
      }
    }

    if (proposedActions.length > 0) {
      const reachedBatchLimit =
        proposedActions.length >= MAX_PROPOSED_ACTIONS_PER_BATCH;
      const coverageSatisfied =
        requestedArtifactCount <= 1 ||
        plannedArtifacts === 0 ||
        plannedArtifacts >= requestedArtifactCount;
      const shouldReturnNow =
        reachedBatchLimit ||
        coverageSatisfied ||
        multiArtifactReminderRounds >= MAX_MULTI_ARTIFACT_REMINDER_ROUNDS;

      if (!shouldReturnNow) {
        messages.push({
          role: "system",
          content:
            "系统提示：你已经提出了部分待审批动作。请继续补齐剩余缺失交付物，直到达到交付覆盖目标或达到单批动作上限。",
        });
        continue;
      }

      return {
        assistantReply: completion.assistantMessage.content.trim(),
        requestRecords,
        proposedActions,
        planState,
        toolTrace,
        workingMemorySnapshot: currentWorkingMemorySnapshot(),
      };
    }
  }

  console.warn(`[Loop] 主循环意外退出`);
  return {
    assistantReply: "工具调用循环已结束。如果任务尚未完成，请回复「继续」。",
    requestRecords,
    proposedActions,
    planState,
    toolTrace,
    workingMemorySnapshot: currentWorkingMemorySnapshot(),
  };
}

function sanitizeStepsFromPrompt(prompt: string): PlanStep[] {
  const normalized = prompt.trim() || "实现用户提出的功能";
  return normalizeTodoPlanState({
    steps: [
      {
        id: "step-plan",
        title: "分析需求",
        owner: "planner",
        status: "in_progress",
        summary: `分析需求并拆解执行步骤: ${normalized}`,
      },
      {
        id: "step-implement",
        title: "执行实现",
        owner: "coder",
        status: "pending",
        summary: "基于任务生成实现或回答",
        dependsOn: ["step-plan"],
      },
      {
        id: "step-verify",
        title: "补充验证",
        owner: "tester",
        status: "pending",
        summary: "补充验证建议并总结风险",
        dependsOn: ["step-implement"],
      },
    ],
    activeStepId: "step-plan",
  }).steps;
}

function shouldUseTodoPlanning(
  prompt: string,
  requestedArtifactCount: number,
): boolean {
  const normalized = prompt.trim();
  if (!normalized) {
    return false;
  }
  if (/(todo|拆解|分步|步骤|计划|逐项|先.+再)/i.test(normalized)) {
    return true;
  }
  if (requestedArtifactCount >= 2) {
    return true;
  }
  return normalized.length >= 50;
}

function buildProposedActions(
  fromTools: ActionProposal[],
  blockedFingerprints: Iterable<string> = []
): ActionProposal[] {
  const uniqueActions: ActionProposal[] = [];
  const seen = new Set<string>();
  const blocked = new Set(
    Array.from(blockedFingerprints, (value) => value.trim()).filter(Boolean)
  );

  for (const action of fromTools) {
    const validationError = validateProposedAction(action);
    if (validationError) {
      console.warn(
        `[Planning][ProposedActions] Dropping invalid proposed action | type=${action.type} | action=${action.id} | reason=${validationError}`
      );
      continue;
    }

    const fingerprint = actionFingerprint(action);

    if (blocked.has(fingerprint)) {
      console.warn(
        `[Planning][ProposedActions] Dropping blocked proposed action | type=${action.type} | action=${action.id} | fingerprint=${fingerprint}`
      );
      continue;
    }

    if (seen.has(fingerprint)) {
      console.warn(
        `[Planning][ProposedActions] Dropping duplicate proposed action | type=${action.type} | action=${action.id} | fingerprint=${fingerprint}`
      );
      continue;
    }

    seen.add(fingerprint);
    if (!action.fingerprint) {
      action.fingerprint = fingerprint;
    }
    uniqueActions.push(action);
  }

  // --- Phase 5: Action Group semantics for multi-patch batches ---
  // Only when the same round produces 2+ patch actions with pairwise-disjoint target files,
  // assign a shared groupId for atomic combined apply. Same-file or unknown-target patches
  // must not share a batch (combined git-apply often fails and rolls back the whole group).
  const patchActions = uniqueActions.filter(
    (a): a is ApplyPatchActionProposal => a.type === "apply_patch"
  );
  if (
    patchActions.length > 1 &&
    applyPatchTargetsAreDisjointForBatching(patchActions)
  ) {
    const groupId = createActionId("action-group");
    const createdAt = nowIso();
    const files = Array.from(
      new Set(patchActions.flatMap((a) => collectPatchedFiles(a.payload.patch)))
    );
    const title =
      files.length > 0
        ? `批量补丁（${files.length} 个文件）`
        : `批量补丁（${patchActions.length} 个 patch）`;

    for (const action of patchActions) {
      action.group = {
        groupId,
        title,
        atomicIntent: true,
        createdAt,
      };
    }
  }

  return uniqueActions;
}

export function initializePlan(
  prompt: string,
  settings: AppSettings,
  proposedActions: ActionProposal[],
  planState: TodoPlanState,
): OrchestrationPlan {
  const normalizedPlanState = syncPlanStateWithActions(planState, proposedActions);
  return {
    state: derivePlanWorkflowState(proposedActions, normalizedPlanState),
    prompt: prompt.trim() || "实现用户提出的功能",
    steps: normalizedPlanState.steps,
    activeStepId: normalizedPlanState.activeStepId,
    proposedActions,
    workspacePath: settings.workspacePath.trim(),
  };
}

export function actionFingerprint(action: ActionProposal): string {
  if (action.type === "apply_patch") {
    const normalizedPatch = normalizeWhitespace(action.payload.patch);
    const patchHash = hashText(normalizedPatch);
    const files = collectPatchedFiles(action.payload.patch)
      .map((file) => file.trim())
      .filter(Boolean)
      .sort();
    const operationKinds = detectPatchOperationKinds(action.payload.patch);

    // Fingerprint must be stable enough to block exact duplicates,
    // but not so coarse that any follow-up edit to the same file becomes impossible.
    const context =
      files.length > 0
        ? `${operationKinds.join(",")}:${files.join("|")}`
        : "raw";
    return `${action.type}:${context}:${patchHash}`;
  }
  // action.type === "shell"
  const normalizedShell = normalizeWhitespace(action.payload.shell);
  const executionMode = action.payload.executionMode ?? "foreground";
  const readyUrl = (action.payload.readyUrl ?? "").trim();
  const readyTimeoutMs = action.payload.readyTimeoutMs ?? "";
  return `${action.type}:${normalizedShell}:${action.payload.timeoutMs}:${executionMode}:${readyUrl}:${readyTimeoutMs}`;
}

function validateProposedAction(action: ActionProposal): string | null {
  if (action.type === "apply_patch") {
    if (!action.payload.patch.trim()) {
      return "patch 不能为空";
    }
    return null;
  }

  if (action.type === "shell") {
    if (!action.payload.shell.trim()) {
      return "shell 命令不能为空";
    }
    if (action.payload.timeoutMs < 1000 || action.payload.timeoutMs > 600000) {
      return "timeout 超出范围";
    }
    if (
      action.payload.readyTimeoutMs !== undefined &&
      (action.payload.readyTimeoutMs < 1000 || action.payload.readyTimeoutMs > 120000)
    ) {
      return "ready timeout 超出范围";
    }
    return null;
  }

  return null;
}


function containsCapabilityDenial(text: string): boolean {
  const corpus = text.toLowerCase();
  const hints = [
    "只读",
    "read-only",
    "无法执行文件创建",
    "当前工具路由模式为只读",
    "仅支持 [list_files, read_file, git_status, git_diff]",
  ];
  return hints.some((hint) => corpus.includes(hint.toLowerCase()));
}

const APPROVAL_CARD_CLAIM_HINTS = [
  "审批卡片",
  "待审批动作",
  "查看下方",
  "查看审批",
  "审批面板",
];

function containsApprovalCardClaim(text: string): boolean {
  const corpus = text.toLowerCase();
  return APPROVAL_CARD_CLAIM_HINTS.some((hint) => corpus.includes(hint));
}

function stripApprovalCardClaims(text: string): string {
  const sentences = text.split(/(?<=[。！？\n])/);
  const kept = sentences.filter(
    (s) => !APPROVAL_CARD_CLAIM_HINTS.some((h) => s.includes(h))
  );
  return kept.join("").trim();
}

const MISSING_APPROVAL_CARD_MESSAGE =
  "工具已创建待审批动作，但审批卡片未能保留。请检查工具调用详情与日志。";

function hasPendingApprovalTrace(toolTrace: ToolExecutionTrace[]): boolean {
  return toolTrace.some((trace) => trace.status === "pending_approval");
}

function reconcileAssistantReply(params: {
  assistantReply: string;
  proposedActions: ActionProposal[];
  toolTrace: ToolExecutionTrace[];
  assistantToolCalls?: LiteLLMMessage["tool_calls"];
  assistantToolCallsFromFinalTurn?: boolean;
}): string {
  const {
    assistantReply,
    proposedActions,
    toolTrace,
    assistantToolCalls,
    assistantToolCallsFromFinalTurn,
  } = params;
  const normalized = assistantReply.trim();
  const hasAssistantToolCalls = (assistantToolCalls?.length ?? 0) > 0;
  const hasCurrentAssistantToolCalls =
    hasAssistantToolCalls && (assistantToolCallsFromFinalTurn ?? true);
  const hasPendingApprovalToolCall = hasPendingApprovalTrace(toolTrace);

  if (!normalized) {
    if (hasCurrentAssistantToolCalls) {
      if (proposedActions.length > 0) {
        return "模型已请求工具调用，并已生成待审批动作，请查看下方工具调用与审批卡片。";
      }
      if (hasPendingApprovalToolCall) {
        return MISSING_APPROVAL_CARD_MESSAGE;
      }
      if (toolTrace.length > 0) {
        const hasSuccess = toolTrace.some((t) => t.status === "success");
        return hasSuccess
          ? "已完成工具调用，请查看下方工具调用详情。"
          : "模型已请求工具调用，请查看下方工具调用详情。";
      }
      return "模型已请求工具调用，请查看下方工具调用详情。";
    }
    if (proposedActions.length > 0) {
      return "已生成待审批动作，请查看下方审批卡片。";
    }
    if (hasPendingApprovalToolCall) {
      return MISSING_APPROVAL_CARD_MESSAGE;
    }
    // 兜底：有工具调用但LLM未返回文本（弱模型常见）
    if (toolTrace.length > 0) {
      const hasSuccess = toolTrace.some((t) => t.status === "success");
      if (hasSuccess) {
        return "已完成工具调用。";
      }
      return "工具调用已结束。";
    }
    // 最终兜底：确保不返回空字符串
    return "处理完成。";
  }

  // 反向修正：LLM 文本声称生成了审批卡片，但实际 proposedActions 为空
  if (proposedActions.length === 0 && containsApprovalCardClaim(normalized)) {
    const cleaned = stripApprovalCardClaims(normalized);
    if (hasPendingApprovalToolCall) {
      return cleaned
        ? `${cleaned}\n\n${MISSING_APPROVAL_CARD_MESSAGE}`
        : MISSING_APPROVAL_CARD_MESSAGE;
    }
    if (cleaned) {
      return cleaned;
    }
    if (hasCurrentAssistantToolCalls) {
      return "模型已请求工具调用，请查看下方工具调用详情。";
    }
    if (toolTrace.length > 0) {
      const hasSuccess = toolTrace.some((t) => t.status === "success");
      return hasSuccess
        ? "已完成工具调用，但未能生成有效的审批动作。请检查任务描述后重试。"
        : "工具调用未能成功生成审批动作，请检查任务描述后重试。";
    }
    return "处理完成。";
  }

  if (hasPendingApprovalToolCall && proposedActions.length === 0) {
    return `${normalized}\n\n${MISSING_APPROVAL_CARD_MESSAGE}`;
  }

  if (!containsCapabilityDenial(normalized)) {
    return normalized;
  }

  const hasSuccessfulToolCall = toolTrace.some(
    (trace) => trace.status === "success"
  );
  if (!hasSuccessfulToolCall && !hasPendingApprovalToolCall) {
    return normalized;
  }

  if (proposedActions.length > 0) {
    return "已生成待审批动作，请查看下方审批卡片。";
  }

  if (hasPendingApprovalToolCall) {
    return MISSING_APPROVAL_CARD_MESSAGE;
  }

  if (hasCurrentAssistantToolCalls) {
    return "模型已请求工具调用，请查看下方工具调用详情。";
  }

  return normalized;
}

export const planningServiceTestUtils = {
  executeToolCall,
  buildProposedActions,
  reconcileAssistantReply,
  summarizeToolArgs,
  sanitizeMessagesForToolCalling,
  pruneStaleSystemMessages,
  detectPseudoToolCallNarration,
  detectPseudoToolJsonTranscript,
  evaluateCompressionSafeZone,
};

function assertLocalOnlyPolicy(settings: AppSettings): void {
  if (settings.allowCloudModels) {
    return;
  }

  if (isActiveModelLocal(settings)) {
    return;
  }

  throw new LocalOnlyPolicyError(
    "Local-only 已开启，请切换到本地 Provider（如 Ollama）后再发起请求。"
  );
}

export async function runPlanningSession(
  input: RunPlanningSessionInput
): Promise<PlanningSessionResult> {
  const normalizedPrompt = input.prompt.trim();
  if (!normalizedPrompt) {
    throw new Error("请输入任务描述后再发送。");
  }

  assertLocalOnlyPolicy(input.settings);
  const phase = input.phase ?? "default";
  const historyMessages = normalizeConversationHistory(input.conversationHistory);
  const runtime = resolveAgentRuntime(input.agentId ?? null, input.settings);

  const sessionT0 = performance.now();
  console.log(
    `[Planning] ═══ 会话开始 ═══ | agent=${runtime.agentId} | model=${input.settings.model} | phase=${phase} | history=${historyMessages.length} | continuation=${!!input.isContinuation}`
  );
  console.log(`[Planning] prompt: "${normalizedPrompt.slice(0, 120)}${normalizedPrompt.length > 120 ? "…" : ""}"`
  );

  let initialInternalNote = input.internalSystemNote;
  let projectConfig: CofreeRcConfig = {};
  const sessionFocusedPaths = normalizeFocusedPathList(
    (input.contextAttachments ?? []).map((attachment) => attachment.relativePath),
  );
  let initialPlanSeed: InitialPlanSeed = {
    ...normalizeTodoPlanState({
      steps: input.existingPlan?.steps?.length
        ? input.existingPlan.steps
        : [],
      activeStepId: input.existingPlan?.activeStepId,
    }),
    source: input.existingPlan?.steps?.length ? "existing" : "fallback",
  };

  if (
    input.settings.workspacePath
  ) {
    const shouldLoadProjectConfig =
      (historyMessages.length === 0 && !input.isContinuation) ||
      (input.contextAttachments?.length ?? 0) > 0;

    // Load project-level .cofreerc config
    try {
      if (shouldLoadProjectConfig) {
        projectConfig = await loadCofreeRc(input.settings.workspacePath);
      }
    } catch (e) {
      console.warn("Failed to load .cofreerc", e);
    }

    if ((input.contextAttachments?.length ?? 0) > 0) {
      try {
        const explicitContext = await buildExplicitContextNote({
          attachments: input.contextAttachments ?? [],
          settings: input.settings,
          projectConfig,
          ignorePatterns:
            projectConfig.ignorePatterns && projectConfig.ignorePatterns.length > 0
              ? projectConfig.ignorePatterns
              : null,
        });
        if (explicitContext) {
          initialInternalNote = initialInternalNote
            ? `${explicitContext}\n\n${initialInternalNote}`
            : explicitContext;
        }
      } catch (e) {
        console.warn("Failed to build explicit context note", e);
      }
    }

    if (
      historyMessages.length === 0 &&
      !input.isContinuation
    ) {
      // Inject workspace overview
      try {
        const overviewBudget: WorkspaceOverviewBudget | undefined =
          projectConfig.overviewBudget;

        const overview = await summarizeWorkspaceFiles(
          input.settings.workspacePath,
          projectConfig.ignorePatterns && projectConfig.ignorePatterns.length > 0
            ? projectConfig.ignorePatterns
            : null,
          overviewBudget
        );
        const overviewPrompt = `项目概览：\n${overview}`;
        if (initialInternalNote) {
          initialInternalNote = `${initialInternalNote}\n\n${overviewPrompt}`;
        } else {
          initialInternalNote = overviewPrompt;
        }
      } catch (e) {
        console.warn("Failed to generate workspace overview", e);
      }

      // Inject repo-map (project structure with symbols)
      if (projectConfig.repoMap?.enabled !== false) try {
        const contextLimit = resolveEffectiveContextTokenLimit(input.settings);
        const repoMapBudget = Math.min(
          4000,
          Math.max(500, Math.floor(contextLimit * 0.03)),
        );
        const repoMap = await generateRepoMap(
          input.settings.workspacePath,
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
          if (initialInternalNote) {
            initialInternalNote = `${initialInternalNote}\n\n${repoMap}`;
          } else {
            initialInternalNote = repoMap;
          }
          console.log(
            `[Planning] Repo-map injected (~${repoMap.length} chars)`,
          );
        }
      } catch (e) {
        console.warn("Failed to generate repo-map", e);
      }

      // Inject .cofreerc prompt fragment
      const rcFragment = buildCofreeRcPromptFragment(projectConfig);
      if (rcFragment) {
        if (initialInternalNote) {
          initialInternalNote = `${initialInternalNote}\n\n${rcFragment}`;
        } else {
          initialInternalNote = rcFragment;
        }
      }

      // Load contextFiles specified in .cofreerc
      if (
        projectConfig.contextFiles &&
        projectConfig.contextFiles.length > 0 &&
        input.settings.workspacePath
      ) {
        const contextSnippets: string[] = [];
        const ignorePatterns =
          projectConfig.ignorePatterns && projectConfig.ignorePatterns.length > 0
            ? projectConfig.ignorePatterns
            : null;

        for (const relPath of projectConfig.contextFiles) {
          try {
            const result = await invoke<{
              content: string;
              total_lines: number;
              start_line: number;
              end_line: number;
            }>("read_workspace_file", {
              workspacePath: input.settings.workspacePath,
              relativePath: relPath,
              startLine: null,
              endLine: null,
              ignorePatterns,
            });
            if (result.content && result.content.trim()) {
              const truncated =
                result.content.length > 2000
                  ? result.content.slice(0, 2000) + "\n... (truncated)"
                  : result.content;
              contextSnippets.push(`--- ${relPath} ---\n${truncated}`);
            }
          } catch {
            // File not found / ignored / can't be read — skip silently
          }
        }
        if (contextSnippets.length > 0) {
          const contextBlock = `[项目关键文件]\n${contextSnippets.join("\n\n")}`;
          initialInternalNote = initialInternalNote
            ? `${initialInternalNote}\n\n${contextBlock}`
            : contextBlock;
        }
      }
    }
  }

  if (!input.existingPlan?.steps?.length) {
    const requestedArtifactCount = estimateRequestedArtifactCount(normalizedPrompt);
    if (shouldUseTodoPlanning(normalizedPrompt, requestedArtifactCount)) {
      initialPlanSeed = {
        ...normalizeTodoPlanState({
          steps: sanitizeStepsFromPrompt(normalizedPrompt),
          activeStepId: "step-plan",
        }),
        source: "fallback",
      };
    }
  }

  try {
    const loopResult = await runNativeToolCallingLoop(
      normalizedPrompt,
      input.settings,
      runtime,
      phase,
      historyMessages,
      initialPlanSeed,
      initialInternalNote,
      input.blockedActionFingerprints ?? [],
      input.signal,
      input.onAssistantChunk,
      input.isContinuation,
      projectConfig,
      input.onToolCallEvent,
      input.onContextUpdate,
      input.onLoopCheckpoint,
      input.onPlanStateUpdate,
      sessionFocusedPaths,
      input.sessionId,
      input.onAskUserRequest,
      // P3-2: Pass restored working memory from checkpoint
      input.restoredWorkingMemory,
      // Explicit skill IDs from @-mention selection
      input.explicitSkillIds,
    );

    // Filter out internal tools from the final `assistantToolCalls` so that
    // the UI message object only contains user-facing proposed actions.
    for (const record of loopResult.requestRecords) {
      recordLLMAudit({
        requestId: record.requestId,
        provider: input.settings.provider ?? input.settings.liteLLMBaseUrl,
        model: input.settings.model,
        timestamp: new Date().toISOString(),
        inputLength: record.inputLength,
        outputLength: record.outputLength,
      });
    }

    // Compute total token usage across all turns.
    // Prefer actual API-reported values; fall back to estimates (1 token ≈ 2.5 chars).
    // For input tokens, use the last turn's prompt_tokens (it represents the full context size).
    // For output tokens, sum all turns' completion_tokens.
    const lastRecord = loopResult.requestRecords[loopResult.requestRecords.length - 1];
    const totalInputTokens = lastRecord
      ? (lastRecord.inputTokens ?? Math.ceil(lastRecord.inputLength / 2.5))
      : 0;
    const totalOutputTokens = loopResult.requestRecords.reduce((sum, r) => {
      return sum + (r.outputTokens ?? Math.ceil(r.outputLength / 2.5));
    }, 0);

    const sessionElapsed = ((performance.now() - sessionT0) / 1000).toFixed(2);
    console.log(
      `[Planning] ═══ 会话完成 ═══ | ${sessionElapsed}s` +
      ` | turns=${loopResult.requestRecords.length}` +
      ` | tools=${loopResult.toolTrace.length}` +
      ` | actions=${loopResult.proposedActions.length}` +
      ` | in≈${totalInputTokens} out≈${totalOutputTokens}`
    );

    const proposedActions = buildProposedActions(
      loopResult.proposedActions,
      input.blockedActionFingerprints
    );
    const plan = initializePlan(
      normalizedPrompt,
      input.settings,
      proposedActions,
      loopResult.planState,
    );
    const assistantToolCalls =
      loopResult.assistantToolCalls ??
      (proposedActions.length > 0
        ? proposedActions.map((action) => ({
          id: action.toolCallId || action.id,
          type: "function" as const,
          function: {
            name:
              action.toolName ||
              (action.type === "shell" ? "propose_shell" : "propose_file_edit"),
            arguments: JSON.stringify(action.payload),
          },
        }))
        : undefined);
    const assistantReply = reconcileAssistantReply({
      assistantReply: loopResult.assistantReply,
      proposedActions,
      toolTrace: loopResult.toolTrace,
      assistantToolCalls,
      assistantToolCallsFromFinalTurn:
        loopResult.assistantToolCallsFromFinalTurn,
    });

    return {
      assistantReply,
      plan,
      toolTrace: loopResult.toolTrace,
      assistantToolCalls,
      workingMemorySnapshot: loopResult.workingMemorySnapshot,
      tokenUsage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      const sessionElapsed = ((performance.now() - sessionT0) / 1000).toFixed(2);
      console.log(`[Planning] 会话被用户中止 | ${sessionElapsed}s`);
      throw error;
    }
    const sessionElapsed = ((performance.now() - sessionT0) / 1000).toFixed(2);
    console.error(`[Planning] ═══ 会话失败 ═══ | ${sessionElapsed}s |`, error);
    
    const errorMessage = error instanceof Error ? error.message : String(error || "Unknown error");
    const errorStack = error instanceof Error ? error.stack : undefined;
    
    const protocol = getActiveVendor(input.settings)?.protocol ?? "openai-chat-completions";
    const baseUrl = getActiveVendor(input.settings)?.baseUrl || input.settings.liteLLMBaseUrl;
    const modelName = getActiveManagedModel(input.settings)?.name || input.settings.model;
    
    const debugInfo = [
      `错误信息: ${errorMessage}`,
      ``,
      `调试信息:`,
      `- 模型: ${modelName}`,
      `- 协议: ${protocol}`,
      `- 端点: ${baseUrl}`,
      `- 时间: ${new Date().toISOString()}`,
      `- 耗时: ${sessionElapsed}s`,
    ];
    
    if (errorStack) {
      debugInfo.push(``, `堆栈跟踪:`, errorStack);
    }
    
    const debugText = debugInfo.join('\n');
    
    console.error('[Planning] 完整错误信息:', debugText);

    throw error;
  }
}
