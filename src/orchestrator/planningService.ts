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
import { DEFAULT_AGENTS } from "../agents/defaultAgents";
import { recordLLMAudit } from "../lib/auditLog";
import {
  createLiteLLMRequestBody,
  isHighRiskToolCallingModelCombo,
  postLiteLLMChatCompletions,
  postLiteLLMChatCompletionsStream,
  type LiteLLMMessage,
  type LiteLLMToolDefinition,
} from "../lib/litellm";
import { createGatewayRequestBody } from "../lib/modelGateway";
import {
  DEFAULT_TOOL_PERMISSIONS,
  isActiveModelLocal,
  getActiveVendor,
  getActiveManagedModel,
  type AppSettings,
  type ToolPermissions,
} from "../lib/settingsStore";
import {
  describeApprovalRule,
  findMatchingApprovalRule,
  type ApprovalRule,
} from "../lib/approvalRuleStore";
import type {
  ActionProposal,
  OrchestrationPlan,
  PlanStep,
  PlanStepStatus,
  SubAgentProgressEvent,
} from "./types";
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
  estimateTokensForMessages,
  estimateTokensForToolDefinitions,
  initialSystemPrefixLength,
  MessageTokenTracker,
  updateTokenCalibration,
} from "./contextBudget";
import type {
  ResolvedAgentRuntime,
  PlannerOutput,
  SubAgentRole,
  ConversationAgentBinding,
  StructuredSubAgentOutput,
  SubAgentCompletionStatus,
  SubAgentFeedback,
} from "../agents/types";
import { resolveAgentRuntime } from "../agents/resolveAgentRuntime";
import { assembleSystemPrompt, assembleRuntimeContext, classifyTaskType } from "../agents/promptAssembly";
import { tryExtractStructuredOutput, tryExtractFeedback } from "../agents/structuredOutput";
import { runWithConcurrencyLimit } from "../lib/concurrency";
import { BUILTIN_TEAMS } from "../agents/agentTeam";
import { executeAgentTeam } from "./teamExecutor";
import type { ChatContextAttachment } from "../lib/contextAttachments";
import {
  collectRelevantFilePaths,
  createWorkingMemory,
  extractFileKnowledge,
  addDiscoveredFact,
  recordSubAgentExecution,
  recordTaskProgress,
  formatTaskProgressBlock,
  serializeWorkingMemory,
  type WorkingMemory,
} from "./workingMemory";
import { buildMatchedContextRuleNote } from "./explicitContextService";
import {
  createAskUserRequest,
  waitForUserResponse,
  type AskUserRequest,
} from "./askUserService";
const TOOL_LOOP_CHECKPOINT_TURNS = 50;
const TOOL_LOOP_EFFICIENCY_WARNING_THRESHOLD = 40;
const MAX_PARALLEL_SUB_AGENTS = 3;
const MAX_LIST_ENTRIES = 120;
const MAX_FILE_PREVIEW_CHARS = 15000;
const MAX_TOOL_RESULT_PREVIEW = 400;

// --- Phase 4: Context management budgets ---
const SUMMARY_CACHE_TTL_MS = 10 * 60 * 1000;
const SUMMARY_CACHE_MAX_ENTRIES = 100;
const BASE_SUMMARY_COOLDOWN_MS = 60 * 1000;

const MIN_MESSAGES_TO_SUMMARIZE = 4;
const MIN_RECENT_MESSAGES_TO_KEEP = 8;
const RECENT_TOKENS_MIN_RATIO = 0.4;
const TOOL_MESSAGE_MAX_CHARS = 3000;

// --- Context Editing: proactive tool-use eviction ---
const CONTEXT_EDIT_KEEP_RECENT_TURNS = 8;
const CONTEXT_EDIT_CLEAR_AT_LEAST = 3;
const CONTEXT_EDIT_TRIGGER_EVERY_N_TURNS = 8;
const CONTEXT_EDIT_TRIGGER_TOKEN_RATIO = 0.85;

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

  if (growthRate > 500) return 15_000;
  if (growthRate > 200) return 30_000;
  return BASE_SUMMARY_COOLDOWN_MS;
}

// P1-2: Max chars per chunk for map-reduce summarization
const SUMMARY_CHUNK_MAX_CHARS = 8000;

const MAX_TOOL_OUTPUT_CHARS = 15000; // hard cap for tool content injected into LLM context
const MAX_GREP_PREVIEW_MATCHES = 30;
const MAX_GREP_PREVIEW_CHARS = 8000;
const MAX_GLOB_PREVIEW_FILES = 60;
const MAX_GLOB_PREVIEW_CHARS = 6000;
// (reserved) diagnostics preview is already aggregated server-side; keep only a hard char cap.
// const MAX_DIAGNOSTICS_PREVIEW_ENTRIES = 30;
// const MAX_DIAGNOSTICS_MESSAGE_CHARS = 240;
const MAX_FETCH_PREVIEW_CHARS = 10000;
const MAX_TOOL_RETRY = 2;
const MAX_PATCH_REPAIR_ROUNDS = 1;
const MAX_CREATE_HINT_REPAIR_ROUNDS = 1;
const MAX_SHELL_DIALECT_REPAIR_ROUNDS = 1;
const MAX_SEARCH_NOT_FOUND_REPAIR_ROUNDS = 2;
const MAX_MULTI_ARTIFACT_REMINDER_ROUNDS = 2;
const MAX_PSEUDO_TOOL_CALL_REPAIR_ROUNDS = 1;
const MAX_PROPOSED_ACTIONS_PER_BATCH = 5;

const MAX_TOOL_NOT_FOUND_STRIKES = 3;
const MAX_CONSECUTIVE_FAILURE_TURNS = 5;

const MAX_LLM_REQUEST_RETRIES = 3;
const LLM_RETRY_BASE_DELAY_MS = 1000;
const LLM_RETRY_MAX_DELAY_MS = 15000;

const INCREMENTAL_CHECKPOINT_INTERVAL = 10;
const MAX_ABSOLUTE_TURNS = 150;

const TASK_TYPE_TURN_LIMITS: Record<string, number> = {
  review: 20,
  information: 15,
  exploration: 25,
  shell_ops: MAX_ABSOLUTE_TURNS,
  code_edit: MAX_ABSOLUTE_TURNS,
  mixed: MAX_ABSOLUTE_TURNS,
};

const MAX_CONSECUTIVE_READ_ONLY_TURNS = 8;
const DEDUP_TURN_WINDOW = 10;
const WORKING_MEMORY_NOTE_PREFIX = "[工作记忆刷新]";
const TODO_PLAN_NOTE_PREFIX = "[Todo Plan]";
const WORKING_MEMORY_REFRESH_INTERVAL = 3;

function computeWorkingMemoryFingerprint(wm: WorkingMemory): string {
  return `${wm.fileKnowledge.size}:${wm.discoveredFacts.length}:${wm.subAgentHistory.length}:${wm.taskProgress.length}`;
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

function extractCandidatePathsFromTaskDescription(taskDescription: string): string[] {
  const matches = taskDescription.match(/(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+(?:\.[A-Za-z0-9_-]+)?/g) ?? [];
  const normalized = matches
    .map((path) => path.trim().replace(/\\/g, "/").replace(/^\/+/, ""))
    .filter((path) => path.length > 0 && /[./]/.test(path));
  return [...new Set(normalized)].slice(0, 12);
}

function normalizeFocusedPathList(paths: string[] | undefined): string[] {
  return [...new Set(
    (paths ?? [])
      .map((path) => path.trim().replace(/\\/g, "/").replace(/^\/+/, ""))
      .filter(Boolean),
  )];
}

function collectSubAgentFocusedPaths(
  taskDescription: string,
  workingMemory: WorkingMemory | undefined,
  role: SubAgentRole,
  explicitFocusedPaths?: string[],
): string[] {
  const seededPaths = normalizeFocusedPathList(explicitFocusedPaths);
  const fromTask = extractCandidatePathsFromTaskDescription(taskDescription);
  const fromMemory = workingMemory
    ? collectRelevantFilePaths(workingMemory, taskDescription, 8, role)
    : [];
  return [...new Set([...seededPaths, ...fromTask, ...fromMemory])].slice(0, 12);
}

interface ToolCallRecord {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export type ToolExecutionStatus = "success" | "failed" | "pending_approval" | "waiting_for_user";

interface ToolExecutionResult {
  content: string;
  proposedAction?: ActionProposal;
  errorCategory?: ToolErrorCategory;
  errorMessage?: string;
  success?: boolean;
  traceStatus?: ToolExecutionStatus;
}

const INTERNAL_TOOL_NAMES = ["update_plan"] as const;

export interface TodoPlanState {
  steps: PlanStep[];
  activeStepId?: string;
}

interface InitialPlanSeed extends TodoPlanState {
  source: "fallback" | "planner" | "existing";
}

function clonePlanStep(step: PlanStep): PlanStep {
  return {
    ...step,
    dependsOn: step.dependsOn ? [...step.dependsOn] : undefined,
    linkedActionIds: step.linkedActionIds ? [...step.linkedActionIds] : undefined,
  };
}

function clonePlanState(state: TodoPlanState): TodoPlanState {
  return {
    steps: state.steps.map(clonePlanStep),
    activeStepId: state.activeStepId,
  };
}

function sanitizeStepTitle(title: string, fallback: string): string {
  const normalized = title.trim() || fallback.trim();
  return normalized || "未命名步骤";
}

function isTerminalPlanStepStatus(status: PlanStepStatus): boolean {
  return status === "completed" || status === "failed" || status === "skipped";
}

function areStepDependenciesSatisfied(step: PlanStep, steps: PlanStep[]): boolean {
  if (!step.dependsOn?.length) {
    return true;
  }
  const byId = new Map(steps.map((entry) => [entry.id, entry]));
  return step.dependsOn.every((depId) => {
    const dependency = byId.get(depId);
    return dependency ? dependency.status === "completed" || dependency.status === "skipped" : false;
  });
}

function findRunnablePendingStep(steps: PlanStep[]): PlanStep | undefined {
  return steps.find(
    (step) => step.status === "pending" && areStepDependenciesSatisfied(step, steps),
  );
}

interface SyncPlanStateOptions {
  promoteNextRunnable?: boolean;
}

function normalizeTodoPlanStateInternal(
  state: TodoPlanState,
  options?: SyncPlanStateOptions,
): TodoPlanState {
  const promoteNextRunnable = options?.promoteNextRunnable !== false;
  const steps = state.steps.map((step, index) => {
    const fallbackTitle = step.summary?.trim() || `步骤 ${index + 1}`;
    return {
      ...clonePlanStep(step),
      title: sanitizeStepTitle(step.title ?? "", fallbackTitle),
      summary: step.summary?.trim() || fallbackTitle,
      status: step.status ?? "pending",
      owner: step.owner ?? "planner",
      dependsOn: step.dependsOn?.filter(Boolean),
      linkedActionIds: step.linkedActionIds?.filter(Boolean),
    };
  });

  let activeStepId = state.activeStepId?.trim() || steps.find((step) => step.status === "in_progress")?.id;
  if (activeStepId) {
    const active = steps.find((step) => step.id === activeStepId);
    if (!active || isTerminalPlanStepStatus(active.status)) {
      activeStepId = undefined;
    } else if (active.status !== "in_progress") {
      active.status = "in_progress";
      active.startedAt = active.startedAt ?? nowIso();
    }
  }

  if (!activeStepId && promoteNextRunnable) {
    const runnable = findRunnablePendingStep(steps);
    if (runnable) {
      runnable.status = "in_progress";
      runnable.startedAt = runnable.startedAt ?? nowIso();
      activeStepId = runnable.id;
    }
  }

  for (const step of steps) {
    if (step.id !== activeStepId && step.status === "in_progress") {
      step.status = "pending";
    }
  }

  return { steps, activeStepId };
}

export function normalizeTodoPlanState(state: TodoPlanState): TodoPlanState {
  return normalizeTodoPlanStateInternal(state);
}

function appendPlanStepNote(step: PlanStep, note?: string): void {
  const normalized = note?.trim();
  if (!normalized) {
    return;
  }
  step.note = step.note?.trim()
    ? `${step.note.trim()}\n${normalized}`
    : normalized;
}

export function setActivePlanStep(state: TodoPlanState, stepId: string): string {
  const target = state.steps.find((step) => step.id === stepId);
  if (!target) {
    return `未找到步骤 ${stepId}`;
  }

  for (const step of state.steps) {
    if (step.id !== stepId && step.status === "in_progress") {
      step.status = "pending";
    }
  }

  target.status = "in_progress";
  target.startedAt = target.startedAt ?? nowIso();
  state.activeStepId = target.id;
  return `当前执行步骤已切换为「${target.title}」`;
}

function promoteNextRunnableStep(state: TodoPlanState): void {
  if (state.activeStepId) {
    return;
  }
  const runnable = findRunnablePendingStep(state.steps);
  if (!runnable) {
    return;
  }
  runnable.status = "in_progress";
  runnable.startedAt = runnable.startedAt ?? nowIso();
  state.activeStepId = runnable.id;
}

export function setPlanStepStatus(
  state: TodoPlanState,
  stepId: string,
  status: Exclude<PlanStepStatus, "pending" | "in_progress">,
  note?: string,
): string {
  const target = state.steps.find((step) => step.id === stepId);
  if (!target) {
    return `未找到步骤 ${stepId}`;
  }

  target.status = status;
  appendPlanStepNote(target, note);
  if (status === "completed") {
    target.completedAt = nowIso();
  }
  if (state.activeStepId === stepId) {
    state.activeStepId = undefined;
  }
  if (status === "completed" || status === "skipped") {
    promoteNextRunnableStep(state);
  }
  return `步骤「${target.title}」已更新为 ${status}`;
}

function addPlanStep(state: TodoPlanState, params: {
  title: string;
  summary?: string;
  owner?: PlanStep["owner"];
  afterStepId?: string;
  note?: string;
}): PlanStep {
  const step: PlanStep = {
    id: createActionId("step"),
    title: sanitizeStepTitle(params.title, params.summary ?? params.title),
    summary: params.summary?.trim() || params.title.trim(),
    owner: params.owner ?? "planner",
    status: "pending",
    note: params.note?.trim() || undefined,
  };

  const afterIndex = params.afterStepId
    ? state.steps.findIndex((entry) => entry.id === params.afterStepId)
    : -1;
  if (afterIndex >= 0) {
    state.steps.splice(afterIndex + 1, 0, step);
  } else {
    state.steps.push(step);
  }

  if (!state.activeStepId) {
    promoteNextRunnableStep(state);
  }
  return step;
}

export function attachActionToPlanStep(state: TodoPlanState, action: ActionProposal): ActionProposal {
  const planStepId = action.planStepId ?? state.activeStepId;
  if (!planStepId) {
    return action;
  }
  const target = state.steps.find((step) => step.id === planStepId);
  if (!target) {
    return action;
  }
  if (!target.linkedActionIds?.includes(action.id)) {
    target.linkedActionIds = [...(target.linkedActionIds ?? []), action.id];
  }
  if (target.status === "pending") {
    target.status = "in_progress";
    target.startedAt = target.startedAt ?? nowIso();
  }
  return {
    ...action,
    planStepId,
  };
}

export function syncPlanStateWithActions(
  state: TodoPlanState,
  actions: ActionProposal[],
  options?: SyncPlanStateOptions,
): TodoPlanState {
  const next = clonePlanState(state);
  for (const step of next.steps) {
    step.linkedActionIds = [];
  }
  for (const action of actions) {
    if (!action.planStepId) {
      continue;
    }
    const target = next.steps.find((step) => step.id === action.planStepId);
    if (!target) {
      continue;
    }
    target.linkedActionIds = [...(target.linkedActionIds ?? []), action.id];
  }
  return normalizeTodoPlanStateInternal(next, options);
}

function formatTodoPlanBlock(state: TodoPlanState): string {
  if (!state.steps.length) {
    return "暂无 todo。";
  }
  return state.steps
    .map((step) => {
      const icon = step.status === "completed"
        ? "✓"
        : step.status === "in_progress"
          ? "▶"
          : step.status === "blocked"
            ? "⏸"
            : step.status === "failed"
              ? "✕"
              : step.status === "skipped"
                ? "↷"
                : "○";
      const suffix = step.id === state.activeStepId ? " [当前]" : "";
      return `${icon} [${step.id}] (${step.owner}/${step.status}) ${step.title}${suffix}`;
    })
    .join("\n");
}

export function buildTodoSystemPrompt(state: TodoPlanState): string {
  if (!state.steps.length) {
    return "";
  }
  return [
    "[Todo Plan]",
    "当前任务已经拆解为以下 todo。一次只推进一个步骤；完成、阻塞或失败时，必须调用 update_plan 更新状态。",
    "如果新增了明确的子任务，可以用 update_plan 添加步骤；不要静默偏离当前 todo。",
    formatTodoPlanBlock(state),
  ].join("\n");
}

export function derivePlanWorkflowState(
  proposedActions: ActionProposal[],
  planState: TodoPlanState,
): OrchestrationPlan["state"] {
  if (proposedActions.some((action) => action.status === "running")) {
    return "executing";
  }
  if (proposedActions.some((action) => action.status === "pending" || action.status === "failed")) {
    return "human_review";
  }
  if (planState.steps.some((step) => step.status === "in_progress")) {
    return "executing";
  }
  if (planState.steps.some((step) => step.status === "pending" || step.status === "blocked" || step.status === "failed")) {
    return "planning";
  }
  return "done";
}

interface ChatCompletionChoiceMessage {
  content?: unknown;
  tool_calls?: unknown;
  reasoning_content?: unknown;
}

interface ChatCompletionPayload {
  id?: string;
  choices?: Array<{
    message?: ChatCompletionChoiceMessage;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface FileEntry {
  name: string;
  is_dir: boolean;
  size: number;
  modified: number;
}

interface PatchApplyResult {
  success: boolean;
  message: string;
  files: string[];
}

const TOOL_DEFINITIONS: LiteLLMToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "list_files",
      description:
        "List files and directories under a workspace-relative path. Returns name, type (file/dir), size, and modification time for each entry. " +
        "Use this to understand project structure, find configuration files, or explore unfamiliar directories before reading specific files.\n\n" +
        "Returns up to 120 entries sorted alphabetically. For deeper exploration, call with subdirectory paths.\n\n" +
        "Examples:\n" +
        "- list_files() — list workspace root\n" +
        "- list_files(relative_path='src/components') — list a specific directory",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          relative_path: {
            type: "string",
            description:
              "Workspace-relative directory path. Empty or omitted means workspace root. Must be a directory, not a file.",
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
        "Read a text file by workspace-relative path. Returns content with line number prefixes (format: '行号│内容'), total_lines (file total line count), and showing_lines (current range displayed).\n\n" +
        "IMPORTANT: Line number prefixes ('行号│') are for reference only — do NOT include them in propose_file_edit search/anchor fields.\n\n" +
        "Reading strategy:\n" +
        "- Small files (<400 lines): call without start_line/end_line to read entire file\n" +
        "- Large files (400+ lines): read in segments of ~300 lines. First call without range to see the beginning and total_lines, then use start_line/end_line for subsequent parts\n" +
        "- If you only need a specific function: use grep first to find the line number, then read that range\n\n" +
        "Examples:\n" +
        "- read_file(relative_path='src/app.ts') — read entire small file\n" +
        "- read_file(relative_path='src/large.ts', start_line=301, end_line=600) — read a segment",
      parameters: {
        type: "object",
        required: ["relative_path"],
        additionalProperties: false,
        properties: {
          relative_path: {
            type: "string",
            minLength: 1,
            description: "Workspace-relative file path. Must point to a file, not a directory.",
          },
          start_line: {
            type: "number",
            minimum: 1,
            description: "1-based start line for partial read. Must be used together with end_line.",
          },
          end_line: {
            type: "number",
            minimum: 1,
            description: "1-based end line (inclusive) for partial read. Must be used together with start_line.",
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
        "Get git status summary showing modified, staged, untracked, and deleted files in the workspace repository. " +
        "Returns empty result for non-git directories (this is normal, not an error).\n\n" +
        "Use this to understand what has changed before proposing edits, or to verify changes after edits are applied.",
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
        "Get unified diff of uncommitted changes in the workspace. Optionally filter to a single file. " +
        "Returns empty result for non-git directories (this is normal, not an error).\n\n" +
        "Use this to review what has been modified, verify applied patches, or understand the scope of recent changes.\n\n" +
        "Examples:\n" +
        "- git_diff() — show all uncommitted changes\n" +
        "- git_diff(file_path='src/app.ts') — show changes in a specific file",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          file_path: {
            type: "string",
            description: "Optional workspace-relative file path to filter diff to a single file.",
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
        "Search file contents in workspace using a regular expression pattern. Returns matching lines with file paths and line numbers (format: 'file:line: content').\n\n" +
        "This is the fastest way to locate code — use it BEFORE read_file to find the right file and line range. " +
        "Ideal for finding function definitions, variable usages, imports, error messages, configuration values, etc.\n\n" +
        "Tips:\n" +
        "- Use simple patterns for broad search: grep(pattern='functionName')\n" +
        "- Use regex for precise matching: grep(pattern='export (function|const) myFunc')\n" +
        "- Filter by file type: grep(pattern='import.*React', include_glob='*.tsx')\n" +
        "- Automatically excludes .git, node_modules, target, dist, build directories\n\n" +
        "Examples:\n" +
        "- grep(pattern='handleSubmit') — find all usages of handleSubmit\n" +
        "- grep(pattern='class UserService', include_glob='*.ts') — find class definition in TypeScript files\n" +
        "- grep(pattern='TODO|FIXME|HACK') — find code annotations",
      parameters: {
        type: "object",
        required: ["pattern"],
        additionalProperties: false,
        properties: {
          pattern: {
            type: "string",
            minLength: 1,
            description:
              "Regular expression pattern to search for. Supports standard regex syntax (|, *, +, ?, [], (), etc.).",
          },
          include_glob: {
            type: "string",
            description:
              "Optional glob pattern to restrict search to matching files. Examples: '*.ts', '*.py', 'src/**/*.tsx'. Matches against both file name and relative path.",
          },
          max_results: {
            type: "number",
            minimum: 1,
            maximum: 200,
            description:
              "Maximum number of matching lines to return. Defaults to 50. Increase for broad searches, decrease for focused ones.",
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
        "Find files in workspace by glob pattern matching. Returns matching file paths sorted by modification time (most recent first).\n\n" +
        "Use this to discover project structure, find files by extension, naming convention, or directory pattern. " +
        "Automatically excludes .git, node_modules, target, dist, build, __pycache__ directories.\n\n" +
        "Common patterns:\n" +
        "- '**/*.tsx' — all TSX files in any directory\n" +
        "- 'src/**/*.test.ts' — all test files under src/\n" +
        "- '**/package.json' — find all package.json files\n" +
        "- 'src/components/*.tsx' — components in a specific directory\n\n" +
        "Examples:\n" +
        "- glob(pattern='**/*.py') — find all Python files\n" +
        "- glob(pattern='**/Dockerfile*') — find all Dockerfiles",
      parameters: {
        type: "object",
        required: ["pattern"],
        additionalProperties: false,
        properties: {
          pattern: {
            type: "string",
            minLength: 1,
            description:
              "Glob pattern to match files. Use ** for recursive directory matching, * for single-level wildcard. Examples: '**/*.tsx', 'src/**/*.py', '**/test_*.js'.",
          },
          max_results: {
            type: "number",
            minimum: 1,
            maximum: 500,
            description:
              "Maximum number of matching files to return. Defaults to 100.",
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
        "Advanced raw patch path. Propose a write action by submitting a SINGLE-FILE unified diff patch for HITL approval (does not execute). Use only when explicit patch/diff is requested or structured edits cannot express the task. Multi-file patches are rejected; for multi-file work, use propose_file_edit sequentially.\n\nMinimal example:\ndiff --git a/src/foo.ts b/src/foo.ts\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,3 +1,3 @@\n-old line\n+new line",
      parameters: {
        type: "object",
        required: ["patch"],
        additionalProperties: false,
        properties: {
          patch: {
            type: "string",
            description:
              "Unified diff patch content for exactly ONE file. MUST include 'diff --git' header. For new files: 'diff --git a/file b/file' then '--- /dev/null' and '+++ b/file'. For edits: 'diff --git a/file b/file' then '--- a/file' and '+++ b/file'. For delete-file patches: include 'deleted file mode 100644', then '--- a/file' and '+++ /dev/null'. Multi-file patches are rejected.",
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
      name: "propose_file_edit",
      description: [
        "Propose a deterministic single-file text edit. System generates and validates a patch for HITL approval.",
        "",
        "## Mode 1: REPLACE (default operation)",
        "Replace existing text in a file.",
        "  Required: relative_path + (search OR start_line/end_line)",
        "  Optional: replace (new text), replace_all/apply_all",
        "  Example A — search-based: {relative_path:'src/foo.ts', search:'old text', replace:'new text'}",
        "  Example B — line-range:   {relative_path:'src/foo.ts', start_line:10, end_line:15, content:'replacement lines'}",
        "",
        "## Mode 2: INSERT",
        "Insert new content before/after an anchor point.",
        "  Required: relative_path, operation:'insert', content + (anchor OR line)",
        "  Optional: position ('before'|'after', default 'after'), apply_all",
        "  Example: {relative_path:'src/foo.ts', operation:'insert', line:5, content:'new line', position:'after'}",
        "",
        "## Mode 3: DELETE",
        "Remove text from a file.",
        "  Required: relative_path, operation:'delete' + (search OR start_line/end_line)",
        "  Optional: apply_all",
        "  Example: {relative_path:'src/foo.ts', operation:'delete', search:'text to remove'}",
        "",
        "## Mode 4: CREATE",
        "Create a new file (or overwrite existing with overwrite:true).",
        "  Required: relative_path, operation:'create', content",
        "  Optional: overwrite (boolean)",
        "  Example: {relative_path:'src/new.ts', operation:'create', content:'export const x = 1;'}",
        "",
        "## COMMON MISTAKES — avoid these:",
        "- Do NOT include line number prefixes (e.g. '  10│') in search/anchor — they are display-only.",
        "- Do NOT use operation:'replace' on a file that does not exist — use operation:'create' instead.",
        "- Do NOT omit content when using operation:'create' — content is required.",
        "- Do NOT use start_line/end_line without first reading the file to confirm current line numbers.",
        "",
        "IMPORTANT: relative_path is REQUIRED for ALL operations.",
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
        "Propose a shell command execution action for HITL approval (does not execute). Match the command to the real executor: on Windows this runs via PowerShell (`powershell -NoProfile -Command`), while on Unix it runs via `sh -c`. Supports pipes, redirects, and chaining within that shell dialect.\n\nExamples:\n- propose_shell(shell='npm install; npm test')\n- propose_shell(shell='New-Item -ItemType Directory -Force logs')\n- propose_shell(shell='Remove-Item -Recurse -Force old_dir')\n- propose_shell(shell='git add .; git commit -m \"Update\"')\n- propose_shell(shell='cargo build --release')\n\nIf propose_shell is auto-executed, the command runs immediately in the real shell. Read stderr carefully and retry with corrected syntax instead of repeating the same failing command.\n\nThe command will be shown to the user for approval before execution when approval is required.",
      parameters: {
        type: "object",
        required: ["shell"],
        additionalProperties: false,
        properties: {
          shell: {
            type: "string",
            minLength: 1,
            description:
              "Full shell command string. On Windows prefer PowerShell syntax such as ';', New-Item, Remove-Item, and $env:NAME. On Unix use POSIX shell syntax.",
          },
          timeout_ms: {
            type: "number",
            minimum: 1000,
            maximum: 600000,
            description:
              "Optional execution timeout in milliseconds. Defaults to 120000 (2 minutes).",
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
      name: "task",
      description:
        "Delegate a sub-task to a specialized sub-agent. The sub-agent runs an independent tool-calling loop with its own context and returns a summary of results. " +
        "Multiple task calls in the same turn will be executed in parallel. Use this for independent tasks that don't depend on each other's results.\n\n" +
        "The sub-agent inherits the current workspace and tool permissions but operates with a focused system prompt based on its role. " +
        "Sub-agent results (including any proposed actions) are collected and returned to you. " +
        "If a sub-agent needs clarification, it will be automatically retried with additional context.\n\n" +
        "Example: task(role='coder', description='Implement the UserService class with CRUD methods in src/services/userService.ts')",
      parameters: {
        type: "object",
        required: ["description"],
        additionalProperties: false,
        properties: {
          role: {
            type: "string",
            enum: ["planner", "coder", "tester"],
            description: "The role of the sub-agent to delegate to. Required unless 'team' is provided.",
          },
          team: {
            type: "string",
            description: "Optional ID of a predefined Agent Team to execute. If provided, overrides 'role'.",
          },
          description: {
            type: "string",
            minLength: 1,
            description:
              "Detailed description of the sub-task for the sub-agent or team to execute.",
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
        "Update the internal todo plan for the current task. Use this to mark a step as active, completed, blocked, failed, skipped, add notes, or append a new step. This tool has no side effects on the workspace and never requires approval.",
      parameters: {
        type: "object",
        required: ["operation", "step_id"],
        additionalProperties: false,
        properties: {
          operation: {
            type: "string",
            enum: ["set_active", "complete", "block", "fail", "skip", "note", "add"],
            description: "Plan update operation to perform.",
          },
          step_id: {
            type: "string",
            minLength: 1,
            description: "Target step id. For operation='add', this acts as the new step id hint and can be any non-empty string.",
          },
          title: {
            type: "string",
            description: "Required when operation='add'. Short title for the new todo step.",
          },
          summary: {
            type: "string",
            description: "Optional step summary when operation='add'.",
          },
          owner: {
            type: "string",
            enum: ["planner", "coder", "tester", "debugger", "reviewer"],
            description: "Optional owner for operation='add'.",
          },
          note: {
            type: "string",
            description: "Optional note or rationale for the step update.",
          },
          after_step_id: {
            type: "string",
            description: "Optional insertion anchor when operation='add'.",
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
        "Get compilation errors and warnings for the workspace. " +
        "Automatically detects project type (TypeScript, Rust, Python, Go) and runs the appropriate checker (tsc, cargo check, py_compile, etc.). " +
        "Use this after making code changes to verify correctness, or to understand existing issues in the codebase.\n\n" +
        "Example: diagnostics() - returns all errors/warnings\n" +
        "Example: diagnostics(changed_files=['src/foo.ts', 'src/bar.ts']) - filter to specific files",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          changed_files: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional list of workspace-relative file paths to filter diagnostics to.",
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
        "Fetch content from a URL. Any accessible URL is allowed.\n\n" +
        "Use this to retrieve API documentation, code examples, library READMEs, technical references, or any web content. " +
        "Maximum response size is 512KB, content will be truncated if larger.\n\n" +
        "Example: fetch(url='https://raw.githubusercontent.com/user/repo/main/README.md')",
      parameters: {
        type: "object",
        required: ["url"],
        additionalProperties: false,
        properties: {
          url: {
            type: "string",
            minLength: 1,
            description: "The URL to fetch. Must be from an allowed domain.",
          },
          max_size: {
            type: "number",
            minimum: 1024,
            maximum: 524288,
            description:
              "Optional maximum content size in bytes. Defaults to 512KB.",
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
        "Ask the user a question and wait for their response. Use this when you need human input, clarification, or decision-making that cannot be inferred from context.\n\n" +
        "The tool will pause execution until the user provides an answer. The user's response will be returned as a string.\n\n" +
        "Best practices:\n" +
        "- Ask clear, specific questions\n" +
        "- Provide context to help the user understand why you're asking\n" +
        "- Use options for multiple-choice questions to make it easier for users\n" +
        "- Mark questions as optional (required=false) when appropriate\n\n" +
        "Examples:\n" +
        "- ask_user(question='Which database should I use?', options=['PostgreSQL', 'MongoDB', 'SQLite'])\n" +
        "- ask_user(question='What should the API endpoint be named?', context='Creating a new user registration endpoint')\n" +
        "- ask_user(question='Should I proceed with this approach?', required=false)",
      parameters: {
        type: "object",
        required: ["question"],
        additionalProperties: false,
        properties: {
          question: {
            type: "string",
            minLength: 1,
            description: "The question to ask the user. Should be clear and specific.",
          },
          context: {
            type: "string",
            description: "Optional context or background information to help the user understand the question.",
          },
          options: {
            type: "array",
            items: { type: "string" },
            description: "Optional list of predefined answer choices for the user to select from.",
          },
          required: {
            type: "boolean",
            description: "Whether the user must provide an answer. Defaults to true. Set to false for optional questions.",
          },
        },
      },
    },
  },
];

export type PlanningSessionPhase = "default";

const ALL_TOOL_NAMES = [
  "list_files",
  "read_file",
  "git_status",
  "git_diff",
  "grep",
  "glob",
  "propose_file_edit",
  "propose_apply_patch",
  "propose_shell",
  "task",
  "update_plan",
  "diagnostics",
  "fetch",
  "ask_user",
];

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

function smartTruncateWithHint(
  text: string,
  limit: number,
  hint: string
): { text: string; truncated: boolean; hint?: string } {
  if (text.length <= limit) {
    return { text, truncated: false };
  }
  const truncatedText = smartTruncate(text, limit);
  return {
    text: truncatedText,
    truncated: true,
    hint,
  };
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


function selectToolDefinitions(toolNames: string[]): LiteLLMToolDefinition[] {
  const enabled = new Set(toolNames);
  return TOOL_DEFINITIONS.filter((tool) => enabled.has(tool.function.name));
}

/**
 * Build tool definitions tailored for a specific agent runtime.
 * The `task` tool's role enum is set to the agent's allowedSubAgents;
 * if the agent has no allowed sub-agents, `task` is excluded entirely.
 */
function buildAgentToolDefs(runtime: ResolvedAgentRuntime): LiteLLMToolDefinition[] {
  const allowedRoles = runtime.allowedSubAgents;
  const enabled = new Set<string>([...runtime.enabledTools, ...INTERNAL_TOOL_NAMES]);
  return TOOL_DEFINITIONS.map((td) => {
    if (!enabled.has(td.function.name)) {
      return null;
    }
    if (td.function.name !== "task") return td;
    if (allowedRoles.length === 0) return null;
    return {
      ...td,
      function: {
        ...td.function,
        parameters: {
          ...td.function.parameters,
          properties: {
            ...(td.function.parameters as any).properties,
            role: {
              ...(td.function.parameters as any).properties.role,
              enum: [...allowedRoles],
            },
          },
        },
      },
    };
  }).filter((td): td is LiteLLMToolDefinition => td !== null);
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
  /** Called with sub-agent progress events during task tool execution. */
  onSubAgentProgress?: (role: string, event: SubAgentProgressEvent) => void;
  /** Called periodically during the tool loop with partial results for incremental checkpoint persistence. */
  onLoopCheckpoint?: (checkpoint: {
    turn: number;
    proposedActions: ActionProposal[];
    planState: TodoPlanState;
    toolTrace: ToolExecutionTrace[];
    assistantReply: string;
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
}

export interface PlanningSessionResult {
  assistantReply: string;
  plan: OrchestrationPlan;
  toolTrace: ToolExecutionTrace[];
  assistantToolCalls?: LiteLLMMessage["tool_calls"];
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
  };
}

interface RequestRecord {
  requestId: string;
  inputLength: number;
  outputLength: number;
  inputTokens?: number;
  outputTokens?: number;
}

export type ToolErrorCategory =
  | "validation"
  | "workspace"
  | "permission"
  | "timeout"
  | "allowlist"
  | "transport"
  | "guardrail"
  | "tool_not_found"
  | "unknown";

export interface ToolExecutionTrace {
  callId: string;
  name: string;
  arguments: string;
  startedAt: string;
  finishedAt: string;
  attempts: number;
  status: ToolExecutionStatus;
  retried: boolean;
  errorCategory?: ToolErrorCategory;
  errorMessage?: string;
  resultPreview?: string;
}

function createRequestId(prefix: string): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
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

function buildAssistantDisplayContent(message: ChatCompletionChoiceMessage): string {
  const content = normalizeMessageContent(message.content);
  const reasoning = normalizeMessageContent(message.reasoning_content);

  if (!reasoning.trim()) {
    return content;
  }
  if (content.includes("<think>")) {
    return content;
  }
  return `<think>${reasoning}</think>${content}`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function detectPseudoToolCallNarration(
  content: string,
  availableToolNames: string[],
): string | null {
  const normalized = content.trim();
  if (!normalized) {
    return null;
  }

  const lower = normalized.toLowerCase();
  const mentionedTool = availableToolNames.find((toolName) =>
    new RegExp(`\\b${escapeRegex(toolName.toLowerCase())}\\b`, "i").test(lower),
  );
  if (!mentionedTool) {
    return null;
  }

  const pseudoPatterns: Array<{ pattern: RegExp; reason: string }> = [
    {
      pattern: /\b(?:let'?s|i(?:'|’)ll|i will|need to|must|should|going to)\s+(?:call|use|invoke)\b/i,
      reason: "narrated_tool_intent",
    },
    {
      pattern: /\btool\s*call\b/i,
      reason: "mentions_tool_call_literal",
    },
    {
      pattern: /\b(?:call|use|invoke)\s+(?:the\s+)?[a-z_][a-z0-9_]*\b/i,
      reason: "direct_call_phrase",
    },
    {
      pattern: /\b(?:functions?\.|to=functions\.)[a-z_][a-z0-9_]*\b/i,
      reason: "sdk_style_tool_reference",
    },
  ];

  const matched = pseudoPatterns.find(({ pattern }) => pattern.test(normalized));
  return matched ? `${matched.reason}:${mentionedTool}` : null;
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

const CHUNK_SUMMARY_SYSTEM_PROMPT = [
  "你是一个代码助手内置的上下文压缩引擎。你的任务是将以下对话片段压缩为简洁的摘要要点。",
  "保留所有关键技术细节：文件名、函数名、错误信息、架构决策。",
  "使用简洁的中文输出，严格控制在 400 字以内。",
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

function splitMessagesIntoChunks(
  messages: LiteLLMMessage[],
  maxCharsPerChunk: number,
): LiteLLMMessage[][] {
  const chunks: LiteLLMMessage[][] = [];
  let currentChunk: LiteLLMMessage[] = [];
  let currentChars = 0;

  for (const msg of messages) {
    const msgChars = (msg.content ?? "").length + 20; // +20 for role label overhead
    if (currentChunk.length > 0 && currentChars + msgChars > maxCharsPerChunk) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentChars = 0;
    }
    currentChunk.push(msg);
    currentChars += msgChars;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
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
    const requestBody = createLiteLLMRequestBody(messages, settings, {});
    const response = await postLiteLLMChatCompletions(settings, requestBody);
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

  // If content fits in a single chunk, use direct summarization (fast path).
  if (combinedContent.length <= SUMMARY_CHUNK_MAX_CHARS) {
    const result = await summarizeSingleChunk(
      combinedContent,
      settings,
      SUMMARY_SYSTEM_PROMPT,
    );
    if (result) {
      const elapsed = ((performance.now() - sumT0) / 1000).toFixed(2);
      console.log(`[Context] 摘要完成 (直接) | ${elapsed}s | ${result.length} chars`);
      summaryCache.set(cacheKey, result);
      return result;
    }
  } else {
    // P1-2: Map-Reduce — split into chunks, summarize each, then reduce.
    const chunks = splitMessagesIntoChunks(messagesToSummarize, SUMMARY_CHUNK_MAX_CHARS);
    console.log(`[Context] Map-Reduce 摘要: ${chunks.length} chunks`);

    // Map phase: summarize chunks in parallel (up to 3 concurrent LLM calls)
    const chunkTasks = chunks.map((chunk, chunkIndex) => async () => {
      const chunkContent = formatMessagesForSummary(chunk);
      const chunkSummary = await summarizeSingleChunk(
        chunkContent,
        settings,
        CHUNK_SUMMARY_SYSTEM_PROMPT,
      );
      if (chunkSummary) {
        return `[片段 ${chunkIndex + 1}/${chunks.length}]\n${chunkSummary}`;
      }
      return `[片段 ${chunkIndex + 1}/${chunks.length}]\n${chunkContent.slice(0, 500)}...`;
    });

    const MAX_PARALLEL_SUMMARY_CHUNKS = 3;
    const settledResults = await runWithConcurrencyLimit(chunkTasks, MAX_PARALLEL_SUMMARY_CHUNKS);
    const chunkSummaries: string[] = settledResults.map((result, idx) => {
      if (result.status === "fulfilled") {
        return result.value;
      }
      console.warn(`[Context] Map-Reduce chunk ${idx + 1} 摘要失败:`, result.reason);
      const fallbackContent = formatMessagesForSummary(chunks[idx]);
      return `[片段 ${idx + 1}/${chunks.length}]\n${fallbackContent.slice(0, 500)}...`;
    });

    // Reduce phase: combine chunk summaries into final summary.
    // When truncation is needed, keep the *latest* chunks (tail) because
    // recent context is more relevant for the model's next action.
    const combinedChunkSummaries = chunkSummaries.join("\n\n");
    const reducedContent =
      combinedChunkSummaries.length <= SUMMARY_CHUNK_MAX_CHARS
        ? combinedChunkSummaries
        : "(早期片段已省略)...\n" + combinedChunkSummaries.slice(-SUMMARY_CHUNK_MAX_CHARS);

    const finalSummary = await summarizeSingleChunk(
      `以下是对话历史分段摘要，请合并为一份完整、结构化的最终摘要：\n\n${reducedContent}`,
      settings,
      SUMMARY_SYSTEM_PROMPT,
    );

    if (finalSummary) {
      const elapsed = ((performance.now() - sumT0) / 1000).toFixed(2);
      console.log(
        `[Context] Map-Reduce 摘要完成 | ${elapsed}s | ${chunks.length} chunks → ${finalSummary.length} chars`,
      );
      summaryCache.set(cacheKey, finalSummary);
      return finalSummary;
    }
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

function inputLengthOf(messages: LiteLLMMessage[]): number {
  return messages.reduce((total, message) => total + message.content.length, 0);
}

function parseErrorMessage(raw: string, status: number): string {
  if (!raw.trim()) {
    return `${status}`;
  }

  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } };
    return parsed.error?.message ?? raw.slice(0, 240);
  } catch (_error) {
    return raw.slice(0, 240);
  }
}

function parseCompletionPayload(raw: string): ChatCompletionPayload {
  const trimmed = raw.trim();

  // Handle empty response
  if (!trimmed) {
    throw new Error("模型响应为空。");
  }

  try {
    const parsed = JSON.parse(trimmed) as ChatCompletionPayload;
    if (!parsed || typeof parsed !== "object") {
      throw new Error("completion payload invalid");
    }
    return parsed;
  } catch (primaryError) {
    // Some streaming responses may have trailing garbage after the JSON object.
    // Try to extract the first valid JSON object from the response.
    const firstBrace = trimmed.indexOf("{");
    if (firstBrace >= 0) {
      let depth = 0;
      let inStr = false;
      let escape = false;
      for (let i = firstBrace; i < trimmed.length; i++) {
        const char = trimmed[i];
        if (escape) { escape = false; continue; }
        if (char === "\\") { escape = true; continue; }
        if (char === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (char === "{") depth++;
        else if (char === "}") {
          depth--;
          if (depth === 0) {
            try {
              const extracted = JSON.parse(trimmed.slice(firstBrace, i + 1)) as ChatCompletionPayload;
              if (extracted && typeof extracted === "object") {
                console.warn("[parseCompletionPayload] Recovered valid JSON from partial response");
                return extracted;
              }
            } catch {
              // Continue to throw original error
            }
            break;
          }
        }
      }
    }

    throw new Error("模型响应不是有效 JSON。");
  }
}

/**
 * Attempt to repair truncated or malformed JSON arguments from streaming responses.
 * Some models (especially during streaming) may produce incomplete JSON that can be
 * salvaged by closing open brackets/braces.
 */
function tryRepairJsonArguments(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Already valid JSON
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // Continue to repair attempts
  }

  // Count unmatched brackets/braces and try to close them
  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;
  let escapeNext = false;

  for (const char of trimmed) {
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (char === "\\") {
      escapeNext = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === "{") openBraces++;
    else if (char === "}") openBraces--;
    else if (char === "[") openBrackets++;
    else if (char === "]") openBrackets--;
  }

  // If we're inside a string, close it first
  let repaired = trimmed;
  if (inString) {
    repaired += '"';
  }

  // Close any remaining open brackets/braces
  while (openBrackets > 0) {
    repaired += "]";
    openBrackets--;
  }
  while (openBraces > 0) {
    repaired += "}";
    openBraces--;
  }

  // Validate the repaired JSON
  try {
    JSON.parse(repaired);
    console.warn(`[parseToolCalls] Repaired truncated JSON arguments: "${trimmed.slice(0, 60)}..." → valid`);
    return repaired;
  } catch {
    return null;
  }
}

function parseToolCalls(raw: unknown): { parsed: ToolCallRecord[]; droppedCount: number } {
  if (!Array.isArray(raw)) {
    return { parsed: [], droppedCount: 0 };
  }

  let dropped = 0;
  const parsed = raw
    .map((item, index) => {
      if (!item || typeof item !== "object") {
        dropped += 1;
        return null;
      }
      const record = item as Record<string, unknown>;
      const fn = record.function;
      if (!fn || typeof fn !== "object") {
        dropped += 1;
        return null;
      }
      const fnRecord = fn as Record<string, unknown>;

      // Validate tool name
      if (typeof fnRecord.name !== "string" || !fnRecord.name.trim()) {
        dropped += 1;
        return null;
      }

      // Handle arguments: allow empty object "{}" as valid (some models send this for no-arg tools)
      let argsStr = typeof fnRecord.arguments === "string"
        ? fnRecord.arguments.trim()
        : "";

      // If arguments is an object (some providers return parsed JSON instead of string)
      if (!argsStr && fnRecord.arguments && typeof fnRecord.arguments === "object") {
        argsStr = JSON.stringify(fnRecord.arguments);
      }

      // Default to empty object for tools with no required parameters
      if (!argsStr) {
        argsStr = "{}";
      }

      // Attempt to repair truncated JSON from streaming responses
      const repairedArgs = tryRepairJsonArguments(argsStr);
      if (!repairedArgs) {
        console.warn(
          `[parseToolCalls] Dropping tool call "${fnRecord.name}" with unparseable arguments: "${argsStr.slice(0, 100)}"`
        );
        dropped += 1;
        return null;
      }

      const id =
        typeof record.id === "string" && record.id.trim()
          ? record.id
          : `toolcall-${index + 1}-${Date.now()}`;
      return {
        id,
        type: "function" as const,
        function: {
          name: fnRecord.name.trim(),
          arguments: repairedArgs,
        },
      };
    })
    .filter((item): item is ToolCallRecord => Boolean(item));
  return { parsed, droppedCount: dropped };
}

function normalizeRelativePath(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * Strip line-number prefixes that read_file adds (e.g. "487│  code" → "  code").
 * Models may accidentally copy these into search/anchor fields.
 */
function stripLineNumberPrefixes(text: string): string {
  // \s* handles optional leading spaces that some models copy from the display format (e.g. "  10│")
  return text.replace(/^\s*[0-9]+│/gm, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeOptionalPositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : null;
}

function countOccurrences(content: string, snippet: string): number {
  if (!snippet) {
    return 0;
  }

  let total = 0;
  let offset = 0;
  while (offset <= content.length) {
    const index = content.indexOf(snippet, offset);
    if (index < 0) {
      break;
    }
    total += 1;
    offset = index + Math.max(1, snippet.length);
  }
  return total;
}

function splitPatchLines(content: string): {
  lines: string[];
  hasTrailingNewline: boolean;
} {
  if (!content.length) {
    return {
      lines: [],
      hasTrailingNewline: false,
    };
  }

  const hasTrailingNewline = content.endsWith("\n");
  const body = hasTrailingNewline ? content.slice(0, -1) : content;

  return {
    lines: body.length > 0 ? body.split("\n") : [""],
    hasTrailingNewline,
  };
}

function splitContentSegments(content: string): string[] {
  if (!content.length) {
    return [];
  }

  const segments: string[] = [];
  let start = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\n") {
      segments.push(content.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (start < content.length) {
    segments.push(content.slice(start));
  }
  return segments;
}

function replaceByLineRange(
  content: string,
  startLine: number,
  endLine: number,
  replacement: string
): string {
  const segments = splitContentSegments(content);
  if (!segments.length) {
    throw new Error("文件为空，无法按行定位编辑。");
  }
  if (startLine < 1 || endLine < 1 || startLine > endLine) {
    throw new Error("非法行号范围。");
  }
  if (startLine > segments.length || endLine > segments.length) {
    throw new Error(`行号超出文件范围（总行数 ${segments.length}）。`);
  }

  return (
    segments.slice(0, startLine - 1).join("") +
    replacement +
    segments.slice(endLine).join("")
  );
}

function insertByLine(
  content: string,
  line: number,
  insertContent: string,
  position: "before" | "after"
): string {
  const segments = splitContentSegments(content);
  if (!segments.length) {
    throw new Error("文件为空，无法按行定位插入。");
  }
  if (line < 1 || line > segments.length) {
    throw new Error(`line 超出文件范围（总行数 ${segments.length}）。`);
  }

  const insertionIndex = position === "before" ? line - 1 : line;
  return (
    segments.slice(0, insertionIndex).join("") +
    insertContent +
    segments.slice(insertionIndex).join("")
  );
}

function formatUnifiedRange(start: number, count: number): string {
  if (count === 1) {
    return `${start}`;
  }
  return `${start},${count}`;
}

async function buildReplacementPatch(
  relativePath: string,
  before: string,
  after: string
): Promise<string> {
  if (before === after) {
    throw new Error("编辑结果为空，未产生文件变更。");
  }
  return invoke<string>("build_workspace_edit_patch", {
    relativePath,
    before,
    after,
  });
}

function buildCreateFilePatch(relativePath: string, content: string): string {
  const next = splitPatchLines(content);
  if (next.lines.length < 1) {
    throw new Error("create 操作要求 content 至少包含一行。");
  }

  const hunkLines = next.lines.map((line) => `+${line}`);
  if (!next.hasTrailingNewline) {
    hunkLines.push("\\ No newline at end of file");
  }

  return (
    [
      `diff --git a/${relativePath} b/${relativePath}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${relativePath}`,
      `@@ -0,0 +${formatUnifiedRange(1, next.lines.length)} @@`,
      ...hunkLines,
    ].join("\n") + "\n"
  );
}

function createActionId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function classifyToolError(message: string): ToolErrorCategory {
  const lower = message.toLowerCase();
  if (
    lower.includes("不能为空") ||
    lower.includes("invalid json") ||
    lower.includes("arguments") ||
    lower.includes("未找到") ||
    lower.includes("出现多次") ||
    lower.includes("预检失败") ||
    lower.includes("已存在") ||
    lower.includes("未产生文件变更") ||
    lower.includes("不支持的 file edit") ||
    lower.includes("行号") ||
    lower.includes("文件为空") ||
    lower.includes("invalid target path") ||
    lower.includes("no such file or directory") ||
    lower.includes("line 超出")
  ) {
    return "validation";
  }
  if (lower.includes("未选择工作区") || lower.includes("workspace")) {
    return "workspace";
  }
  if (
    lower.includes("allowlist") ||
    lower.includes("guardrail") ||
    lower.includes("shell 控制符") ||
    lower.includes("工作区越界路径") ||
    lower.includes("受限目录") ||
    lower.includes("命中被禁止的可执行程序") ||
    lower.includes("命中高风险关键字") ||
    lower.includes("解释器内联执行") ||
    lower.includes("propose_apply_patch") ||
    lower.includes("直接改文件")
  ) {
    return "guardrail";
  }
  if (
    lower.includes("patch does not apply") ||
    lower.includes("corrupt patch")
  ) {
    return "validation";
  }
  if (lower.includes("timed out") || lower.includes("超时")) {
    return "timeout";
  }
  if (lower.includes("permission") || lower.includes("not permitted")) {
    return "permission";
  }
  if (lower.includes("未知工具")) {
    return "tool_not_found";
  }
  if (
    lower.includes("fetch") ||
    lower.includes("network") ||
    lower.includes("http")
  ) {
    return "transport";
  }
  return "unknown";
}

function shouldRetryToolCall(category: ToolErrorCategory): boolean {
  switch (category) {
    case "transport":
    case "timeout":
      return true;
    case "workspace":
      // Workspace errors (e.g. file temporarily locked) may resolve on retry
      return true;
    case "validation":
    case "permission":
    case "allowlist":
    case "guardrail":
    case "tool_not_found":
      // These are deterministic failures — retrying won't help
      return false;
    case "unknown":
      // Unknown errors get one retry in case they're transient
      return true;
    default:
      return false;
  }
}

/**
 * Compute exponential backoff delay for tool call retries.
 * Uses a shorter base than LLM retries since tool calls are local operations.
 */
function computeToolRetryDelay(attempt: number): number {
  const baseDelayMs = 500;
  const maxDelayMs = 5000;
  const delay = baseDelayMs * Math.pow(2, attempt - 1);
  const jitter = delay * 0.2 * Math.random();
  return Math.min(delay + jitter, maxDelayMs);
}

/**
 * Build a contextual error recovery hint for the LLM based on the tool error category.
 * This helps the model understand what went wrong and how to fix it.
 */
function buildToolErrorRecoveryHint(
  toolName: string,
  category: ToolErrorCategory,
  errorMessage: string,
): string {
  const hints: string[] = [
    `工具 "${toolName}" 执行失败。`,
    `错误类别: ${category}`,
    `错误信息: ${errorMessage}`,
  ];

  switch (category) {
    case "validation":
      hints.push(
        "恢复建议: 参数格式或值不正确。请检查工具参数是否符合要求，特别注意：",
        "- relative_path 必须是工作区相对路径，不能是绝对路径",
        "- search 字段必须与文件中的实际内容完全匹配（包括空格和缩进）",
        "- 必填参数不能省略",
      );
      break;
    case "workspace":
      hints.push(
        "恢复建议: 工作区操作失败。可能的原因：",
        "- 文件或目录不存在 — 先用 list_files 或 glob 确认路径",
        "- 文件被锁定或权限不足 — 尝试其他文件或等待后重试",
        "- 路径拼写错误 — 使用 glob 搜索正确的文件名",
      );
      break;
    case "timeout":
      hints.push(
        "恢复建议: 操作超时。对于耗时操作：",
        "- 缩小操作范围（如减少 grep 的 max_results）",
        "- 对于 shell 命令，增加 timeout_ms 参数",
        "- 将大操作拆分为多个小操作",
      );
      break;
    case "transport":
      hints.push(
        "恢复建议: 网络或传输错误，通常是暂时性的。系统会自动重试。",
      );
      break;
    case "tool_not_found":
      hints.push(
        "恢复建议: 调用了不存在的工具。请检查工具名称拼写，可用工具列表见系统提示。",
      );
      break;
    case "permission":
    case "allowlist":
    case "guardrail":
      hints.push(
        "恢复建议: 权限或安全策略阻止了此操作。请：",
        "- 使用其他方式完成任务",
        "- 如果是 shell 命令被阻止，尝试使用更安全的替代命令",
      );
      break;
    default:
      hints.push(
        "恢复建议: 发生未知错误。请尝试：",
        "- 检查参数是否正确",
        "- 使用 read_file 确认目标文件的当前状态",
        "- 尝试不同的方法完成任务",
      );
  }

  return hints.join("\n");
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

function resultPreview(content: string): string {
  return content.slice(0, MAX_TOOL_RESULT_PREVIEW);
}

function buildAutoApprovalMeta(
  source: "tool_permission" | "workspace_rule" | null,
  matchedRule?: ApprovalRule | null,
): Record<string, unknown> {
  if (!source) {
    return {};
  }

  return {
    approval_source: source,
    approval_rule_matched: source === "workspace_rule",
    approval_rule_kind:
      source === "workspace_rule" ? matchedRule?.kind ?? null : null,
    approval_rule_label:
      source === "workspace_rule" && matchedRule
        ? describeApprovalRule(matchedRule)
        : null,
  };
}

async function autoExecutePatchProposal(params: {
  workspacePath: string;
  patch: string;
  responseMeta?: Record<string, unknown>;
  autoApprovalMeta?: Record<string, unknown>;
}): Promise<ToolExecutionResult> {
  const snapshot = await invoke<{
    success: boolean;
    snapshot_id: string;
    files: string[];
  }>("create_workspace_snapshot", {
    workspacePath: params.workspacePath,
    patch: params.patch,
  });
  const applyResult = await invoke<PatchApplyResult>(
    "apply_workspace_patch",
    { workspacePath: params.workspacePath, patch: params.patch }
  );
  if (!applyResult.success && snapshot.success) {
    await invoke<PatchApplyResult>("restore_workspace_snapshot", {
      workspacePath: params.workspacePath,
      snapshotId: snapshot.snapshot_id,
    });
  }

  const responsePayload: Record<string, unknown> = {
    ok: applyResult.success,
    action_type: "apply_patch",
    auto_executed: true,
    patch_length: params.patch.length,
    files: applyResult.files,
    message: applyResult.message,
    ...(params.responseMeta ?? {}),
    ...(params.autoApprovalMeta ?? {}),
  };
  if (applyResult.success) {
    const diagnostics = await fetchPostPatchDiagnostics(
      params.workspacePath,
      applyResult.files
    );
    if (diagnostics.hasDiagnostics) {
      responsePayload.diagnostics = diagnostics.summary;
    }
  }

  return {
    content: JSON.stringify(responsePayload),
    success: applyResult.success,
    errorCategory: applyResult.success ? undefined : "validation",
    errorMessage: applyResult.success ? undefined : applyResult.message,
  };
}

async function autoExecuteShellProposal(params: {
  workspacePath: string;
  shell: string;
  timeoutMs: number;
  autoApprovalMeta?: Record<string, unknown>;
}): Promise<ToolExecutionResult> {
  const cmdResult = await invoke<{
    success: boolean;
    command: string;
    timed_out: boolean;
    status: number;
    stdout: string;
    stderr: string;
  }>("run_shell_command", {
    workspacePath: params.workspacePath,
    shell: params.shell,
    timeoutMs: params.timeoutMs,
  });
  return {
    content: JSON.stringify({
      ok: cmdResult.success,
      action_type: "shell",
      auto_executed: true,
      shell: params.shell,
      stdout: cmdResult.stdout,
      stderr: cmdResult.stderr,
      exit_code: cmdResult.status,
      timed_out: cmdResult.timed_out,
      ...(params.autoApprovalMeta ?? {}),
    }),
    success: cmdResult.success,
    errorCategory: cmdResult.success ? undefined : "validation",
    errorMessage: cmdResult.success
      ? undefined
      : `命令执行失败 (exit ${cmdResult.status})`,
  };
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function buildShellDialectRepairInstruction(
  toolCall: ToolCallRecord,
  toolResult: ToolExecutionResult,
): string | null {
  if (toolCall.function.name !== "propose_shell" || toolResult.success !== false) {
    return null;
  }

  const args = parseJsonObject(toolCall.function.arguments);
  const shell = typeof args?.shell === "string" ? args.shell.trim() : "";
  if (!shell) {
    return null;
  }

  const payload = parseJsonObject(toolResult.content);
  if (payload?.auto_executed !== true) {
    return null;
  }

  const stderr = typeof payload.stderr === "string" ? payload.stderr : "";
  const stdout = typeof payload.stdout === "string" ? payload.stdout : "";
  const rawError = [toolResult.errorMessage, stderr, stdout]
    .filter((value): value is string => Boolean(value))
    .join("\n");
  const normalizedError = rawError.toLowerCase();
  const normalizedShell = shell.toLowerCase();
  const usesDialectSpecificSyntax =
    normalizedShell.includes("&&") || normalizedShell.includes("mkdir -p");
  const looksLikePowerShellFailure = [
    "parsererror",
    "at line:",
    "categoryinfo",
    "fullyqualifiederrorid",
    "not a valid statement separator",
    "parameterbindingexception",
    "positional parameter cannot be found that accepts argument '-p'",
  ].some((marker) => normalizedError.includes(marker));

  if (!usesDialectSpecificSyntax || !looksLikePowerShellFailure) {
    return null;
  }

  return [
    "系统提示：上一轮自动执行的 propose_shell 失败，错误看起来像 shell 方言不匹配。",
    `失败命令：${shell}`,
    `错误信息：${rawError.trim().slice(0, 1200) || "命令执行失败"}`,
    "当前 Windows 执行器实际使用 PowerShell（powershell -NoProfile -Command）。不要重复使用 bash/cmd 风格写法如 mkdir -p 或 &&。",
    "请保持任务目标不变，依据 stderr 改写为 PowerShell 语法后重新调用 propose_shell：创建目录用 New-Item -ItemType Directory -Force <目录>，命令串联用 ;，删除目录用 Remove-Item -Recurse -Force <路径>。",
    "仅允许一次自动修复重试。",
  ].join("\n");
}

/**
 * Generate a short human-readable preview of tool call arguments.
 */
function extractStringArg(
  argsJson: string,
  keys: string[],
): string {
  try {
    const parsed = JSON.parse(argsJson) as Record<string, unknown>;
    for (const key of keys) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
  } catch {
    // Fall through to partial-JSON extraction below.
  }

  for (const key of keys) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = argsJson.match(
      new RegExp(`"${escapedKey}"\\s*:\\s*"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)`)
    );
    if (match?.[1]) {
      return match[1].replace(/\\"/g, "\"").trim();
    }
  }

  return "";
}

function summarizeToolArgs(toolName: string, argsJson: string): string {
  const pathPreview = extractStringArg(argsJson, [
    "relative_path",
    "file_path",
    "path",
  ]);

  switch (toolName) {
    case "read_file":
      return pathPreview;
    case "list_files":
      return pathPreview || "/";
    case "grep": {
      const pattern = extractStringArg(argsJson, ["pattern"]);
      const includeGlob = extractStringArg(argsJson, ["include_glob"]);
      return pattern
        ? `"${pattern.slice(0, 30)}"${includeGlob ? ` in ${includeGlob}` : ""}`
        : "";
    }
    case "glob":
      return extractStringArg(argsJson, ["pattern"]).slice(0, 40);
    case "git_status":
      return "";
    case "git_diff":
      return pathPreview || "(all)";
    case "propose_file_edit":
      return pathPreview;
    case "propose_apply_patch": {
      const patch = extractStringArg(argsJson, ["patch"]);
      const match = patch.match(/^diff --git a\/(.+?) b\//m);
      return match ? match[1] : "(patch)";
    }
    case "propose_shell": {
      const cmd = extractStringArg(argsJson, ["shell"]);
      return cmd.length > 50 ? cmd.slice(0, 47) + "..." : cmd;
    }
    case "task": {
      const role = extractStringArg(argsJson, ["role"]);
      const description = extractStringArg(argsJson, ["description"]);
      return role ? `${role}: ${description.slice(0, 30)}...` : "";
    }
    case "update_plan": {
      const operation = extractStringArg(argsJson, ["operation"]);
      const stepId = extractStringArg(argsJson, ["step_id"]);
      return `${operation}: ${stepId}`.trim();
    }
    case "diagnostics":
      return argsJson.includes("\"changed_files\"") ? "changed files" : "(all)";
    case "fetch":
      return extractStringArg(argsJson, ["url"]).slice(0, 50);
    default:
      return "";
  }
}

function limitJsonField(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return value.slice(0, maxChars) + "\n...[truncated]";
}

function trimToolContentForContext(toolName: string, jsonText: string): string {
  // Tool content is JSON string. We structurally trim heavy fields per tool.
  try {
    const obj = JSON.parse(jsonText) as Record<string, any>;

    if (toolName === "read_file") {
      if (typeof obj.content_preview === "string") {
        obj.content_preview = limitJsonField(
          obj.content_preview,
          MAX_TOOL_OUTPUT_CHARS
        );
      }
      // Keep hint/metadata; never include any full raw file contents field.
    }

    if (toolName === "grep") {
      if (typeof obj.matches_preview === "string") {
        obj.matches_preview = limitJsonField(
          obj.matches_preview,
          MAX_GREP_PREVIEW_CHARS
        );
      }
      if (
        typeof obj.match_count === "number" &&
        obj.match_count > MAX_GREP_PREVIEW_MATCHES
      ) {
        obj.note = `matches_preview 已限制为前 ${MAX_GREP_PREVIEW_MATCHES} 条，并做了字符裁剪。`;
      }
    }

    if (toolName === "glob") {
      if (typeof obj.files_preview === "string") {
        obj.files_preview = limitJsonField(
          obj.files_preview,
          MAX_GLOB_PREVIEW_CHARS
        );
      }
      if (
        typeof obj.file_count === "number" &&
        obj.file_count > MAX_GLOB_PREVIEW_FILES
      ) {
        obj.note = `files_preview 已限制为前 ${MAX_GLOB_PREVIEW_FILES} 条，并做了字符裁剪。`;
      }
    }

    if (toolName === "diagnostics") {
      // diagnostics tool already aggregates; just cap preview.
      if (typeof obj.diagnostics_preview === "string") {
        obj.diagnostics_preview = limitJsonField(
          obj.diagnostics_preview,
          MAX_TOOL_OUTPUT_CHARS
        );
      }
    }

    if (toolName === "fetch") {
      if (typeof obj.content_preview === "string") {
        obj.content_preview = limitJsonField(
          obj.content_preview,
          MAX_FETCH_PREVIEW_CHARS
        );
      }
    }

    const stringified = JSON.stringify(obj);
    if (stringified.length <= MAX_TOOL_OUTPUT_CHARS) {
      return stringified;
    }

    // Absolute hard cap
    const hard = smartTruncateWithHint(
      stringified,
      MAX_TOOL_OUTPUT_CHARS,
      `tool(${toolName}) 输出过长，已做硬裁剪。`
    );
    return hard.text;
  } catch {
    // Not JSON or parse failed: fallback to char cap
    const hard = smartTruncateWithHint(
      jsonText,
      MAX_TOOL_OUTPUT_CHARS,
      `tool(${toolName}) 输出过长，已做硬裁剪。`
    );
    return hard.text;
  }
}

function renderListEntries(entries: FileEntry[]): string {
  const sorted = [...entries].sort((left, right) => {
    if (left.is_dir !== right.is_dir) {
      return left.is_dir ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
  const preview = sorted.slice(0, MAX_LIST_ENTRIES).map((entry) => {
    if (entry.is_dir) {
      return `[DIR] ${entry.name}/`;
    }
    return `[FILE] ${entry.name} (${entry.size}B)`;
  });
  if (sorted.length > MAX_LIST_ENTRIES) {
    preview.push(`... ${sorted.length - MAX_LIST_ENTRIES} entries omitted`);
  }
  return preview.join("\n");
}

const SUB_AGENT_MAX_TURNS_DEFAULT = 20;
const MAX_SUB_AGENT_RETRIES = 2;

export interface SubAgentResult {
  reply: string;
  status: SubAgentCompletionStatus;
  proposedActions: ActionProposal[];
  toolTrace: ToolExecutionTrace[];
  turnCount: number;
  structuredOutput?: StructuredSubAgentOutput;
  feedback?: SubAgentFeedback;
}

export async function executeSubAgentTask(
  role: string,
  taskDescription: string,
  workspacePath: string,
  settings: AppSettings,
  toolPermissions: ToolPermissions,
  workingMemory?: WorkingMemory,
  onProgress?: (event: SubAgentProgressEvent) => void,
  signal?: AbortSignal,
  focusedPaths?: string[],
  existingProjectConfig?: CofreeRcConfig,
): Promise<SubAgentResult> {
  const agentDef = DEFAULT_AGENTS.find(
    (agent) => agent.role === role && agent.allowAsSubAgent
  );
  if (!agentDef) {
    return {
      reply: `角色 "${role}" 不可用作 Sub-Agent。`,
      status: "failed" as SubAgentCompletionStatus,
      proposedActions: [],
      toolTrace: [],
      turnCount: 0,
    };
  }

  const maxTurns = agentDef.subAgentMaxTurns ?? SUB_AGENT_MAX_TURNS_DEFAULT;
  const subAgentTools = selectToolDefinitions(
    agentDef.tools.filter((toolName) => toolName !== "task")
  );

  // Compute context budgets for sub-agent
  const limitTokens = settings.maxContextTokens > 0 ? settings.maxContextTokens : 128000;
  const outputBufferTokens = Math.min(8000, Math.max(512, Math.floor(limitTokens * 0.15)));
  const hardPromptBudget = Math.max(0, limitTokens - outputBufferTokens);
  const softPromptBudget = Math.floor(hardPromptBudget * 0.9);
  const promptBudgetTarget = softPromptBudget > 0 ? softPromptBudget : hardPromptBudget;
  const inferredFocusedPaths = collectSubAgentFocusedPaths(
    taskDescription,
    workingMemory,
    role as SubAgentRole,
    focusedPaths,
  );
  let matchedRuleContext = "";

  if (workspacePath.trim()) {
    try {
      const projectConfig = existingProjectConfig ?? await loadCofreeRc(workspacePath);
      matchedRuleContext = await buildMatchedContextRuleNote({
        targetPaths: inferredFocusedPaths,
        settings: {
          ...settings,
          workspacePath,
        },
        projectConfig,
        ignorePatterns:
          projectConfig.ignorePatterns && projectConfig.ignorePatterns.length > 0
            ? projectConfig.ignorePatterns
            : null,
        excludedPaths: inferredFocusedPaths,
        heading: "[命中的项目规则]",
      });
    } catch (error) {
      console.warn("[SubAgent] Failed to load matched project rules", error);
    }
  }

  // Inject shared Working Memory context (at most 15% of token budget)
  const memoryContext = workingMemory
    ? serializeWorkingMemory(
      workingMemory,
      Math.floor(promptBudgetTarget * 0.15),
      role as SubAgentRole,
      {
        query: taskDescription,
        focusedPaths: inferredFocusedPaths,
      },
    )
    : "";

  const subAgentSystemPrompt = [
    `你是 Cofree 的 ${agentDef.displayName} Sub-Agent。`,
    `你的专长：${agentDef.promptIntent}`,
    `当前工作区: ${workspacePath}`,
    agentDef.workflowTemplate ? `\n## 标准工作流\n${agentDef.workflowTemplate}` : "",
    matchedRuleContext ? `\n${matchedRuleContext}` : "",
    memoryContext ? `\n## 已知上下文\n${memoryContext}` : "",
    "你正在执行一个被委派的子任务。请专注于完成任务并返回结果。",
    "完成任务后，请简洁地汇报结果。不要提出超出任务范围的额外建议。",
    "严禁输出伪工具调用标签。回复语言与任务描述保持一致。",
    agentDef.outputSchemaHint ? `\n${agentDef.outputSchemaHint}` : "",
    [
      "\n如果你发现任务描述不够清晰或缺少必要信息，请在回复中使用以下 JSON 格式标记：",
      '```json',
      '{"status": "need_clarification", "reason": "...", "missingContext": ["..."]}',
      '```',
      "如果遇到阻塞无法继续，请标记：",
      '```json',
      '{"status": "blocked", "reason": "...", "blockedBy": "...", "suggestedAction": "..."}',
      '```',
    ].join("\n"),
  ].filter(Boolean).join("\n");

  const messages: LiteLLMMessage[] = [
    { role: "system", content: subAgentSystemPrompt },
    { role: "user", content: taskDescription },
  ];

  const proposedActions: ActionProposal[] = [];
  const toolTrace: ToolExecutionTrace[] = [];
  let subToolNotFoundStrikes = 0;
  let subConsecutiveFailureTurns = 0;

  // P0-2: Include tool definition overhead for sub-agent.
  const subToolDefTokens = estimateTokensForToolDefinitions(subAgentTools);
  const compressionPolicy = {
    maxPromptTokens: promptBudgetTarget,
    minMessagesToSummarize: MIN_MESSAGES_TO_SUMMARIZE,
    minRecentMessagesToKeep: MIN_RECENT_MESSAGES_TO_KEEP,
    recentTokensMinRatio: RECENT_TOKENS_MIN_RATIO,
    toolMessageMaxChars: TOOL_MESSAGE_MAX_CHARS,
    mergeToolMessages: true,
    toolDefinitionTokens: subToolDefTokens,
  };
  const summarizer = {
    canSummarize: () => {
      const estTokens = estimateTokensForMessages(messages);
      return canSummarizeNow(workspacePath, estTokens);
    },
    summarize: (messagesToSummarize: LiteLLMMessage[]) =>
      requestSummary(messagesToSummarize, settings, { workspacePath }),
    markSummarized: () => markSummarizedNow(workspacePath),
  };

  console.log(`[SubAgent] 启动 | role=${role} | maxTurns=${maxTurns} | tools=${subAgentTools.length}`);
  onProgress?.({ kind: "summary", message: `${agentDef.displayName} Sub-Agent 已启动` });

  for (let turn = 0; turn < maxTurns; turn += 1) {
    // Check for user abort
    if (signal?.aborted) {
      console.log(`[SubAgent] 用户中断 | turn=${turn}`);
      onProgress?.({ kind: "summary", message: `${agentDef.displayName} 已被用户中断` });
      return {
        reply: "Sub-Agent 已被用户中断。",
        status: "partial" as SubAgentCompletionStatus,
        proposedActions,
        toolTrace,
        turnCount: turn,
      };
    }

    console.log(`[SubAgent] ── Turn ${turn + 1}/${maxTurns} ── messages=${messages.length}`);

    const pinnedPrefixLen = initialSystemPrefixLength(messages);

    const compression = await compressMessagesToFitBudget({
      messages,
      policy: compressionPolicy,
      summarizer,
      pinnedPrefixLen,
    });
    if (compression.compressed && compression.messages !== messages) {
      const beforeLen = messages.length;
      messages.splice(0, messages.length, ...compression.messages);
      console.log(`[SubAgent] 上下文压缩: ${beforeLen} → ${messages.length} messages`);
    }


    const completion = await requestToolCompletion(
      messages,
      settings,
      subAgentTools
    );
    messages.push(completion.assistantMessage);

    // P1-3: Calibrate token estimates from sub-agent API responses (per-model).
    if (completion.requestRecord.inputTokens) {
      const estBeforeCall = estimateTokensForMessages(messages) + subToolDefTokens;
      updateTokenCalibration(estBeforeCall, completion.requestRecord.inputTokens, settings.model);
    }

    if (!completion.toolCalls.length) {
      if (completion.droppedToolCalls > 0) {
        console.warn(`[SubAgent] ${completion.droppedToolCalls} 个工具调用因格式畸形被丢弃`);
        messages.push({
          role: "system",
          content: `系统提示：${completion.droppedToolCalls} 个工具调用因格式畸形被丢弃。请使用正确格式重试。`,
        });
        continue;
      }
      console.log(`[SubAgent] 完成 | turns=${turn + 1}`);
      const finalReply = completion.assistantMessage.content.trim();
      const structuredOutput = tryExtractStructuredOutput(role as SubAgentRole, finalReply);
      if (structuredOutput) {
        console.log(`[SubAgent] 提取到结构化输出 | role=${structuredOutput.role}`);
      }
      const feedbackResult = tryExtractFeedback(finalReply);
      const resolvedStatus: SubAgentCompletionStatus = feedbackResult?.status ?? "completed";
      if (feedbackResult) {
        console.log(`[SubAgent] 提取到反馈 | status=${resolvedStatus} | reason=${feedbackResult.feedback?.reason}`);
      }
      return {
        reply: finalReply,
        status: resolvedStatus,
        proposedActions,
        toolTrace,
        turnCount: turn + 1,
        structuredOutput,
        feedback: feedbackResult?.feedback,
      };
    }

    const subToolNames = completion.toolCalls.map((tc) => tc.function.name);
    console.log(`[SubAgent] Turn ${turn + 1} 收到 ${completion.toolCalls.length} 个工具调用: [${subToolNames.join(", ")}]`);

    let subTurnHasToolNotFound = false;
    let subTurnSuccessCount = 0;
    let subTurnFailureCount = 0;
    for (const toolCall of completion.toolCalls) {
      onProgress?.({ kind: "tool_start", toolName: toolCall.function.name, turn, maxTurns });
      const subToolT0 = performance.now();
      const { result: toolResult, trace } = await executeToolCallWithRetry(
        toolCall,
        workspacePath,
        toolPermissions,
        settings,
        undefined,
        [],
        agentDef.tools,
        undefined,
        workingMemory,
        undefined,
        signal,
        turn,
        inferredFocusedPaths,
      );
      const subToolDurationMs = performance.now() - subToolT0;
      const subToolMs = subToolDurationMs.toFixed(0);
      onProgress?.({
        kind: "tool_complete",
        toolName: toolCall.function.name,
        success: toolResult.success !== false,
        durationMs: Math.round(subToolDurationMs),
      });
      console.log(
        `[SubAgent][Tool] ${toolCall.function.name} → ${trace.status} | ${subToolMs}ms` +
        (trace.status === "failed" ? ` | ${trace.errorMessage}` : "")
      );
      toolTrace.push(trace);

      if (toolResult.success === false) {
        subTurnFailureCount += 1;
        if (toolResult.errorCategory === "tool_not_found") {
          subTurnHasToolNotFound = true;
        }
      } else {
        subTurnSuccessCount += 1;
        // Feed successful tool results back into shared Working Memory
        if (workingMemory) {
          try {
            const parsedArgs = JSON.parse(toolCall.function.arguments || "{}");
            const knowledge = extractFileKnowledge(
              toolCall.function.name,
              parsedArgs,
              toolResult.content,
              role,
            );
            if (knowledge) {
              workingMemory.fileKnowledge.set(knowledge.relativePath, knowledge);
            }
          } catch {
            // Ignore parse errors for working memory extraction
          }
        }
      }

      if (toolResult.proposedAction) {
        proposedActions.push(toolResult.proposedAction);
        onProgress?.({
          kind: "action_proposed",
          actionType: toolResult.proposedAction.type,
          description: toolResult.proposedAction.description,
        });
      }

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        name: toolCall.function.name,
        content: trimToolContentForContext(
          toolCall.function.name,
          toolResult.content
        ),
      });
    }

    // --- Circuit breaker: tool_not_found ---
    if (subTurnHasToolNotFound) {
      subToolNotFoundStrikes += 1;
    } else {
      subToolNotFoundStrikes = 0;
    }
    if (subToolNotFoundStrikes >= MAX_TOOL_NOT_FOUND_STRIKES) {
      console.warn(`[SubAgent] 熔断: tool_not_found 连续 ${subToolNotFoundStrikes} 轮`);
      return {
        reply: "Sub-Agent 多次调用不存在的工具，已自动终止。",
        status: "failed" as SubAgentCompletionStatus,
        proposedActions,
        toolTrace,
        turnCount: turn + 1,
      };
    }
    if (subToolNotFoundStrikes > 0) {
      const subToolNames = subAgentTools.map((t) => t.function.name);
      messages.push({
        role: "system",
        content: [
          `系统提示：你调用了不存在的工具（连续 ${subToolNotFoundStrikes} 轮）。`,
          `你只能使用以下工具: [${subToolNames.join(", ")}]`,
          "请严格从上述列表中选择工具，不要臆造工具名称。",
        ].join("\n"),
      });
    }

    // --- Circuit breaker: consecutive all-failure turns ---
    if (subTurnSuccessCount === 0 && subTurnFailureCount > 0) {
      subConsecutiveFailureTurns += 1;
    } else {
      subConsecutiveFailureTurns = 0;
    }
    if (subConsecutiveFailureTurns >= MAX_CONSECUTIVE_FAILURE_TURNS) {
      console.warn(`[SubAgent] 熔断: 连续 ${subConsecutiveFailureTurns} 轮全部失败`);
      return {
        reply: "Sub-Agent 连续多轮工具调用全部失败，已自动终止。",
        status: "failed" as SubAgentCompletionStatus,
        proposedActions,
        toolTrace,
        turnCount: turn + 1,
      };
    }
  }

  console.warn(`[SubAgent] 达到轮次上限 (${maxTurns})，强制返回`);
  return {
    reply: "Sub-Agent 达到工具调用轮次上限，已返回当前进度。",
    status: "partial" as SubAgentCompletionStatus,
    proposedActions,
    toolTrace,
    turnCount: maxTurns,
  };
}

function buildRetryDescription(
  originalDescription: string,
  previousResult: SubAgentResult,
  workingMemory?: WorkingMemory,
): string {
  const parts = [originalDescription];

  if (previousResult.feedback) {
    parts.push(
      "\n## 上一次尝试的反馈",
      `状态: ${previousResult.status}`,
      `原因: ${previousResult.feedback.reason}`,
    );
    if (previousResult.feedback.missingContext?.length) {
      parts.push(`缺少的上下文: ${previousResult.feedback.missingContext.join(", ")}`);
      // Try to supplement from Working Memory
      if (workingMemory) {
        for (const ctx of previousResult.feedback.missingContext) {
          const matchingFile = [...workingMemory.fileKnowledge.values()].find(
            (fk) => fk.relativePath.includes(ctx) || ctx.includes(fk.relativePath),
          );
          if (matchingFile) {
            parts.push(`补充信息 - ${matchingFile.relativePath}: ${matchingFile.summary}`);
          }
        }
      }
    }
    if (previousResult.feedback.suggestedAction) {
      parts.push(`建议: ${previousResult.feedback.suggestedAction}`);
    }
  }

  return parts.join("\n");
}

interface DiagnosticEntry {
  file: string;
  line: number;
  column: number;
  severity: string;
  message: string;
}

interface DiagnosticsResult {
  success: boolean;
  diagnostics: DiagnosticEntry[];
  tool_used: string;
  raw_output: string;
}

async function fetchPostPatchDiagnostics(
  workspacePath: string,
  changedFiles: string[]
): Promise<{ hasDiagnostics: boolean; summary: string }> {
  try {
    const result = await invoke<DiagnosticsResult>(
      "get_workspace_diagnostics",
      {
        workspacePath,
        changedFiles,
      }
    );
    if (
      !result.success ||
      result.tool_used === "none" ||
      result.diagnostics.length === 0
    ) {
      return { hasDiagnostics: false, summary: "" };
    }
    const relevantDiagnostics = result.diagnostics.slice(0, 10);
    const lines = relevantDiagnostics.map(
      (d) =>
        `${d.severity.toUpperCase()} ${d.file}:${d.line}:${d.column} ${d.message
        }`
    );
    const summary = `[诊断反馈 via ${result.tool_used}] 发现 ${result.diagnostics.length
      } 个问题:\n${lines.join("\n")}`;
    return { hasDiagnostics: true, summary };
  } catch {
    return { hasDiagnostics: false, summary: "" };
  }
}

async function executeToolCall(
  call: ToolCallRecord,
  workspacePath: string,
  toolPermissions: ToolPermissions = DEFAULT_TOOL_PERMISSIONS,
  settings?: AppSettings,
  projectConfig?: CofreeRcConfig,
  allowedSubAgents?: SubAgentRole[],
  enabledToolNames?: string[],
  planState?: TodoPlanState,
  workingMemory?: WorkingMemory,
  onSubAgentProgress?: (event: SubAgentProgressEvent) => void,
  signal?: AbortSignal,
  turn?: number,
  focusedPaths?: string[],
  sessionId?: string,
  onAskUserRequest?: (request: AskUserRequest) => void,
): Promise<ToolExecutionResult> {
  const safeWorkspace = workspacePath.trim();
  if (!safeWorkspace) {
    const message = "未选择工作区。";
    return {
      content: JSON.stringify({ error: message }),
      success: false,
      errorCategory: "workspace",
      errorMessage: message,
    };
  }

  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.function.arguments) as Record<string, unknown>;
  } catch (_error) {
    const message = "tool arguments 不是合法 JSON";
    return {
      content: JSON.stringify({ error: message }),
      success: false,
      errorCategory: "validation",
      errorMessage: message,
    };
  }

  try {
    if (call.function.name === "list_files") {
      const relativePath = normalizeRelativePath(args.relative_path);
      const ignorePatterns =
        projectConfig?.ignorePatterns && projectConfig.ignorePatterns.length > 0
          ? projectConfig.ignorePatterns
          : null;
      const entries = await invoke<FileEntry[]>("list_workspace_files", {
        workspacePath: safeWorkspace,
        relativePath,
        ignorePatterns,
      });
      return {
        content: JSON.stringify({
          ok: true,
          relative_path: relativePath,
          entry_count: entries.length,
          entries_preview: renderListEntries(entries),
        }),
        success: true,
      };
    }

    if (call.function.name === "read_file") {
      const relativePath = normalizeRelativePath(args.relative_path);
      const startLine = normalizeOptionalPositiveInt(args.start_line);
      const endLine = normalizeOptionalPositiveInt(args.end_line);
      if (!relativePath) {
        const message = "relative_path 不能为空";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }
      if (startLine && endLine && startLine > endLine) {
        const message = "start_line 不能大于 end_line";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }

      // --- 读取去重：仅对无行范围的全文读取进行去重 ---
      if (!startLine && !endLine && workingMemory && turn !== undefined) {
        const existing = workingMemory.fileKnowledge.get(relativePath);
        if (existing && existing.lastReadTurn !== undefined
          && (turn - existing.lastReadTurn) < DEDUP_TURN_WINDOW) {
          return {
            success: true,
            content: JSON.stringify({
              status: "cached",
              message: `此文件已在第 ${existing.lastReadTurn + 1} 轮读取过（当前第 ${turn + 1} 轮）。`,
              cached_summary: existing.summary,
              total_lines: existing.totalLines,
              language: existing.language || "unknown",
              hint: "如需查看特定区域，请使用 start_line/end_line 参数精确读取。如需更新信息，请使用 grep 搜索特定内容。",
            }),
          };
        }
      }

      const result = await invoke<{
        content: string;
        total_lines: number;
        start_line: number;
        end_line: number;
      }>("read_workspace_file", {
        workspacePath: safeWorkspace,
        relativePath,
        startLine,
        endLine,
        ignorePatterns:
          projectConfig?.ignorePatterns &&
            projectConfig.ignorePatterns.length > 0
            ? projectConfig.ignorePatterns
            : null,
      });

      // Add line numbers to content for model orientation
      const lines = result.content.split("\n");
      // Remove trailing empty line from split if content ends with \n
      if (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop();
      }
      const numbered = lines
        .map((line, i) => `${result.start_line + i}│${line}`)
        .join("\n");
      const trimmed = smartTruncate(numbered, MAX_FILE_PREVIEW_CHARS);
      const wasTruncated = numbered.length > MAX_FILE_PREVIEW_CHARS;

      return {
        content: JSON.stringify({
          ok: true,
          relative_path: relativePath,
          total_lines: result.total_lines,
          showing_lines: `${result.start_line}-${result.end_line}`,
          content_preview: trimmed,
          truncated: wasTruncated,
          ...(wasTruncated
            ? {
              hint: `文件共 ${result.total_lines} 行，当前预览已被截断（仅显示头部和尾部）。` +
                `若需编辑此文件，请勿直接从预览中复制长段落作为 search 片段（可能与实际内容不一致）。` +
                `推荐：先用 read_file 的 start_line/end_line 读取目标区域的精确内容，再用 propose_file_edit 的 start_line/end_line 行范围方式编辑。`,
            }
            : {}),
        }),
        success: true,
      };
    }

    if (call.function.name === "git_status") {
      const status = await invoke<{
        modified: string[];
        added: string[];
        deleted: string[];
        untracked: string[];
      }>("git_status_workspace", {
        workspacePath: safeWorkspace,
      });
      return {
        content: JSON.stringify({
          ok: true,
          ...status,
        }),
        success: true,
      };
    }

    if (call.function.name === "git_diff") {
      const filePath = normalizeRelativePath(args.file_path);
      const diff = await invoke<string>("git_diff_workspace", {
        workspacePath: safeWorkspace,
        filePath: filePath || null,
      });
      return {
        content: JSON.stringify({
          ok: true,
          file_path: filePath || null,
          diff_preview: smartTruncate(diff, MAX_FILE_PREVIEW_CHARS),
          truncated: diff.length > MAX_FILE_PREVIEW_CHARS,
        }),
        success: true,
      };
    }

    if (call.function.name === "grep") {
      const pattern = asString(args.pattern).trim();
      if (!pattern) {
        const message = "pattern 不能为空";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }
      const includeGlob = asString(args.include_glob).trim() || null;
      const maxResults = normalizeOptionalPositiveInt(args.max_results) ?? 50;
      const result = await invoke<{
        matches: Array<{ file: string; line: number; content: string }>;
        truncated: boolean;
      }>("grep_workspace_files", {
        workspacePath: safeWorkspace,
        pattern,
        includeGlob,
        maxResults,
        ignorePatterns:
          projectConfig?.ignorePatterns &&
            projectConfig.ignorePatterns.length > 0
            ? projectConfig.ignorePatterns
            : null,
      });
      const matchCount = result.matches.length;
      const preview = result.matches
        .slice(0, 30)
        .map((m) => `${m.file}:${m.line}│${m.content}`)
        .join("\n");
      return {
        content: JSON.stringify({
          ok: true,
          pattern,
          include_glob: includeGlob,
          match_count: matchCount,
          truncated: result.truncated,
          matches_preview: smartTruncate(preview, MAX_FILE_PREVIEW_CHARS),
        }),
        success: true,
      };
    }

    if (call.function.name === "glob") {
      const pattern = asString(args.pattern).trim();
      if (!pattern) {
        const message = "pattern 不能为空";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }
      const maxResults = normalizeOptionalPositiveInt(args.max_results) ?? 100;
      const entries = await invoke<
        Array<{ path: string; size: number; modified: number }>
      >("glob_workspace_files", {
        workspacePath: safeWorkspace,
        pattern,
        maxResults,
        ignorePatterns:
          projectConfig?.ignorePatterns &&
            projectConfig.ignorePatterns.length > 0
            ? projectConfig.ignorePatterns
            : null,
      });
      const preview = entries
        .slice(0, 60)
        .map((e) => `${e.path} (${e.size}B)`)
        .join("\n");
      return {
        content: JSON.stringify({
          ok: true,
          pattern,
          file_count: entries.length,
          files_preview: smartTruncate(preview, MAX_FILE_PREVIEW_CHARS),
        }),
        success: true,
      };
    }

    if (call.function.name === "update_plan") {
      if (!planState) {
        const message = "update_plan 缺少当前计划上下文";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }

      const operation = asString(args.operation).trim();
      const stepId = asString(args.step_id).trim();
      const note = asString(args.note).trim();
      if (!operation) {
        const message = "operation 不能为空";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }
      if (!stepId) {
        const message = "step_id 不能为空";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }

      let message = "";
      switch (operation) {
        case "set_active":
          message = setActivePlanStep(planState, stepId);
          break;
        case "complete":
          message = setPlanStepStatus(planState, stepId, "completed", note);
          break;
        case "block":
          message = setPlanStepStatus(planState, stepId, "blocked", note);
          break;
        case "fail":
          message = setPlanStepStatus(planState, stepId, "failed", note);
          break;
        case "skip":
          message = setPlanStepStatus(planState, stepId, "skipped", note);
          break;
        case "note": {
          const target = planState.steps.find((step) => step.id === stepId);
          if (!target) {
            message = `未找到步骤 ${stepId}`;
          } else {
            appendPlanStepNote(target, note || asString(args.summary).trim());
            message = `步骤「${target.title}」备注已更新`;
          }
          break;
        }
        case "add": {
          const title = asString(args.title).trim() || stepId;
          if (!title) {
            message = "operation=add 时必须提供 title";
            break;
          }
          const added = addPlanStep(planState, {
            title,
            summary: asString(args.summary).trim(),
            owner: (["planner", "coder", "tester", "debugger", "reviewer"].includes(asString(args.owner).trim())
              ? (asString(args.owner).trim() as PlanStep["owner"])
              : undefined),
            afterStepId: asString(args.after_step_id).trim() || undefined,
            note,
          });
          message = `已新增步骤「${added.title}」`;
          break;
        }
        default:
          message = `不支持的 update_plan operation: ${operation}`;
      }

      const isError = message.startsWith("未找到") || message.startsWith("不支持") || message.startsWith("operation=");
      return {
        content: JSON.stringify({
          ok: !isError,
          action_type: "update_plan",
          operation,
          step_id: stepId,
          message,
          active_step_id: planState.activeStepId ?? null,
          plan_summary: formatTodoPlanBlock(planState),
          steps: planState.steps.map((step) => ({
            id: step.id,
            title: step.title,
            owner: step.owner,
            status: step.status,
            linkedActionIds: step.linkedActionIds ?? [],
          })),
        }),
        success: !isError,
        errorCategory: isError ? "validation" : undefined,
        errorMessage: isError ? message : undefined,
      };
    }

    if (call.function.name === "propose_apply_patch") {
      const patch = asString(args.patch).trim();
      if (!patch) {
        const message = "patch 不能为空";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }
      const preflight = await invoke<PatchApplyResult>(
        "check_workspace_patch",
        {
          workspacePath: safeWorkspace,
          patch,
        }
      );
      if (!preflight.success) {
        const message = `Patch 预检失败: ${preflight.message}`;
        return {
          content: JSON.stringify({
            error: message,
            files: preflight.files,
          }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }
      if (preflight.files.length > 1) {
        const message = `propose_apply_patch 仅允许单文件 patch；当前 patch 涉及 ${preflight.files.length} 个文件。请改用 propose_file_edit 按文件逐个提交。`;
        return {
          content: JSON.stringify({
            error: message,
            files: preflight.files,
          }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }
      const actionBase: ActionProposal = {
        id: createActionId("gate-a-apply-patch"),
        toolCallId: call.id,
        toolName: call.function.name,
        planStepId: planState?.activeStepId,
        type: "apply_patch",
        description: asString(
          args.description,
          "Apply generated patch to workspace (Gate A)"
        ),
        gateRequired: true,
        status: "pending",
        executed: false,
        payload: {
          patch,
        },
      };
      const action: ActionProposal = {
        ...actionBase,
        fingerprint: actionFingerprint(actionBase),
      };
      const matchedRule = findMatchingApprovalRule(safeWorkspace, action);
      const autoApprovalSource =
        toolPermissions.propose_apply_patch === "auto"
          ? "tool_permission"
          : matchedRule
            ? "workspace_rule"
            : null;
      if (autoApprovalSource) {
        return autoExecutePatchProposal({
          workspacePath: safeWorkspace,
          patch,
          autoApprovalMeta: buildAutoApprovalMeta(autoApprovalSource, matchedRule),
        });
      }
      return {
        content: JSON.stringify({
          ok: true,
          action_type: "apply_patch",
          action_id: action.id,
          patch_length: patch.length,
          files: preflight.files,
        }),
        success: true,
        proposedAction: action,
      };
    }

    if (call.function.name === "propose_file_edit") {
      const relativePath = normalizeRelativePath(args.relative_path);
      const operationRaw = asString(args.operation, "replace")
        .trim()
        .toLowerCase();
      const operation = operationRaw || "replace";
      const applyAll = asBoolean(
        args.apply_all,
        asBoolean(args.replace_all, false)
      );
      const positionCandidate = asString(args.position, "after")
        .trim()
        .toLowerCase();
      const insertPosition =
        positionCandidate === "before" ? "before" : "after";
      const line = normalizeOptionalPositiveInt(args.line);
      const startLine = normalizeOptionalPositiveInt(args.start_line);
      const endLine = normalizeOptionalPositiveInt(args.end_line);
      if (!relativePath) {
        const message = "relative_path 不能为空";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }
      let patch = "";
      const responseMeta: Record<string, unknown> = {
        mode: "file_edit",
        operation,
        relative_path: relativePath,
        apply_all: applyAll,
      };
      if (line) {
        responseMeta.line = line;
      }
      if (startLine) {
        responseMeta.start_line = startLine;
      }
      if (endLine) {
        responseMeta.end_line = endLine;
      }

      if (endLine && !startLine) {
        const message = "提供 end_line 时必须同时提供 start_line";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }
      if (startLine && endLine && startLine > endLine) {
        const message = "start_line 不能大于 end_line";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }

      if (operation === "create") {
        const createContent = asString(args.content, asString(args.replace));
        const overwrite = asBoolean(args.overwrite, false);
        if (!createContent) {
          const message = "create 操作要求 content 非空。operation='create' 必须提供 content 参数，包含要写入的完整文件内容。";
          return {
            content: JSON.stringify({ error: message }),
            success: false,
            errorCategory: "validation",
            errorMessage: message,
          };
        }

        let existingContent: string | null = null;
        try {
          existingContent = (
            await invoke<{
              content: string;
              total_lines: number;
              start_line: number;
              end_line: number;
            }>("read_workspace_file", {
              workspacePath: safeWorkspace,
              relativePath,
            })
          ).content;
        } catch (_error) {
          existingContent = null;
        }

        if (existingContent !== null && !overwrite) {
          const message = `目标文件已存在: ${relativePath}（如需覆盖请设置 overwrite=true）`;
          return {
            content: JSON.stringify({ error: message }),
            success: false,
            errorCategory: "validation",
            errorMessage: message,
          };
        }

        patch =
          existingContent === null
            ? buildCreateFilePatch(relativePath, createContent)
            : await buildReplacementPatch(
              relativePath,
              existingContent,
              createContent
            );
        responseMeta.created = existingContent === null;
        responseMeta.overwrite = overwrite;
      } else {
        let original = "";
        let fileExists = true;
        try {
          original = (
            await invoke<{
              content: string;
              total_lines: number;
              start_line: number;
              end_line: number;
            }>("read_workspace_file", {
              workspacePath: safeWorkspace,
              relativePath,
            })
          ).content;
          // Normalize CRLF → LF so search snippets (which models always generate with \n) match correctly
          original = original.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        } catch (_readError) {
          fileExists = false;
          // File doesn't exist — auto-detect as create intent
          const createContent = asString(args.content, asString(args.replace));
          if (createContent) {
            patch = buildCreateFilePatch(relativePath, createContent);
            responseMeta.auto_create = true;
            responseMeta.operation = "create";
          } else {
            const message = `文件不存在: ${relativePath}。若要创建新文件，请使用 operation='create' 并提供 content 参数`;
            return {
              content: JSON.stringify({ error: message }),
              success: false,
              errorCategory: "validation",
              errorMessage: message,
            };
          }
        }
        if (!patch && fileExists) {
          let nextContent = original;

          if (operation === "replace") {
            if (startLine) {
              const replacement = asString(
                args.content,
                asString(args.replace)
              );
              nextContent = replaceByLineRange(
                original,
                startLine,
                endLine ?? startLine,
                replacement
              );
              responseMeta.selection_mode = "line_range";
            } else {
              const search = stripLineNumberPrefixes(asString(args.search));
              const replace = asString(args.replace);
              if (!search) {
                const message =
                  "replace 操作要求 search 非空，或提供 start_line/end_line。若要创建新文件，请改用 operation='create' 并提供 content 参数";
                return {
                  content: JSON.stringify({ error: message }),
                  success: false,
                  errorCategory: "validation",
                  errorMessage: message,
                };
              }
              const hits = countOccurrences(original, search);
              if (hits < 1) {
                const message = `search 片段未找到: ${relativePath}。search 必须精确匹配文件内容（不含行号前缀）。建议改用 start_line/end_line 行范围方式编辑。`;
                return {
                  content: JSON.stringify({ error: message }),
                  success: false,
                  errorCategory: "validation",
                  errorMessage: message,
                };
              }
              if (!applyAll && hits > 1) {
                const message = `search 片段出现多次（${hits} 次）；请提供更精确片段或设置 apply_all=true`;
                return {
                  content: JSON.stringify({ error: message }),
                  success: false,
                  errorCategory: "validation",
                  errorMessage: message,
                };
              }

              nextContent = applyAll
                ? original.split(search).join(replace)
                : original.replace(search, replace);
              responseMeta.matched = hits;
            }
          } else if (operation === "insert") {
            const insertContent = asString(
              args.content,
              asString(args.replace)
            );
            if (!insertContent) {
              const message = "insert 操作要求 content 非空";
              return {
                content: JSON.stringify({ error: message }),
                success: false,
                errorCategory: "validation",
                errorMessage: message,
              };
            }
            if (line) {
              nextContent = insertByLine(
                original,
                line,
                insertContent,
                insertPosition
              );
              responseMeta.selection_mode = "line_anchor";
              responseMeta.position = insertPosition;
            } else {
              const anchor = stripLineNumberPrefixes(
                asString(args.anchor, asString(args.search))
              );
              if (!anchor) {
                const message = "insert 操作要求 anchor 非空，或提供 line";
                return {
                  content: JSON.stringify({ error: message }),
                  success: false,
                  errorCategory: "validation",
                  errorMessage: message,
                };
              }
              const hits = countOccurrences(original, anchor);
              if (hits < 1) {
                const message = `anchor 片段未找到: ${relativePath}。anchor 必须精确匹配文件内容（不含行号前缀）。建议改用 line 参数指定插入位置。`;
                return {
                  content: JSON.stringify({ error: message }),
                  success: false,
                  errorCategory: "validation",
                  errorMessage: message,
                };
              }
              if (!applyAll && hits > 1) {
                const message = `anchor 片段出现多次（${hits} 次）；请提供更精确片段或设置 apply_all=true`;
                return {
                  content: JSON.stringify({ error: message }),
                  success: false,
                  errorCategory: "validation",
                  errorMessage: message,
                };
              }

              const anchored =
                insertPosition === "before"
                  ? `${insertContent}${anchor}`
                  : `${anchor}${insertContent}`;
              nextContent = applyAll
                ? original.split(anchor).join(anchored)
                : original.replace(anchor, anchored);
              responseMeta.matched = hits;
              responseMeta.position = insertPosition;
            }
          } else if (operation === "delete") {
            if (startLine) {
              nextContent = replaceByLineRange(
                original,
                startLine,
                endLine ?? startLine,
                ""
              );
              responseMeta.selection_mode = "line_range";
            } else {
              const search = stripLineNumberPrefixes(
                asString(args.search, asString(args.anchor))
              );
              if (!search) {
                const message =
                  "delete 操作要求 search 非空，或提供 start_line/end_line。若目标是删除整个文件，请改用 propose_run_command 执行 rm <relative_path>。";
                return {
                  content: JSON.stringify({ error: message }),
                  success: false,
                  errorCategory: "validation",
                  errorMessage: message,
                };
              }
              const hits = countOccurrences(original, search);
              if (hits < 1) {
                const message = `search 片段未找到: ${relativePath}。search 必须精确匹配文件内容（不含行号前缀）。建议改用 start_line/end_line 行范围方式编辑。`;
                return {
                  content: JSON.stringify({ error: message }),
                  success: false,
                  errorCategory: "validation",
                  errorMessage: message,
                };
              }
              if (!applyAll && hits > 1) {
                const message = `search 片段出现多次（${hits} 次）；请提供更精确片段或设置 apply_all=true`;
                return {
                  content: JSON.stringify({ error: message }),
                  success: false,
                  errorCategory: "validation",
                  errorMessage: message,
                };
              }

              nextContent = applyAll
                ? original.split(search).join("")
                : original.replace(search, "");
              responseMeta.matched = hits;
            }
          } else {
            const message = `不支持的 file edit operation: ${operation}`;
            return {
              content: JSON.stringify({ error: message }),
              success: false,
              errorCategory: "validation",
              errorMessage: message,
            };
          }

          patch = await buildReplacementPatch(
            relativePath,
            original,
            nextContent
          );
        } // end if (!patch && fileExists)
      }

      const preflight = await invoke<PatchApplyResult>(
        "check_workspace_patch",
        {
          workspacePath: safeWorkspace,
          patch,
        }
      );
      if (!preflight.success) {
        const message = `Patch 预检失败: ${preflight.message}`;
        return {
          content: JSON.stringify({
            error: message,
            files: preflight.files,
          }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }

      const action: ActionProposal = {
        id: createActionId("gate-a-apply-patch"),
        toolCallId: call.id,
        toolName: call.function.name,
        planStepId: planState?.activeStepId,
        type: "apply_patch",
        description: asString(
          args.description,
          `Apply structured edit for ${relativePath} (Gate A)`
        ),
        gateRequired: true,
        status: "pending",
        executed: false,
        payload: {
          patch,
        },
      };
      action.fingerprint = actionFingerprint(action);
      const matchedRule = findMatchingApprovalRule(safeWorkspace, action);
      const autoApprovalSource =
        toolPermissions.propose_file_edit === "auto"
          ? "tool_permission"
          : matchedRule
            ? "workspace_rule"
            : null;
      if (autoApprovalSource) {
        return autoExecutePatchProposal({
          workspacePath: safeWorkspace,
          patch,
          responseMeta,
          autoApprovalMeta: buildAutoApprovalMeta(autoApprovalSource, matchedRule),
        });
      }
      return {
        content: JSON.stringify({
          ok: true,
          action_type: "apply_patch",
          action_id: action.id,
          patch_length: patch.length,
          files: preflight.files,
          ...responseMeta,
        }),
        success: true,
        proposedAction: action,
      };
    }

    if (call.function.name === "propose_shell") {
      const shell = asString(args.shell).trim();
      if (!shell) {
        const message = "shell 命令不能为空";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }
      const timeout = Math.max(
        1000,
        Math.min(600000, asNumber(args.timeout_ms, 120000))
      );
      if (timeout < 1000 || timeout > 600000) {
        const message = "timeout_ms 必须在 1000-600000 之间";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }
      const action: ActionProposal = {
        id: createActionId("gate-shell"),
        toolCallId: call.id,
        toolName: call.function.name,
        planStepId: planState?.activeStepId,
        type: "shell",
        description: asString(args.description, "Execute shell command (Gate)"),
        gateRequired: true,
        status: "pending",
        executed: false,
        payload: {
          shell,
          timeoutMs: timeout,
        },
      };
      action.fingerprint = actionFingerprint(action);
      const matchedRule = findMatchingApprovalRule(safeWorkspace, action);
      const autoApprovalSource =
        toolPermissions.propose_shell === "auto"
          ? "tool_permission"
          : matchedRule
            ? "workspace_rule"
            : null;
      if (autoApprovalSource) {
        return autoExecuteShellProposal({
          workspacePath: safeWorkspace,
          shell,
          timeoutMs: timeout,
          autoApprovalMeta: buildAutoApprovalMeta(autoApprovalSource, matchedRule),
        });
      }
      return {
        content: JSON.stringify({
          action_type: "shell",
          action_id: action.id,
          shell,
          timeout_ms: timeout,
          approval_required: true,
          proposal_created: true,
          execution_state: "pending_approval",
          command_executed: false,
          action_status: action.status,
          message: "Shell 命令已创建待审批动作，尚未执行。",
        }),
        success: true,
        traceStatus: "pending_approval",
        proposedAction: action,
      };
    }

    if (call.function.name === "task") {
      const role = asString(args.role).trim();
      const teamId = asString(args.team).trim();
      const description = asString(args.description).trim();
      if (!role && !teamId) {
        const message = "role 和 team 不能同时为空";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }
      if (!description) {
        const message = "description 不能为空";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }

      if (teamId) {
        const teamDef = BUILTIN_TEAMS.find((t) => t.id === teamId);
        if (!teamDef) {
          const validTeams = BUILTIN_TEAMS.map((t) => t.id).join(", ");
          const message = `无效的 Team ID: "${teamId}"。可用团队: ${validTeams}`;
          return {
            content: JSON.stringify({ error: message }),
            success: false,
            errorCategory: "validation",
            errorMessage: message,
          };
        }
        if (!settings) {
          const message = "task 工具需要 settings 上下文，当前调用缺少 settings";
          return {
            content: JSON.stringify({ error: message }),
            success: false,
            errorCategory: "validation",
            errorMessage: message,
          };
        }

        const teamResult = await executeAgentTeam({
          team: teamDef,
          taskDescription: description,
          workspacePath: safeWorkspace,
          settings,
          toolPermissions,
          workingMemory,
          focusedPaths,
          onStageProgress: (stage, event) => {
            onSubAgentProgress?.({
              ...event,
              kind: "summary",
              message: `[${stage}] ${event.kind === "summary" ? event.message : event.kind}`
            });
          },
          signal
        });

        const responsePayload: Record<string, unknown> = {
          ok: teamResult.status === "completed",
          action_type: "team_task",
          team: teamId,
          status: teamResult.status,
          reply: teamResult.finalReply,
        };
        const result: ToolExecutionResult = {
          content: JSON.stringify(responsePayload),
          success: true,
        };
        return result;
      }
      const validRoles: string[] = allowedSubAgents !== undefined
        ? [...allowedSubAgents]
        : DEFAULT_AGENTS.filter((agent) => agent.allowAsSubAgent).map((agent) => agent.role);
      if (!validRoles.includes(role)) {
        const message = allowedSubAgents !== undefined
          ? `当前 Agent 不允许委派给 "${role}" 角色。可用角色: ${validRoles.join(", ") || "(无)"}`
          : `无效的 Sub-Agent 角色: "${role}"。可用角色: ${validRoles.join(", ")}`;
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }
      if (!settings) {
        const message = "task 工具需要 settings 上下文，当前调用缺少 settings";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }
      // --- Retry loop: Sub-Agent may request clarification ---
      let lastResult: SubAgentResult | null = null;
      for (let attempt = 0; attempt <= MAX_SUB_AGENT_RETRIES; attempt++) {
        const enrichedDescription = attempt === 0
          ? description
          : buildRetryDescription(description, lastResult!, workingMemory);

        const subResult = await executeSubAgentTask(
          role,
          enrichedDescription,
          safeWorkspace,
          settings,
          toolPermissions,
          workingMemory,
          onSubAgentProgress,
          signal,
          focusedPaths,
          projectConfig,
        );
        lastResult = subResult;

        if (subResult.status === "completed" || attempt >= MAX_SUB_AGENT_RETRIES) {
          break;
        }
        if (subResult.status === "need_clarification" && subResult.feedback) {
          console.log(`[SubAgent] 需要澄清 (attempt ${attempt + 1}): ${subResult.feedback.reason}`);
          continue;
        }
        if (subResult.status === "blocked") {
          break;
        }
        // For partial/failed without feedback, no point retrying
        break;
      }

      const subResult = lastResult!;

      // Record sub-agent execution in Working Memory
      if (workingMemory) {
        const keyFindings: string[] = [];
        if (subResult.structuredOutput?.role === "planner") {
          const plannerData = subResult.structuredOutput.data;
          if (plannerData.architectureNotes) {
            addDiscoveredFact(workingMemory, {
              category: "architecture",
              content: plannerData.architectureNotes,
              source: `planner:${description.slice(0, 100)}`,
              confidence: "high",
            });
          }
          keyFindings.push(...plannerData.tasks.map((t) => t.title));
        }
        recordSubAgentExecution(workingMemory, {
          role: role as SubAgentRole,
          taskDescription: description,
          replySummary: subResult.reply.slice(0, 500),
          proposedActionCount: subResult.proposedActions.length,
          keyFindings,
        });
      }

      const responsePayload: Record<string, unknown> = {
        ok: subResult.status === "completed",
        action_type: "sub_agent_task",
        role,
        status: subResult.status,
        turn_count: subResult.turnCount,
        reply: subResult.reply,
        proposed_action_count: subResult.proposedActions.length,
        tool_call_count: subResult.toolTrace.length,
        structured_output: subResult.structuredOutput?.data ?? null,
        feedback: subResult.feedback ?? null,
      };
      const result: ToolExecutionResult = {
        content: JSON.stringify(responsePayload),
        success: true,
      };
      if (subResult.proposedActions.length > 0) {
        result.proposedAction = subResult.proposedActions[0];
      }
      return result;
    }

    if (call.function.name === "diagnostics") {
      const changedFiles = Array.isArray(args.changed_files)
        ? (args.changed_files as string[])
          .map((f) => String(f).trim())
          .filter(Boolean)
        : undefined;
      const result = await invoke<{
        success: boolean;
        diagnostics: Array<{
          file: string;
          line: number;
          column: number;
          severity: string;
          message: string;
        }>;
        tool_used: string;
        raw_output: string;
      }>("get_workspace_diagnostics", {
        workspacePath: safeWorkspace,
        changedFiles:
          changedFiles && changedFiles.length > 0 ? changedFiles : null,
      });

      const errorCount = result.diagnostics.filter(
        (d) => d.severity === "error"
      ).length;
      const warningCount = result.diagnostics.filter(
        (d) => d.severity === "warning"
      ).length;
      const diagnosticsPreview = result.diagnostics
        .slice(0, 50)
        .map(
          (d) =>
            `${d.severity.toUpperCase()} ${d.file}:${d.line}:${d.column} ${d.message
            }`
        )
        .join("\n");

      return {
        content: JSON.stringify({
          ok: true,
          tool_used: result.tool_used,
          error_count: errorCount,
          warning_count: warningCount,
          total_diagnostics: result.diagnostics.length,
          diagnostics_preview: smartTruncate(
            diagnosticsPreview,
            MAX_FILE_PREVIEW_CHARS
          ),
        }),
        success: true,
      };
    }

    if (call.function.name === "fetch") {
      const url = asString(args.url).trim();
      if (!url) {
        const message = "url 不能为空";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }
      const maxSize = normalizeOptionalPositiveInt(args.max_size);
      const result = await invoke<{
        success: boolean;
        url: string;
        content_type: string | null;
        content: string;
        truncated: boolean;
        error: string | null;
      }>("fetch_url", {
        url,
        maxSize: maxSize || null,
        proxy: settings?.proxy ?? null,
      });

      if (!result.success) {
        const errorMsg = result.error || "请求失败";
        return {
          content: JSON.stringify({
            ok: false,
            url: result.url,
            error: errorMsg,
          }),
          success: false,
          errorCategory: "validation",
          errorMessage: errorMsg,
        };
      }

      return {
        content: JSON.stringify({
          ok: true,
          url: result.url,
          content_type: result.content_type,
          truncated: result.truncated,
          content_preview: smartTruncate(
            result.content,
            MAX_FILE_PREVIEW_CHARS
          ),
        }),
        success: true,
      };
    }

    if (call.function.name === "ask_user") {
      const question = asString(args.question).trim();
      if (!question) {
        const message = "question 不能为空";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }

      const context = asString(args.context).trim() || undefined;
      const options = Array.isArray(args.options)
        ? (args.options as string[]).map((opt) => String(opt).trim()).filter(Boolean)
        : undefined;
      const required = args.required !== undefined ? asBoolean(args.required, true) : true;

      if (!sessionId) {
        const message = "ask_user 工具需要 sessionId，当前调用缺少 session 上下文";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }

      const requestId = createAskUserRequest(
        sessionId,
        question,
        context,
        options,
        required
      );

      // Notify UI so it can show the dialog
      onAskUserRequest?.({
        id: requestId,
        sessionId,
        question,
        context,
        options,
        required,
        timestamp: new Date().toISOString(),
      });

      // Block tool loop until user responds (or cancels / signal aborts)
      let userResponse;
      try {
        userResponse = await waitForUserResponse(requestId, signal);
      } catch (_err) {
        return {
          content: JSON.stringify({
            ok: false,
            request_id: requestId,
            skipped: true,
            response: null,
            message: "用户取消了输入请求。",
          }),
          success: true,
        };
      }

      return {
        content: JSON.stringify({
          ok: true,
          request_id: requestId,
          question,
          response: userResponse.response || null,
          skipped: userResponse.skipped,
          options: options || null,
        }),
        success: true,
      };
    }

    return {
      content: JSON.stringify({
        error: `"${call.function.name}" is not a valid tool, try one of [${(enabledToolNames ?? ALL_TOOL_NAMES).join(", ")}].`,
      }),
      success: false,
      errorCategory: "tool_not_found",
      errorMessage: `未知工具: ${call.function.name}`,
    };
  } catch (error) {
    const message = String(error || "Unknown error");
    return {
      content: JSON.stringify({ error: message }),
      success: false,
      errorCategory: classifyToolError(message),
      errorMessage: message,
    };
  }
}

async function executeToolCallWithRetry(
  call: ToolCallRecord,
  workspacePath: string,
  toolPermissions: ToolPermissions = DEFAULT_TOOL_PERMISSIONS,
  settings?: AppSettings,
  projectConfig?: CofreeRcConfig,
  allowedSubAgents?: SubAgentRole[],
  enabledToolNames?: string[],
  planState?: TodoPlanState,
  workingMemory?: WorkingMemory,
  onSubAgentProgress?: (event: SubAgentProgressEvent) => void,
  signal?: AbortSignal,
  turn?: number,
  focusedPaths?: string[],
  sessionId?: string,
  onAskUserRequest?: (request: AskUserRequest) => void,
): Promise<{
  result: ToolExecutionResult;
  trace: ToolExecutionTrace;
}> {
  const startedAt = nowIso();
  let attempts = 0;
  let lastResult: ToolExecutionResult = {
    content: JSON.stringify({ error: "工具调用未执行" }),
    success: false,
    errorCategory: "unknown",
    errorMessage: "工具调用未执行",
  };

  while (attempts < MAX_TOOL_RETRY) {
    attempts += 1;

    // Apply exponential backoff delay between retry attempts
    if (attempts > 1) {
      const retryDelay = computeToolRetryDelay(attempts);
      console.log(
        `[ToolRetry] 工具 "${call.function.name}" 第 ${attempts} 次重试，延迟 ${Math.round(retryDelay)}ms`
      );
      await sleep(retryDelay, signal);
    }

    const current = await executeToolCall(
      call,
      workspacePath,
      toolPermissions,
      settings,
      projectConfig,
      allowedSubAgents,
      enabledToolNames,
      planState,
      workingMemory,
      onSubAgentProgress,
      signal,
      turn,
      focusedPaths,
      sessionId,
      onAskUserRequest,
    );
    const success = current.success !== false;
    const traceStatus: ToolExecutionStatus = success
      ? current.traceStatus ?? "success"
      : "failed";
    const errorCategory =
      current.errorCategory ?? (success ? undefined : "unknown");
    const errorMessage =
      current.errorMessage ?? (success ? undefined : "工具调用失败");
    lastResult = {
      ...current,
      success,
      errorCategory,
      errorMessage,
      traceStatus,
    };

    if (success) {
      return {
        result: lastResult,
        trace: {
          callId: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
          startedAt,
          finishedAt: nowIso(),
          attempts,
          status: traceStatus,
          retried: attempts > 1,
          resultPreview: resultPreview(current.content),
        },
      };
    }

    if (!shouldRetryToolCall(errorCategory ?? "unknown")) {
      break;
    }
  }

  // Append contextual error recovery hint to help the LLM self-correct
  const recoveryHint = buildToolErrorRecoveryHint(
    call.function.name,
    lastResult.errorCategory ?? "unknown",
    lastResult.errorMessage ?? "未知错误",
  );
  const enrichedContent = (() => {
    try {
      const parsed = JSON.parse(lastResult.content);
      parsed._recovery_hint = recoveryHint;
      return JSON.stringify(parsed);
    } catch {
      return JSON.stringify({
        error: lastResult.errorMessage ?? "工具调用失败",
        _recovery_hint: recoveryHint,
      });
    }
  })();

  return {
    result: {
      ...lastResult,
      content: enrichedContent,
    },
    trace: {
      callId: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
      startedAt,
      finishedAt: nowIso(),
      attempts,
      status: "failed",
      retried: attempts > 1,
      errorCategory: lastResult.errorCategory,
      errorMessage: lastResult.errorMessage,
      resultPreview: resultPreview(enrichedContent),
    },
  };
}

/* requestToolCompletion: Non-streaming variant (retained for local-only fallback) */
export async function requestToolCompletion(
  messages: LiteLLMMessage[],
  settings: AppSettings,
  activeTools: LiteLLMToolDefinition[],
  signal?: AbortSignal,
  toolChoiceOverride?: "auto" | "none",
  runtime?: ResolvedAgentRuntime | null,
): Promise<{
  assistantMessage: LiteLLMMessage;
  toolCalls: ToolCallRecord[];
  droppedToolCalls: number;
  requestRecord: RequestRecord;
}> {
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }

  const effectiveToolChoice = toolChoiceOverride ?? "model-adapted";
  const body = createGatewayRequestBody(messages, settings, runtime ?? null, {
    stream: false,
    temperature: 0.1,
    tools: effectiveToolChoice === "none" ? undefined : activeTools,
    toolChoice:
      toolChoiceOverride === undefined || toolChoiceOverride === "none"
        ? undefined
        : toolChoiceOverride,
  });
  const requestModel = typeof body.model === "string" ? body.model : settings.model;

  const t0 = performance.now();
  console.log(
    `[LLM] 发送请求 (非流式) | model=${requestModel} | messages=${messages.length} | tools=${activeTools.length} | toolChoice=${effectiveToolChoice}`
  );

  const response = await postLiteLLMChatCompletions(settings, body);
  const elapsed = ((performance.now() - t0) / 1000).toFixed(2);

  if (response.status < 200 || response.status >= 300) {
    console.warn(`[LLM] 请求失败 | status=${response.status} | ${elapsed}s`);
    const detail = parseErrorMessage(response.body, response.status);
    throw new Error(`服务员响应失败: ${detail}`);
  }

  const payload = parseCompletionPayload(response.body);
  const requestId =
    typeof payload.id === "string" && payload.id.trim()
      ? payload.id
      : createRequestId("chat");

  const firstChoice = payload.choices?.[0];
  const rawMessage = firstChoice?.message;
  if (!rawMessage) {
    throw new Error("模型响应缺少 message。");
  }

  const { parsed: toolCalls, droppedCount } = parseToolCalls(rawMessage.tool_calls);
  const assistantContent = buildAssistantDisplayContent(rawMessage);

  const inTok = payload.usage?.prompt_tokens;
  const outTok = payload.usage?.completion_tokens;
  console.log(
    `[LLM] 收到响应 | ${elapsed}s | toolCalls=${toolCalls.length}` +
    (droppedCount > 0 ? ` dropped=${droppedCount}` : "") +
    (inTok != null || outTok != null ? ` | in=${inTok ?? "?"} out=${outTok ?? "?"}` : "") +
    ` | id=${requestId}`
  );

  const assistantMessage: LiteLLMMessage = {
    role: "assistant",
    content: assistantContent,
    tool_calls: toolCalls.length ? toolCalls : undefined,
  };

  return {
    assistantMessage,
    toolCalls,
    droppedToolCalls: droppedCount,
    requestRecord: {
      requestId,
      inputLength: inputLengthOf(messages),
      outputLength: response.body.length,
      inputTokens: inTok ?? undefined,
      outputTokens: outTok ?? undefined,
    },
  };
}

async function requestToolCompletionWithStream(
  messages: LiteLLMMessage[],
  settings: AppSettings,
  activeTools: LiteLLMToolDefinition[],
  signal?: AbortSignal,
  onChunk?: (content: string) => void,
  onToolCallEvent?: (event: ToolCallEvent) => void,
  toolChoiceOverride?: "auto" | "none",
  runtime?: ResolvedAgentRuntime | null,
): Promise<{
  assistantMessage: LiteLLMMessage;
  toolCalls: ToolCallRecord[];
  droppedToolCalls: number;
  requestRecord: RequestRecord;
}> {
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }

  const effectiveToolChoice = toolChoiceOverride ?? "model-adapted";
  const body = createGatewayRequestBody(messages, settings, runtime ?? null, {
    stream: true,
    temperature: 0.1,
    tools: effectiveToolChoice === "none" ? undefined : activeTools,
    toolChoice:
      toolChoiceOverride === undefined || toolChoiceOverride === "none"
        ? undefined
        : toolChoiceOverride,
  });
  const requestModel = typeof body.model === "string" ? body.model : settings.model;

  const t0 = performance.now();
  console.log(
    `[LLM] 发送请求 (流式) | model=${requestModel} | messages=${messages.length} | tools=${activeTools.length} | toolChoice=${effectiveToolChoice}`
  );

  const response = await postLiteLLMChatCompletionsStream(
    settings,
    body,
    (content) => {
      onChunk?.(content);
    },
    (toolCall) => {
      onToolCallEvent?.({
        type: "start",
        callId: toolCall.callId,
        toolName: toolCall.toolName,
        argsPreview: summarizeToolArgs(toolCall.toolName, toolCall.arguments),
      });
    },
  );

  const elapsed = ((performance.now() - t0) / 1000).toFixed(2);

  if (response.status < 200 || response.status >= 300) {
    console.warn(`[LLM] 请求失败 | status=${response.status} | ${elapsed}s`);
    const detail = parseErrorMessage(response.body, response.status);
    throw new Error(`服务员响应失败: ${detail}`);
  }

  const payload = parseCompletionPayload(response.body);
  const requestId =
    typeof payload.id === "string" && payload.id.trim()
      ? payload.id
      : createRequestId("chat");

  const firstChoice = payload.choices?.[0];
  const rawMessage = firstChoice?.message;
  if (!rawMessage) {
    throw new Error("模型响应缺少 message。");
  }

  const { parsed: toolCalls, droppedCount } = parseToolCalls(rawMessage.tool_calls);
  const assistantContent = buildAssistantDisplayContent(rawMessage);

  const inTok = payload.usage?.prompt_tokens;
  const outTok = payload.usage?.completion_tokens;
  console.log(
    `[LLM] 收到响应 | ${elapsed}s | toolCalls=${toolCalls.length}` +
    (droppedCount > 0 ? ` dropped=${droppedCount}` : "") +
    (inTok != null || outTok != null ? ` | in=${inTok ?? "?"} out=${outTok ?? "?"}` : "") +
    ` | id=${requestId}`
  );

  if (!assistantContent.trim() && toolCalls.length === 0) {
    console.warn("[LLM] 流式响应未解析出文本或工具调用，触发非流式回退");
    throw new Error("stream returned empty assistant response");
  }

  const assistantMessage: LiteLLMMessage = {
    role: "assistant",
    content: assistantContent,
    tool_calls: toolCalls.length ? toolCalls : undefined,
  };

  return {
    assistantMessage,
    toolCalls,
    droppedToolCalls: droppedCount,
    requestRecord: {
      requestId,
      inputLength: inputLengthOf(messages),
      outputLength: response.body.length,
      inputTokens: inTok ?? undefined,
      outputTokens: outTok ?? undefined,
    },
  };
}

function hasPreviousAssistantToolCalls(messages: LiteLLMMessage[]): boolean {
  return messages.some(
    (message) => message.role === "assistant" && (message.tool_calls?.length ?? 0) > 0,
  );
}

function shouldFallbackToNonStreamingForToolTurn(error: unknown): boolean {
  const raw = error instanceof Error ? error.message : String(error);
  const normalized = raw.toLowerCase();

  // Gateway / server errors (streaming infrastructure failure)
  if (
    /(?:^|\D)(502|503|504)(?:\D|$)/.test(normalized) ||
    normalized.includes("bad gateway") ||
    normalized.includes("gateway") ||
    normalized.includes("server error") ||
    normalized.includes("upstream")
  ) {
    return true;
  }

  // JSON parse errors from streamed response assembly
  if (
    normalized.includes("json") ||
    normalized.includes("unexpected token") ||
    normalized.includes("unexpected end") ||
    normalized.includes("不是有效 json") ||
    normalized.includes("模型响应不是有效") ||
    normalized.includes("invalid json")
  ) {
    return true;
  }

  // Stream-specific errors
  if (
    normalized.includes("stream") ||
    normalized.includes("sse") ||
    normalized.includes("event source") ||
    normalized.includes("chunk") ||
    normalized.includes("incomplete")
  ) {
    return true;
  }

  // Missing message in response (can happen when streaming drops data)
  if (
    normalized.includes("缺少 message") ||
    normalized.includes("missing message") ||
    normalized.includes("模型响应缺少")
  ) {
    return true;
  }

  return false;
}

async function executeToolCompletionForTurn(
  messages: LiteLLMMessage[],
  settings: AppSettings,
  runtime: ResolvedAgentRuntime,
  activeTools: LiteLLMToolDefinition[],
  turn: number,
  signal?: AbortSignal,
  onChunk?: (content: string) => void,
  onToolCallEvent?: (event: ToolCallEvent) => void,
  toolChoiceOverride?: "auto" | "none",
): Promise<{
  completion: {
    assistantMessage: LiteLLMMessage;
    toolCalls: ToolCallRecord[];
    droppedToolCalls: number;
    requestRecord: RequestRecord;
  };
  requestMode: "stream" | "nonstream";
  highRisk: boolean;
  highRiskReasons: string[];
  fallbackTriggered: boolean;
}> {
  // Collect risk signals for logging, but always prefer streaming.
  // Streaming is more resilient to gateway timeouts (no need to wait for
  // the full response body) and provides a better UX with incremental output.
  const highRiskReasons: string[] = [];
  if (hasPreviousAssistantToolCalls(messages)) {
    highRiskReasons.push("previous_assistant_tool_calls");
  }
  if (isHighRiskToolCallingModelCombo(settings)) {
    highRiskReasons.push("anthropic_openai_chat_compat");
  }
  const highRisk = highRiskReasons.length > 0;
  // Always prefer streaming; fall back to non-streaming only on failure.
  const requestMode: "stream" | "nonstream" = "stream";

  console.log(
    `[Loop][Mode] turn=${turn + 1} | mode=${requestMode} | highRisk=${highRisk}` +
    ` | reasons=${highRiskReasons.length ? highRiskReasons.join(",") : "none"}`,
  );

  try {
    const completion = await requestToolCompletionWithStream(
      messages,
      settings,
      activeTools,
      signal,
      onChunk,
      onToolCallEvent,
      toolChoiceOverride,
      runtime,
    );
    return {
      completion,
      requestMode,
      highRisk,
      highRiskReasons,
      fallbackTriggered: false,
    };
  } catch (error) {
    if (!shouldFallbackToNonStreamingForToolTurn(error)) {
      throw error;
    }
    console.warn(
      `[Loop][Fallback] turn=${turn + 1} | from=stream | to=nonstream | reason=${error instanceof Error ? error.message : String(error)}`,
    );
    const completion = await requestToolCompletion(
      messages,
      settings,
      activeTools,
      signal,
      toolChoiceOverride,
      runtime,
    );
    return {
      completion,
      requestMode: "nonstream",
      highRisk,
      highRiskReasons,
      fallbackTriggered: true,
    };
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
  onSubAgentProgress?: (role: string, event: SubAgentProgressEvent) => void,
  onLoopCheckpoint?: RunPlanningSessionInput["onLoopCheckpoint"],
  onPlanStateUpdate?: RunPlanningSessionInput["onPlanStateUpdate"],
  focusedPaths: string[] = [],
  sessionId?: string,
  onAskUserRequest?: (request: AskUserRequest) => void,
): Promise<{
  assistantReply: string;
  requestRecords: RequestRecord[];
  proposedActions: ActionProposal[];
  planState: TodoPlanState;
  toolTrace: ToolExecutionTrace[];
  assistantToolCalls?: LiteLLMMessage["tool_calls"];
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
  const patchRepairInstruction =
    "请读取必要文件片段后，仅针对一个文件重新调用 propose_file_edit；不要再次提交多文件 raw patch。";
  const createPathRepairInstruction =
    "若目标是新建文件，请调用 propose_file_edit 并设置 operation='create'；若目录不存在，可先调用 propose_shell 创建目录。Windows/PowerShell 下使用 New-Item -ItemType Directory -Force <目录>；Unix 下可用 mkdir -p <目录>。";
  const searchNotFoundRepairInstruction =
    "search/anchor 片段在完整文件中未匹配到（search 必须精确匹配文件内容）。这通常是因为文件较大、read_file 返回的内容被截断，你基于截断视图构造的 search 片段与实际文件内容不一致。" +
    "\n请改用以下策略之一：" +
    "\n1. 使用 start_line/end_line 行号范围方式编辑（推荐）：先用 read_file 的 start_line/end_line 参数读取目标区域的精确内容，再用 propose_file_edit 的 start_line/end_line 参数做行范围替换。" +
    "\n2. 缩短 search 片段：只使用你确定在文件中唯一存在的短片段（1-3 行），避免包含可能被截断的长段落。" +
    "\n3. 先用 read_file 分段读取目标区域获取精确内容，再构造精确匹配的 search 片段。" +
    "\n注意：search 中不要包含行号前缀（如 '  10│'），这些仅用于显示。";
  const taskType = classifyTaskType(prompt);
  const agentSystemPrompt = assembleSystemPrompt(runtime, taskType);
  const effectiveRuntimeContext = assembleRuntimeContext(runtime, settings.workspacePath, INTERNAL_TOOL_NAMES);
  const requestedArtifactCount =
    phase === "default" ? estimateRequestedArtifactCount(prompt) : 0;
  const blockedFingerprints = blockedActionFingerprints
    .map((value) => value.trim())
    .filter(Boolean);

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
  const MAX_SAME_FILE_EDIT_FAILURES = 4;
  let consecutiveReadOnlyTurns = 0;
  let toolChoiceOverride: "auto" | "none" | undefined = undefined;
  let lastWorkingMemoryFingerprint = "";

  // --- Workspace context refresh tracking ---
  let hasModifiedFiles = false; // Track if files have been edited/created
  let lastWorkspaceRefreshTurn = -1; // Last turn when workspace context was refreshed

  // --- Context window management ---
  const limitTokens = settings.maxContextTokens > 0 ? settings.maxContextTokens : 128000;

  // --- Shared Working Memory for multi-agent collaboration ---
  const workingMemory = createWorkingMemory({
    maxTokenBudget: Math.floor(
      Math.max(0, limitTokens - Math.min(8000, Math.max(512, Math.floor(limitTokens * 0.15)))) * 0.9 * 0.2
    ),
    projectContext: internalSystemNote?.slice(0, 500) ?? "",
  });
  const outputBufferTokens = Math.min(
    8000,
    Math.max(512, Math.floor(limitTokens * 0.15))
  );
  const hardPromptBudget = Math.max(0, limitTokens - outputBufferTokens);
  const softPromptBudget = Math.floor(hardPromptBudget * 0.9);
  const promptBudgetTarget = softPromptBudget > 0 ? softPromptBudget : hardPromptBudget;

  // P0-2: Pre-compute tool definition overhead and pass to compression policy.
  const toolDefTokens = estimateTokensForToolDefinitions(activeTools);
  console.log(`[Loop] 工具定义 token 开销: ~${toolDefTokens} tokens (${activeTools.length} tools)`);

  // Incremental token tracker — avoids re-scanning all messages on every call.
  const tokenTracker = new MessageTokenTracker();

  const compressionPolicy = {
    maxPromptTokens: promptBudgetTarget,
    minMessagesToSummarize: MIN_MESSAGES_TO_SUMMARIZE,
    minRecentMessagesToKeep: MIN_RECENT_MESSAGES_TO_KEEP,
    recentTokensMinRatio: RECENT_TOKENS_MIN_RATIO,
    toolMessageMaxChars: TOOL_MESSAGE_MAX_CHARS,
    mergeToolMessages: true,
    toolDefinitionTokens: toolDefTokens,
  };

  const summarizer = {
    canSummarize: () => {
      const estTokens = tokenTracker.update(messages);
      return canSummarizeNow(settings.workspacePath, estTokens);
    },
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
      };
    }

    // --- 任务类型轮次预算 ---
    const taskTypeTurnLimit = TASK_TYPE_TURN_LIMITS[taskType] ?? MAX_ABSOLUTE_TURNS;
    if (turn >= taskTypeTurnLimit && taskTypeTurnLimit < MAX_ABSOLUTE_TURNS) {
      console.log(`[Loop] 任务类型 "${taskType}" 达到轮次预算 (${taskTypeTurnLimit})，强制总结`);
      messages.push({
        role: "system",
        content: `你已达到当前任务类型（${taskType}）的工具调用预算（${taskTypeTurnLimit} 轮）。请立即基于已收集的所有信息给出完整的总结性回答。不要再调用任何工具。`,
      });
      toolChoiceOverride = "none";
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
          hasModifiedFiles && (turn - lastWorkspaceRefreshTurn) >= 3; // Min 3 turns between refreshes

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

    const estTokens = tokenTracker.update(messages);
    console.log(`[Loop] ── Turn ${turn + 1} ── messages=${messages.length} | ~${estTokens} tokens`);

    // Inject task progress summary every 5 turns or when failures accumulate
    const failedCount = workingMemory.taskProgress.filter((e) => e.status === "failed").length;
    if (turn > 0 && (turn % 5 === 0 || failedCount >= 3)) {
      const progressBlock = formatTaskProgressBlock(workingMemory);
      if (progressBlock) {
        messages.push({
          role: "system",
          content: progressBlock,
        });
      }
    }

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

    // --- Context Editing: 主动淘汰旧 tool-use 对 ---
    const shouldEditByTurns = CONTEXT_EDIT_TRIGGER_EVERY_N_TURNS > 0
      && turn > 0 && turn % CONTEXT_EDIT_TRIGGER_EVERY_N_TURNS === 0;
    const shouldEditByTokens = estTokens > promptBudgetTarget * CONTEXT_EDIT_TRIGGER_TOKEN_RATIO;

    if (shouldEditByTurns || shouldEditByTokens) {
      const editResult = clearOldToolUses(messages, {
        keepRecentTurns: CONTEXT_EDIT_KEEP_RECENT_TURNS,
        clearAtLeast: CONTEXT_EDIT_CLEAR_AT_LEAST,
        pinnedPrefixLen,
      });
      if (editResult.cleared) {
        messages.splice(0, messages.length, ...editResult.messages);
        tokenTracker.invalidate();
        console.log(
          `[Loop] Context Editing: 清除 ${editResult.pairsRemoved} 个旧 tool-use 轮次 | ` +
          `释放 ~${editResult.tokensFreed} tokens | 剩余 ${messages.length} messages`
        );
      }
    }

    // 现有的 compression pipeline 继续执行
    const compression = await compressMessagesToFitBudget({
      messages,
      policy: compressionPolicy,
      summarizer,
      pinnedPrefixLen,
    });
    if (compression.compressed && compression.messages !== messages) {
      const beforeLen = messages.length;
      messages.splice(0, messages.length, ...compression.messages);
      tokenTracker.invalidate();
      const afterTokens = tokenTracker.update(messages);
      console.log(
        `[Loop] 上下文压缩: ${beforeLen} → ${messages.length} messages | ~${afterTokens} tokens`
      );
    }
    if (compression.compressed && workingMemory.fileKnowledge.size > 0) {
      const knownFiles = [...workingMemory.fileKnowledge.entries()]
        .sort((a, b) => (b[1].lastReadTurn ?? 0) - (a[1].lastReadTurn ?? 0))
        .slice(0, 30)
        .map(([path, fk]) => `- ${path} (${fk.totalLines}行, ${fk.language ?? "?"}): ${fk.summary}`)
        .join("\n");

      messages.push({
        role: "system",
        content: [
          "上下文已压缩。以下是你在本次会话中已读取过的文件清单，无需重复读取：",
          knownFiles,
          "如需特定文件的详细内容，请使用 start_line/end_line 精确读取目标区域，而非重新全文读取。",
        ].join("\n"),
      });
    }    onContextUpdate?.(tokenTracker.update(messages));

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
            `[Loop][ModeResult] turn=${turn + 1} | mode=${turnRequest.requestMode} | highRisk=${turnRequest.highRisk} | fallback=${turnRequest.fallbackTriggered}` +
            (llmRetryAttempt > 0 ? ` | retryAttempt=${llmRetryAttempt}` : "") +
            ` | reasons=${turnRequest.highRiskReasons.length ? turnRequest.highRiskReasons.join(",") : "none"}`,
          );
          break;
        } catch (error) {
          lastLLMError = error;
          const currentTokens = tokenTracker.update(messages);
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
          console.log(`[Loop][Retry] 等待 ${Math.round(delay)}ms 后重试 (attempt ${llmRetryAttempt + 2}/${MAX_LLM_REQUEST_RETRIES})`);
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
      const estBeforeCall = tokenTracker.update(messages) + toolDefTokens;
      updateTokenCalibration(estBeforeCall, completion.requestRecord.inputTokens, settings.model);
    }

    if (!completion.toolCalls.length) {
      if (completion.droppedToolCalls > 0) {
        console.warn(`[Loop] Turn ${turn + 1}: ${completion.droppedToolCalls} 个工具调用因格式畸形被丢弃，要求模型重试`);
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
        ? detectPseudoToolCallNarration(
          completion.assistantMessage.content,
          enabledToolNames,
        )
        : null;
      if (
        pseudoToolCallReason &&
        pseudoToolCallRepairRounds < MAX_PSEUDO_TOOL_CALL_REPAIR_ROUNDS
      ) {
        pseudoToolCallRepairRounds += 1;
        console.warn(
          `[Loop] Turn ${turn + 1}: detected pseudo tool-call narration without native tool_calls (${pseudoToolCallReason}), requesting retry`,
        );
        messages.push({
          role: "system",
          content: [
            "系统提示：你刚才在普通文本里描述了“将调用工具/准备调用工具”，但并没有发送原生 tool_calls，所以系统无法执行。",
            `本轮可用工具: [${enabledToolNames.join(", ")}]`,
            "如果需要继续使用工具，请直接发送原生工具调用，不要输出任何类似“我将调用 read_file / let's call ... / tool call now”的描述文本。",
            "如果任务其实已经完成且不需要工具，请直接给出最终答案。",
          ].join("\n"),
        });
        continue;
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
      };
    }

    const toolNames = completion.toolCalls.map((tc) => tc.function.name);
    console.log(
      `[Loop] Turn ${turn + 1} 收到 ${completion.toolCalls.length} 个工具调用: [${toolNames.join(", ")}]`
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

      // Build role-scoped progress callback for sub-agent tasks
      let progressForCall: ((event: SubAgentProgressEvent) => void) | undefined;
      if (onSubAgentProgress && toolCall.function.name === "task") {
        try {
          const taskArgs = JSON.parse(toolCall.function.arguments || "{}");
          const taskRole = String(taskArgs.role ?? "unknown");
          progressForCall = (event: SubAgentProgressEvent) => onSubAgentProgress(taskRole, event);
        } catch {
          // Ignore parse errors
        }
      }

      const toolT0 = performance.now();
      const { result: toolResult, trace } = await executeToolCallWithRetry(
        toolCall,
        settings.workspacePath,
        toolPermissions,
        settings,
        projectConfig,
        runtime.allowedSubAgents,
        enabledToolNames,
        planState,
        workingMemory,
        progressForCall,
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

      // Record task progress for propose_* tools (always) and read tools (on failure only)
      const toolName = toolCall.function.name;
      const isProposeTool = toolName.startsWith("propose_");
      const isReadTool = ["read_file", "grep", "glob", "list_files", "git_status", "git_diff"].includes(toolName);
      if (isProposeTool || (isReadTool && toolResult.success === false)) {
        try {
          const parsedArgs = JSON.parse(toolCall.function.arguments || "{}");
          recordTaskProgress(workingMemory, {
            description: isProposeTool
              ? `${toolName}(${parsedArgs.relative_path || parsedArgs.shell || ""})`
              : `${toolName} failed`,
            toolName,
            targetFile: parsedArgs.relative_path || parsedArgs.path || undefined,
            status: toolResult.success === false ? "failed" : "completed",
            turnNumber: turn,
            errorHint: toolResult.success === false ? toolResult.errorMessage?.slice(0, 100) : undefined,
          });
        } catch {
          // Ignore parse errors for progress recording
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
      if (toolResult.proposedAction) {
        const linkedAction = attachActionToPlanStep(planState, toolResult.proposedAction);
        proposedActions.push(linkedAction);
      }
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        name: toolCall.function.name,
        content: trimToolContentForContext(
          toolCall.function.name,
          toolResult.content
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
    ]);
    const MAX_PARALLEL_READ_TOOLS = 5;

    const taskCalls = completion.toolCalls.filter((tc) => tc.function.name === "task");
    const readOnlyCalls = completion.toolCalls.filter(
      (tc) => tc.function.name !== "task" && PARALLEL_SAFE_TOOL_NAMES.has(tc.function.name),
    );
    const mutationCalls = completion.toolCalls.filter(
      (tc) => tc.function.name !== "task" && !PARALLEL_SAFE_TOOL_NAMES.has(tc.function.name),
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

    // 3. Execute task calls in parallel (with concurrency limit)
    if (taskCalls.length > 1) {
      console.log(`[Orchestrator] 并行执行 ${taskCalls.length} 个 Sub-Agent 任务`);
      const parallelResults = await runWithConcurrencyLimit(
        taskCalls.map((tc) => () => executeSingleToolCall(tc)),
        MAX_PARALLEL_SUB_AGENTS,
      );
      for (const settled of parallelResults) {
        if (settled.status === "fulfilled") {
          const { toolCall, toolResult, trace } = settled.value;
          processToolResult(toolCall, toolResult, trace);
          if (toolResult.proposedAction) {
            planMutatedThisTurn = true;
          }
        } else {
          console.error(`[Orchestrator] 并行 Sub-Agent 执行异常:`, settled.reason);
        }
      }
    } else if (taskCalls.length === 1) {
      const { toolCall, toolResult, trace } = await executeSingleToolCall(taskCalls[0]);
      processToolResult(toolCall, toolResult, trace);
      if (toolResult.proposedAction) {
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
    const postToolTokens = tokenTracker.update(messages);
    onContextUpdate?.(postToolTokens);

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

    if (consecutiveReadOnlyTurns >= MAX_CONSECUTIVE_READ_ONLY_TURNS) {
      console.log(`[Loop] 连续 ${consecutiveReadOnlyTurns} 轮纯读取，强制要求总结`);
      messages.push({
        role: "system",
        content: [
          `系统警告：你已连续 ${consecutiveReadOnlyTurns} 轮只在读取文件而没有给出任何回复或提出动作。`,
          "请立即基于已收集的信息给出回答。如果信息不足以完成任务，请说明已了解的内容和还需要什么信息，而不是继续读取更多文件。",
        ].join("\n"),
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
    if (toolNotFoundStrikes >= MAX_TOOL_NOT_FOUND_STRIKES) {
      console.warn(`[Loop] 熔断: tool_not_found 连续 ${toolNotFoundStrikes} 轮，终止循环`);
      return {
        assistantReply:
          "模型多次调用不存在的工具，已自动终止。请检查模型能力或切换至更强的模型。",
        requestRecords,
        proposedActions,
        planState,
        toolTrace,
      };
    }
    if (toolNotFoundStrikes > 0 && toolNotFoundStrikes < MAX_TOOL_NOT_FOUND_STRIKES) {
      messages.push({
        role: "system",
        content: [
          `系统提示：你调用了不存在的工具（连续 ${toolNotFoundStrikes} 轮）。`,
          `你只能使用以下工具: [${enabledToolNames.join(", ")}]`,
          "请严格从上述列表中选择工具，不要臆造工具名称。",
        ].join("\n"),
      });
    }

    // --- Circuit breaker: consecutive all-failure turns ---
    if (turnSuccessCount === 0 && turnFailureCount > 0) {
      consecutiveFailureTurns += 1;
    } else {
      consecutiveFailureTurns = 0;
    }
    if (consecutiveFailureTurns >= MAX_CONSECUTIVE_FAILURE_TURNS) {
      console.warn(`[Loop] 熔断: 连续 ${consecutiveFailureTurns} 轮全部失败，终止循环`);
      return {
        assistantReply:
          "连续多轮工具调用全部失败，已自动终止。请检查工具参数或任务描述后重试。",
        requestRecords,
        proposedActions,
        planState,
        toolTrace,
      };
    }

    // --- Circuit breaker: same-file consecutive edit failures ---
    for (const [filePath, failCount] of fileEditFailureTracker) {
      if (failCount >= MAX_SAME_FILE_EDIT_FAILURES) {
        console.warn(`[Loop] 熔断: 文件 ${filePath} 连续编辑失败 ${failCount} 次`);
        messages.push({
          role: "system",
          content: [
            `系统提示：对文件 "${filePath}" 的编辑已连续失败 ${failCount} 次，继续重试不太可能成功。`,
            "请放弃 search/replace 方式，改用以下方案之一：",
            "1. 使用 read_file 的 start_line/end_line 精确读取目标区域，然后用 propose_file_edit 的 start_line/end_line 做行范围替换。",
            "2. 如果编辑内容较多，考虑用 operation='create' + overwrite=true 重写整个文件。",
            "3. 将大编辑拆分为多个小编辑，每次只修改一小段。",
          ].join("\n"),
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
        content: [
          "系统提示：上一轮 patch 预检失败。",
          `错误信息：${patchPreflightFailure}`,
          patchRepairInstruction,
          "仅允许一次自动修复重试，并保持最小改动。",
        ].join("\n"),
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
        content: [
          "系统提示：检测到文件创建路径问题。",
          `错误信息：${createPathUsageFailure}`,
          createPathRepairInstruction,
        ].join("\n"),
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
        content: [
          "系统提示：文件编辑失败 — search/anchor 片段在文件中未匹配。",
          `错误信息：${searchNotFoundFailure}`,
          searchNotFoundRepairInstruction,
        ].join("\n"),
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

function inferStepOwnerFromPlannerTask(task: PlannerOutput["tasks"][number]): PlanStep["owner"] {
  const corpus = `${task.title} ${task.description}`.toLowerCase();
  if (/(test|verify|validation|验证|回归|检查)/.test(corpus)) {
    return "tester";
  }
  if (/(review|audit|审查)/.test(corpus)) {
    return "reviewer";
  }
  if (/(debug|diagnose|排查|调试)/.test(corpus)) {
    return "debugger";
  }
  if (/(analy|plan|investig|梳理|分析|确认)/.test(corpus)) {
    return "planner";
  }
  return "coder";
}

function mapPlannerTasksToPlanSeed(
  plannerOutput: PlannerOutput,
): InitialPlanSeed | null {
  if (!plannerOutput.tasks.length) {
    return null;
  }

  const titleToId = new Map<string, string>();
  const stepMeta = plannerOutput.tasks.map((task, index) => {
    const title = sanitizeStepTitle(task.title, task.description || `步骤 ${index + 1}`);
    const id = `step-${index + 1}-${hashText(title).slice(0, 6)}`;
    titleToId.set(task.title.trim().toLowerCase(), id);
    return { task, index, title, id };
  });

  const rawSteps = stepMeta.map(({ task, index, title, id }) => {
    const summaryParts = [task.description.trim() || title];
    if (task.targetFiles.length > 0) {
      summaryParts.push(`目标文件: ${task.targetFiles.join(", ")}`);
    }
    return {
      id,
      title,
      summary: summaryParts.join("\n"),
      owner: inferStepOwnerFromPlannerTask(task),
      status: index === 0 ? "in_progress" as const : "pending" as const,
      dependsOn: task.dependencies
        ?.map((dep) => titleToId.get(dep.trim().toLowerCase()) ?? null)
        .filter((dep): dep is string => Boolean(dep)),
    };
  });

  return {
    ...normalizeTodoPlanState({
      steps: rawSteps,
      activeStepId: rawSteps[0]?.id,
    }),
    source: "planner",
  };
}

function shouldUseTodoPlanning(
  prompt: string,
  taskType: ReturnType<typeof classifyTaskType>,
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
  if (taskType === "code_edit" || taskType === "mixed") {
    return normalized.length >= 50;
  }
  return false;
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
  // Only when the same round produces 2+ patch actions, we assign a shared groupId.
  const patchActions = uniqueActions.filter(
    (a): a is import("./types").ApplyPatchActionProposal =>
      a.type === "apply_patch"
  );
  if (patchActions.length > 1) {
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
  return `${action.type}:${normalizedShell}:${action.payload.timeoutMs}`;
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
}): string {
  const { assistantReply, proposedActions, toolTrace, assistantToolCalls } = params;
  const normalized = assistantReply.trim();
  const hasAssistantToolCalls = (assistantToolCalls?.length ?? 0) > 0;
  const hasPendingApprovalToolCall = hasPendingApprovalTrace(toolTrace);

  if (!normalized) {
    if (hasAssistantToolCalls) {
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
    if (hasAssistantToolCalls) {
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

  if (hasAssistantToolCalls) {
    return "模型已请求工具调用，请查看下方工具调用详情。";
  }

  return normalized;
}

export const planningServiceTestUtils = {
  executeToolCall,
  buildProposedActions,
  reconcileAssistantReply,
  summarizeToolArgs,
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
        const contextLimit = input.settings.maxContextTokens > 0 ? input.settings.maxContextTokens : 128000;
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
    const taskType = classifyTaskType(normalizedPrompt);
    const requestedArtifactCount = estimateRequestedArtifactCount(normalizedPrompt);
    if (shouldUseTodoPlanning(normalizedPrompt, taskType, requestedArtifactCount)) {
      initialPlanSeed = {
        ...normalizeTodoPlanState({
          steps: sanitizeStepsFromPrompt(normalizedPrompt),
          activeStepId: "step-plan",
        }),
        source: "fallback",
      };
      try {
        const plannerMemory = createWorkingMemory({
          maxTokenBudget: 4000,
          projectContext: initialInternalNote?.slice(0, 1200) ?? "",
        });
        const plannerDescription = [
          "请先将下面的用户任务拆解为一个可执行的 todo 列表。",
          `用户请求：${normalizedPrompt}`,
          initialInternalNote?.trim()
            ? `补充上下文：\n${initialInternalNote.trim().slice(0, 1500)}`
            : "",
          "要求：步骤必须可执行、粒度适中、顺序清晰；若有验证步骤请显式列出。",
        ].filter(Boolean).join("\n\n");

        const plannerResult = await executeSubAgentTask(
          "planner",
          plannerDescription,
          input.settings.workspacePath,
          input.settings,
          DEFAULT_TOOL_PERMISSIONS,
          plannerMemory,
          undefined,
          input.signal,
          sessionFocusedPaths,
          projectConfig,
        );

        if (plannerResult.structuredOutput?.role === "planner") {
          const plannerSeed = mapPlannerTasksToPlanSeed(plannerResult.structuredOutput.data);
          if (plannerSeed) {
            initialPlanSeed = plannerSeed;
          }
        }
      } catch (error) {
        console.warn("Failed to bootstrap planner todo list", error);
      }
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
      input.onSubAgentProgress,
      input.onLoopCheckpoint,
      input.onPlanStateUpdate,
      sessionFocusedPaths,
      input.sessionId,
      input.onAskUserRequest,
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
    });

    return {
      assistantReply,
      plan,
      toolTrace: loopResult.toolTrace,
      assistantToolCalls,
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
    
    const fallbackPlan = initializePlan(
      normalizedPrompt,
      input.settings,
      [],
      initialPlanSeed,
    );
    return {
      assistantReply: `服务员暂时无法完成本轮工具调用，请稍后重试。

**错误信息**：
${errorMessage}

**调试信息**（请复制以下内容用于排查）：
\`\`\`
模型: ${modelName}
协议: ${protocol}
端点: ${baseUrl}
时间: ${new Date().toISOString()}
\`\`\`

💡 **排查建议**：
1. 检查控制台（开发者工具）中的 [LLM][Error] 日志，查看完整的请求详情
2. 确认网络连接正常，可以访问 ${baseUrl}
3. 检查 API Key 是否有效
4. 如果使用代理，确认代理配置正确`,
      plan: fallbackPlan,
      toolTrace: [],
      assistantToolCalls: undefined,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}
