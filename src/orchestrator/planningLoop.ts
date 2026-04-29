import {
  type LiteLLMMessage,
} from "../lib/piAiBridge";
import {
  DEFAULT_TOOL_PERMISSIONS,
  resolveEffectiveContextTokenLimit,
  type AppSettings,
  type ToolPermissions,
} from "../lib/settingsStore";
import type { ResolvedAgentRuntime } from "../agents/types";
import type { CofreeRcConfig } from "../lib/cofreerc";
import { runWithConcurrencyLimit } from "../lib/concurrency";
import {
  compressMessagesToFitBudget,
  estimateTokensForMessages,
  estimateTokensForToolDefinitions,
  initialSystemPrefixLength,
} from "./contextBudget";
import {
  MIN_MESSAGES_TO_SUMMARIZE,
  COMPRESSION_PARAMS,
  computeMaxToolOutputChars,
} from "./contextPolicy";
import { executeToolCompletionForTurn, type RequestRecord, type ToolCallRecord } from "./llmToolLoop";
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
import type { ToolExecutionTrace } from "./toolTraceTypes";
import {
  extractFileKnowledge,
  invalidateFileContent,
  setFileContent,
  snapshotWorkingMemory,
  type WorkingMemory,
  type WorkingMemorySnapshot,
} from "./workingMemory";
import { initWorkingMemoryForLoop, maybeEmitIncrementalCheckpoint } from "./checkpointBridge";
import {
  buildWorkingMemoryContent,
  dedupeStaleFileReads,
} from "./loopPromptScaffolding";
import { requestSummary } from "./summarization";
import type { AskUserRequest } from "./askUserService";
import { buildAgentToolDefs, INTERNAL_TOOL_NAMES } from "./toolRegistry";
import {
  actionFingerprint,
  countPlannedArtifacts,
  estimateRequestedArtifactCount,
} from "./planningCore";
import type { PlanningSessionPhase, RunPlanningSessionInput, ToolCallEvent } from "./planningSessionTypes";
import {
  attachActionToPlanStep,
  clonePlanState,
  normalizeTodoPlanState,
  type TodoPlanState,
} from "./todoPlanState";
import { resolveMatchedSkills } from "./skillMatching";
import { resolveMatchedSnippets } from "./snippetMatching";
import { assembleRuntimeContext, assembleSystemPrompt } from "../agents/promptAssembly";
import type { ActionProposal } from "./types";

const TOOL_LOOP_CHECKPOINT_TURNS = 50;
const TOOL_LOOP_EFFICIENCY_WARNING_THRESHOLD = 40;
const MAX_MULTI_ARTIFACT_REMINDER_ROUNDS = 2;
const MAX_PROPOSED_ACTIONS_PER_BATCH = 5;
const MAX_LLM_REQUEST_RETRIES = 3;
const LLM_RETRY_BASE_DELAY_MS = 1000;
const LLM_RETRY_MAX_DELAY_MS = 15000;
const MAX_ABSOLUTE_TURNS = 150;
const WORKING_MEMORY_REFRESH_INTERVAL = 6;
const TOOL_CALLING_REINFORCEMENT_INTERVAL = 20;
const TOOL_CALLING_REINFORCEMENT_NOTE_PREFIX = "[工具调用提醒]";
const PARALLEL_SAFE_TOOL_NAMES = new Set([
  "read_file", "grep", "glob", "list_files",
  "git_status", "git_diff", "diagnostics",
  "web_search", "web_fetch",
  "check_shell_job",
]);
const MAX_PARALLEL_READ_TOOLS = 15;


// ---------------------------------------------------------------------------
// Context note buffer: collects "notes" for the model during a turn and
// injects them into the message stream in a cache-friendly way.
//
// Instead of pushing `role: "system"` messages (which become `[System]`
// user messages and break prefix cache), we collect notes and embed them
// into the last tool result message before the next LLM call.
// ---------------------------------------------------------------------------

class ContextNoteBuffer {
  private notes: string[] = [];

  push(note: string): void {
    const trimmed = note.trim();
    if (trimmed) {
      this.notes.push(trimmed);
    }
  }

  get hasNotes(): boolean {
    return this.notes.length > 0;
  }

  /**
   * Flush notes into the message stream. Appends to the last tool result's
   * content (as a JSON field), or falls back to a user message.
   */
  flush(messages: LiteLLMMessage[]): void {
    if (this.notes.length === 0) return;

    const combined = this.notes.join("\n\n");
    this.notes = [];

    // Try to append to the last tool result message.
    // This keeps the message count and sequence stable for prefix cache.
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "tool") {
        // Attempt to inject as a JSON field in the tool result.
        try {
          const parsed = JSON.parse(msg.content);
          if (parsed && typeof parsed === "object") {
            parsed._context_note = combined;
            msg.content = JSON.stringify(parsed);
            return;
          }
        } catch {
          // Not JSON — fall through to text append.
        }
        // Plain-text tool result: append note.
        msg.content = msg.content + "\n\n" + combined;
        return;
      }
      // Non-tool message at tail — keep scanning backwards past pinned slots etc.
    }
    messages.push({ role: "user", content: `[Context] ${combined}` });
  }
}

export interface NativeToolLoopResult {
  assistantReply: string;
  requestRecords: RequestRecord[];
  proposedActions: ActionProposal[];
  planState: TodoPlanState;
  toolTrace: ToolExecutionTrace[];
  assistantToolCalls?: LiteLLMMessage["tool_calls"];
  assistantToolCallsFromFinalTurn?: boolean;
  /**
   * Slice of the internal `messages` array containing every entry appended
   * during the loop body (intermediate assistant tool_calls, tool results, and
   * the final assistant message if one was produced). The caller is expected
   * to drop the trailing assistant when it duplicates `assistantReply`.
   */
  loopMessages: LiteLLMMessage[];
  workingMemorySnapshot?: WorkingMemorySnapshot;
}

function computeWorkingMemoryFingerprint(wm: WorkingMemory): string {
  return `${wm.fileKnowledge.size}`;
}

function truncateAtLineEnd(content: string, maxIndex: number): number {
  if (maxIndex >= content.length) return content.length;
  const lastNewline = content.lastIndexOf("\n", maxIndex);
  return lastNewline >= 0 ? lastNewline + 1 : maxIndex;
}

/**
 * Tail-cut truncation: keep the head, drop the tail. The marker reports total
 * size + dropped size so the LLM can decide whether to re-query the missing
 * portion via read_file (with a line range) or grep (with a narrower pattern).
 *
 * Replaced the previous head+tail-50% strategy because real tool outputs
 * (read_file / grep / list_files) almost always have head-anchored semantics:
 * the relevant content is at the start, pagination units are "first N items",
 * and head/tail concatenation rarely matches anything sensible.
 */
function smartTruncate(content: string, maxLength: number): string {
  if (typeof content !== "string") {
    content = String(content);
  }
  if (content.length <= maxLength) return content;

  const droppedChars = content.length - maxLength;
  const totalLines = (content.match(/\n/g)?.length ?? 0) + 1;
  const marker =
    `\n\n[已截断尾部 ${droppedChars} 字符 / 原文 ${content.length} 字符 / 总 ${totalLines} 行；` +
    `如需后续内容请用 read_file 指定行号或 grep 缩小范围再读]`;

  const headTarget = Math.max(0, maxLength - marker.length);
  if (headTarget <= 0) {
    // Marker alone exceeds budget — fall back to a plain head slice.
    return content.slice(0, maxLength);
  }
  const headEnd = truncateAtLineEnd(content, headTarget);
  return content.slice(0, headEnd) + marker;
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
  if (lower.includes("429") || lower.includes("rate limit") || lower.includes("too many requests")) {
    return true;
  }
  if (/(?:^|\D)(500|502|503|504)(?:\D|$)/.test(lower)) {
    return true;
  }
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

const toolExecutorDeps: ToolExecutorDeps = {
  createActionId,
  nowIso,
  actionFingerprint,
  smartTruncate,
};

export async function executeToolCall(
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
  focusedPaths?: string[],
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
    focusedPaths,
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
  focusedPaths?: string[],
  sessionId?: string,
  onAskUserRequest?: (request: AskUserRequest) => void,
  autoExecutionPolicy: SensitiveWriteAutoExecutionPolicy = "allow",
): Promise<{ result: ToolExecutionResult; trace: ToolExecutionTrace }> {
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
    focusedPaths,
    sessionId,
    onAskUserRequest,
    autoExecutionPolicy,
  );
}

export async function runNativeToolCallingLoop(
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
  onThinkingChunk?: (delta: string) => void,
  explicitSnippetIds?: string[],
): Promise<NativeToolLoopResult> {
  const activeTools = buildAgentToolDefs(runtime);
  const enabledToolNames = [...runtime.enabledTools, ...INTERNAL_TOOL_NAMES];
  const planState = normalizeTodoPlanState(clonePlanState(initialPlanState));
  const basePermissions = runtime.toolPermissions as unknown as ToolPermissions;
  const toolPermissions: ToolPermissions = projectConfig?.toolPermissions
    ? ({
        ...basePermissions,
        ...projectConfig.toolPermissions,
      } as ToolPermissions)
    : basePermissions;
  const [skillResolution, snippetResolution] = await Promise.all([
    resolveMatchedSkills(
      settings,
      projectConfig,
      prompt,
      focusedPaths,
      explicitSkillIds,
    ),
    resolveMatchedSnippets(settings, explicitSnippetIds),
  ]);
  const agentSystemPrompt = assembleSystemPrompt(
    runtime,
    skillResolution,
    snippetResolution,
  );
  const effectiveRuntimeContext = assembleRuntimeContext(runtime, settings.workspacePath, INTERNAL_TOOL_NAMES);
  const requestedArtifactCount =
    phase === "default" ? estimateRequestedArtifactCount(prompt) : 0;
  const blockedFingerprints = blockedActionFingerprints
    .map((value) => value.trim())
    .filter(Boolean);
  const blockedFingerprintSet = new Set(blockedFingerprints);

  const messages: LiteLLMMessage[] = [
    { role: "system", content: agentSystemPrompt },
    { role: "system", content: effectiveRuntimeContext },
    ...(blockedFingerprints.length > 0
      ? [{
          role: "system" as const,
          content: [
            "系统提示：以下动作指纹已在之前轮次执行或处理完成，禁止再次提出相同动作。",
            ...blockedFingerprints.map((fingerprint) => `- ${fingerprint}`),
            "如果没有新的必要动作，请直接给出最终总结。",
          ].join("\n"),
        }]
      : []),
    ...(internalSystemNote?.trim()
      ? [{ role: "system" as const, content: internalSystemNote.trim() }]
      : []),
    ...conversationHistory,
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
    `[Loop] 会话开始 | phase=${phase} | continuation=${isContinuation ? "yes" : "no"}`,
  );
  // Snapshot the message count BEFORE the loop body runs. Anything appended
  // beyond this index is "loop-produced" and must be exposed back to the UI so
  // multi-turn tool histories survive into the next conversation turn.
  const inputMessageCount = messages.length;
  const captureLoopMessages = (): LiteLLMMessage[] => messages.slice(inputMessageCount);

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
  const fileEditFailureTracker = new Map<string, number>();
  let consecutiveReadOnlyTurns = 0;
  let toolChoiceOverride: "auto" | "none" | undefined;
  let lastWorkingMemoryFingerprint = "";
  const contextNotes = new ContextNoteBuffer();

  const limitTokens = resolveEffectiveContextTokenLimit(settings);
  const workingMemory = initWorkingMemoryForLoop({
    restoredSnapshot: restoredWorkingMemory,
    limitTokens,
    outputReserveRatio: COMPRESSION_PARAMS.outputReserveRatio,
    softBudgetRatio: COMPRESSION_PARAMS.softBudgetRatio,
    internalSystemNote,
  });
  const currentWorkingMemorySnapshot = (): WorkingMemorySnapshot | undefined =>
    snapshotWorkingMemory(workingMemory);
  const outputBufferTokens = Math.min(
    8000,
    Math.max(512, Math.floor(limitTokens * COMPRESSION_PARAMS.outputReserveRatio)),
  );
  const hardPromptBudget = Math.max(0, limitTokens - outputBufferTokens);
  const softPromptBudget = Math.floor(hardPromptBudget * COMPRESSION_PARAMS.softBudgetRatio);
  const promptBudgetTarget = softPromptBudget > 0 ? softPromptBudget : hardPromptBudget;
  const maxToolOutputChars = computeMaxToolOutputChars(hardPromptBudget);
  const toolDefTokens = estimateTokensForToolDefinitions(activeTools);
  console.log(`[Loop] 工具定义 token 开销: ~${toolDefTokens} tokens (${activeTools.length} tools)`);

  const estimateCurrentTokens = (): number => estimateTokensForMessages(messages);
  const replaceMessages = (nextMessages: LiteLLMMessage[]): void => {
    if (nextMessages === messages) {
      return;
    }
    messages.splice(0, messages.length, ...nextMessages);
  };
  const emitContextUpdate = (): number => {
    const estimatedTokens = estimateCurrentTokens();
    onContextUpdate?.(estimatedTokens);
    return estimatedTokens;
  };

  const compressionPolicy = {
    maxPromptTokens: promptBudgetTarget,
    minMessagesToSummarize: MIN_MESSAGES_TO_SUMMARIZE,
    minRecentMessagesToKeep: COMPRESSION_PARAMS.minRecentMessagesToKeep,
    recentTokensMinRatio: COMPRESSION_PARAMS.recentTokensMinRatio,
    toolDefinitionTokens: toolDefTokens,
  };

  const summarizer = {
    summarize: (messagesToSummarize: LiteLLMMessage[]) =>
      requestSummary(messagesToSummarize, settings, {
        workspacePath: settings.workspacePath,
      }),
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
        loopMessages: captureLoopMessages(),
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
        loopMessages: captureLoopMessages(),
        workingMemorySnapshot: currentWorkingMemorySnapshot(),
      };
    }

    maybeEmitIncrementalCheckpoint({
      turn,
      messages,
      proposedActions,
      planState,
      toolTrace,
      snapshot: currentWorkingMemorySnapshot,
      onLoopCheckpoint,
    });

    if (turn > 0) {
      const currentFingerprint = computeWorkingMemoryFingerprint(workingMemory);
      const hasMemoryContent = currentFingerprint !== "0:0:0:0";
      const memoryChanged = hasMemoryContent && currentFingerprint !== lastWorkingMemoryFingerprint;
      const isRefreshTurn = turn % WORKING_MEMORY_REFRESH_INTERVAL === 0;

      if (hasMemoryContent && (memoryChanged || isRefreshTurn)) {
        const wmContent = buildWorkingMemoryContent({
          workingMemory,
          tokenBudget: Math.floor(promptBudgetTarget * 0.12),
          query: prompt,
          focusedPaths,
        });
        if (wmContent) contextNotes.push(wmContent);
        lastWorkingMemoryFingerprint = currentFingerprint;
      }

    }

    const pinnedPrefixLen = initialSystemPrefixLength(messages);
    const estTokensAtTurnStart = estimateCurrentTokens();
    console.log(`[Loop] ── Turn ${turn + 1} ── messages=${messages.length} | ~${estTokensAtTurnStart} tokens`);

    if (turn === TOOL_LOOP_EFFICIENCY_WARNING_THRESHOLD) {
      contextNotes.push([
        `系统提示：你已经使用了 ${turn} 轮工具调用。`,
        "请注意效率，优先使用 grep/glob 批量搜索而非逐个文件阅读。",
        "如果任务已基本完成，请尽快给出最终总结；如果确实需要继续，请集中处理剩余关键步骤。"
      ].join("\n"));
    }

    if (
      turn > 0 &&
      turn % TOOL_CALLING_REINFORCEMENT_INTERVAL === 0 &&
      toolChoiceOverride !== "none"
    ) {
      // Remove any old reinforcement message from a previous turn.
      const existingReinforcement = messages.findIndex(
        (message) => message.role === "system" && message.content.startsWith(TOOL_CALLING_REINFORCEMENT_NOTE_PREFIX),
      );
      if (existingReinforcement >= pinnedPrefixLen) {
        messages.splice(existingReinforcement, 1);
      }
      contextNotes.push([
        TOOL_CALLING_REINFORCEMENT_NOTE_PREFIX,
        "重要：你必须通过原生工具调用（function calling / tool_calls）来使用工具。",
        "不要在回复文本中描述、转录或模拟工具调用。直接发送 tool_calls 即可。",
        `可用工具: [${enabledToolNames.join(", ")}]`,
      ].join("\n"));
    }


    // M3: scrub older read_file results once their content is cached in WM.
    // Only fires under context pressure (est > 70% budget) to avoid
    // invalidating prefix cache when space isn't actually needed.
    const estTokensBeforeDedup = estimateCurrentTokens();
    if (estTokensBeforeDedup > promptBudgetTarget * 0.7) {
      const dedupedReads = dedupeStaleFileReads(messages, workingMemory);
      if (dedupedReads > 0) {
        console.log(`[Loop] 去重历史 read_file: 重写 ${dedupedReads} 条`);
      }
    }


    // Single-threshold compression: hand off to compressMessagesToFitBudget on
    // every turn — its internal "tokens already fit" check is the no-op fast
    // path. Replaces the prior 3-tier decision (safe-zone gate + dynamic
    // cooldown + softBudgetRatio).
    const compression = await compressMessagesToFitBudget({
      messages,
      policy: compressionPolicy,
      summarizer,
      pinnedPrefixLen,
    });
    if (compression.compressed && compression.messages !== messages) {
      const beforeLen = messages.length;
      replaceMessages(compression.messages);
      const afterTokens = estimateCurrentTokens();
      console.log(`[Loop] 上下文压缩: ${beforeLen} → ${messages.length} messages | ~${afterTokens} tokens`);
    }
    emitContextUpdate();

    // Phase 0 measurement: record state going into the LLM request.
    // Fields are pipe-delimited key=value so downstream parsing (grep / awk / CSV) is trivial.
    {
      const estIn = estimateCurrentTokens();
      const usedPct = promptBudgetTarget > 0 ? (estIn / promptBudgetTarget) * 100 : 0;
      const compressionType = compression.compressed
        ? compression.usedSummary
          ? "summary"
          : compression.usedTruncation
            ? "truncation"
            : compression.usedToolCompression
              ? "tool"
              : "other"
        : "none";
      console.log(
        `[CtxMetric:pre] turn=${turn + 1} | est=${estIn} | budget=${promptBudgetTarget} | ctx=${limitTokens}` +
        ` | usedPct=${usedPct.toFixed(1)} | compressionFired=${compression.compressed}` +
        ` | compressionType=${compressionType} | msgs=${messages.length} | toolDefTokens=${toolDefTokens}` +
        ` | model=${settings.model}`,
      );
    }

    // Flush context notes into the message stream before the LLM call.
    // This embeds notes into the last tool result (cache-friendly) instead of
    // injecting system messages that break prefix cache.
    contextNotes.flush(messages);

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
            sessionId,
            onThinkingChunk,
          );
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
            `[Loop][Retry] 等待 ${Math.round(delay)}ms 后重试 (attempt ${llmRetryAttempt + 2}/${MAX_LLM_REQUEST_RETRIES})`,
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

    if (completion.requestRecord.inputTokens) {
      // Static multi-script estimator: track ratio for visibility but no dynamic
      // calibration is applied (with prompt caching, ±15% drift on uncached
      // input is below the noise floor).
      const estBeforeCall = estimateCurrentTokens() + toolDefTokens;
      const actualIn = completion.requestRecord.inputTokens;
      const ratio = estBeforeCall > 0 ? actualIn / estBeforeCall : 0;
      const outTokens = completion.requestRecord.outputTokens ?? 0;
      console.log(
        `[CtxMetric:post] turn=${turn + 1} | est=${estBeforeCall} | actual=${actualIn}` +
        ` | ratio=${ratio.toFixed(3)} | outputTokens=${outTokens}` +
        ` | budget=${promptBudgetTarget} | model=${settings.model}`,
      );
    }

    if (
      completion.finishReason === "length" &&
      completion.toolCalls.length === 0 &&
      !completion.assistantMessage.content.trim()
    ) {
      console.warn(`[Loop] Turn ${turn + 1}: 响应被 max_tokens 截断且无有效内容，请求模型缩短输出后重试`);
      messages.pop();
      contextNotes.push([
        "系统提示：你的上一次回复因为超出最大 token 限制而被截断，系统没有收到完整的回复或工具调用。",
        "请用更简洁的方式回复。如果需要使用工具，直接发送工具调用，不要输出冗长的分析文本。",
        "如果要修改文件，每次只修改一个文件的一小段，避免在单次回复中生成过多内容。"
      ].join("\n"));
      continue;
    }

    if (completion.finishReason === "length" && completion.toolCalls.length > 0) {
      console.warn(`[Loop] Turn ${turn + 1}: 响应被截断但包含 ${completion.toolCalls.length} 个工具调用，继续处理已解析的调用`);
    }

    if (!completion.toolCalls.length) {
      if (completion.droppedToolCalls > 0) {
        console.warn(`[Loop] Turn ${turn + 1}: ${completion.droppedToolCalls} 个工具调用因格式畸形被丢弃，要求模型重试`);
        messages.pop();
        contextNotes.push([
          `系统提示：模型尝试了 ${completion.droppedToolCalls} 个工具调用，但全部因格式畸形被丢弃（缺少 function.name 或 arguments 不是字符串）。`,
          `可用工具: [${enabledToolNames.join(", ")}]`,
          "请使用正确的工具调用格式重试。"
        ].join("\n"));
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
      if (pseudoToolCallReason && shouldRetryPseudoToolCall(pseudoToolCallRepairRounds)) {
        pseudoToolCallRepairRounds += 1;
        messages.pop();
        console.warn(
          `[Loop] Turn ${turn + 1}: detected pseudo tool-call narration without native tool_calls (${pseudoToolCallReason}), requesting retry`,
        );
        contextNotes.push(buildPseudoToolCallRepairMessage(enabledToolNames));
        continue;
      }

      if (pseudoToolCallReason) {
        const protocol = runtime.vendorProtocol || "openai-chat-completions";
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
          loopMessages: captureLoopMessages(),
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
        loopMessages: captureLoopMessages(),
        workingMemorySnapshot: currentWorkingMemorySnapshot(),
      };
    }

    const toolNames = completion.toolCalls.map((toolCall) => toolCall.function.name);
    console.log(`[Loop] Turn ${turn + 1} | 收到 ${completion.toolCalls.length} 个工具调用: [${toolNames.join(", ")}]`);

    const actionCountBeforeTurn = proposedActions.length;
    let patchPreflightFailure: string | null = null;
    let createPathUsageFailure: string | null = null;
    let shellDialectRepairInstruction: string | null = null;
    let searchNotFoundFailure: string | null = null;
    let turnHasToolNotFound = false;
    let turnSuccessCount = 0;
    let turnFailureCount = 0;
    let turnDedupHitCount = 0;

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
        (trace.status === "failed" ? ` | ${trace.errorCategory}: ${trace.errorMessage}` : ""),
      );

      return { toolCall, toolResult, trace };
    };

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
        try {
          const parsedContent = JSON.parse(toolResult.content);
          if (parsedContent.status === "cached") {
            turnDedupHitCount += 1;
          }

          // M3-4: invalidate cached content for any file targeted by a
          // successful propose_file_edit. Covers both branches:
          //   - auto_executed: files were already written to disk
          //   - HITL-pending: files are about to change pending approval
          // Speculative invalidation in the HITL-pending case is safe — if
          // the user rejects, the cache miss costs one extra read_file and
          // never serves stale bytes. dedupeStaleFileReads picks up the
          // invalidation and rewrites older read results to a stale stub.
          if (
            toolCall.function.name === "propose_file_edit" &&
            parsedContent?.ok === true &&
            Array.isArray(parsedContent.files)
          ) {
            for (const f of parsedContent.files) {
              if (typeof f === "string" && f.trim()) {
                invalidateFileContent(workingMemory, f.trim());
              }
            }
          }
        } catch {
          // noop
        }

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

          // M3: cache the actual file content body (not just the 200-char
          // summary). On subsequent turns dedupeStaleFileReads scrubs older
          // copies of the same file from the message stream, so the cached
          // body becomes the single source of truth.
          if (toolCall.function.name === "read_file") {
            try {
              const parsed = JSON.parse(toolResult.content);
              if (
                parsed?.ok === true &&
                typeof parsed.content_preview === "string" &&
                parsed.content_preview.length > 0
              ) {
                const path = String(parsedArgs.relative_path ?? parsedArgs.path ?? "").trim();
                if (path) {
                  setFileContent(workingMemory, path, parsed.content_preview, {
                    totalLines: typeof parsed.total_lines === "number" ? parsed.total_lines : undefined,
                    turnNumber: turn,
                    agentId: "main",
                    summary: knowledge?.summary,
                    language: knowledge?.language,
                  });
                }
              }
            } catch {
              // Non-JSON or malformed result — slot stays empty, falls back
              // to the existing message-stream copy.
            }
          }
        } catch {
          // noop
        }
      }

      if (
        toolResult.success === false &&
        toolResult.errorCategory === "validation" &&
        toolCall.function.name === "propose_file_edit" &&
        (toolResult.errorMessage ?? "").includes("Patch 预检失败")
      ) {
        patchPreflightFailure = toolResult.errorMessage ?? "Patch 预检失败";
      }
      if (
        toolResult.success === false &&
        toolResult.errorCategory === "validation" &&
        toolCall.function.name === "propose_file_edit" &&
        (((toolResult.errorMessage ?? "")
          .toLowerCase()
          .includes("invalid target path")) ||
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
        (toolResult.errorMessage ?? "").includes("片段未找到")
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
        } catch {
          // noop
        }
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
        } catch {
          // noop
        }
      }
      const shellRepairHint = buildShellDialectRepairInstruction(toolCall, toolResult);
      if (shellRepairHint) {
        shellDialectRepairInstruction = shellRepairHint;
      }
      const incomingActions: ActionProposal[] = [];
      if (toolResult.proposedActions && toolResult.proposedActions.length > 0) {
        incomingActions.push(...toolResult.proposedActions);
      } else if (toolResult.proposedAction) {
        incomingActions.push(toolResult.proposedAction);
      }
      for (const action of incomingActions) {
        const fingerprint = action.fingerprint || actionFingerprint(action);
        if (blockedFingerprintSet.has(fingerprint)) {
          console.warn(
            `[Planning][ProcessToolResult] Suppressing blocked action in-loop | type=${action.type} | fingerprint=${fingerprint}`,
          );
          continue;
        }
        const linkedAction = attachActionToPlanStep(planState, action);
        proposedActions.push(linkedAction);
      }
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        name: toolCall.function.name,
        content: trimToolContentForContext(
          toolResult.content,
          maxToolOutputChars,
          { smartTruncate },
        ),
      });
    };

    const readOnlyCalls = completion.toolCalls.filter(
      (toolCall) => PARALLEL_SAFE_TOOL_NAMES.has(toolCall.function.name),
    );
    const mutationCalls = completion.toolCalls.filter(
      (toolCall) => !PARALLEL_SAFE_TOOL_NAMES.has(toolCall.function.name),
    );
    let planMutatedThisTurn = false;

    if (readOnlyCalls.length > 1) {
      console.log(`[Orchestrator] 并行执行 ${readOnlyCalls.length} 个只读工具调用`);
      const readResults = await runWithConcurrencyLimit(
        readOnlyCalls.map((toolCall) => () => executeSingleToolCall(toolCall)),
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

    for (const toolCall of mutationCalls) {
      const { toolResult, trace } = await executeSingleToolCall(toolCall);
      processToolResult(toolCall, toolResult, trace);
      if (toolCall.function.name.startsWith("propose_")) {
        planMutatedThisTurn = true;
      }
    }

    if (planMutatedThisTurn && onPlanStateUpdate) {
      try {
        const clonedActions = JSON.parse(JSON.stringify(proposedActions));
        onPlanStateUpdate(clonePlanState(planState), clonedActions);
      } catch (error) {
        console.warn(`[Loop] onPlanStateUpdate failed:`, error);
      }
    }

    emitContextUpdate();

    if (turnDedupHitCount > 0 && turnDedupHitCount >= Math.ceil(turnSuccessCount * 0.5)) {
      const knownFilesList = [...workingMemory.fileKnowledge.entries()]
        .sort((a, b) => (b[1].lastReadTurn ?? 0) - (a[1].lastReadTurn ?? 0))
        .slice(0, 20)
        .map(([path, knowledge]) => `- ${path} (${knowledge.totalLines}行, ${knowledge.language ?? "?"}): ${knowledge.summary}`)
        .join("\n");
      console.log(`[Loop] Turn ${turn + 1}: ${turnDedupHitCount}/${turnSuccessCount} 个工具调用命中去重缓存`);
      contextNotes.push([
        `系统提示：本轮 ${turnDedupHitCount} 个文件读取命中了去重缓存，说明你正在重复读取已知文件。`,
        "以下是你已经读取过的文件及其摘要，请直接利用这些信息，不要再次读取：",
        knownFilesList,
        "请基于已有信息继续推进任务，而非重复读取。如需特定代码片段，请用 start_line/end_line 精确读取。",
      ].join("\n"));
    }

    const turnHasPropose = completion.toolCalls.some((toolCall) => toolCall.function.name.startsWith("propose_"));
    if (!turnHasPropose && turnSuccessCount > 0) {
      consecutiveReadOnlyTurns += 1;
    } else {
      consecutiveReadOnlyTurns = 0;
    }

    if (shouldForceReadOnlySummary(consecutiveReadOnlyTurns)) {
      console.log(`[Loop] 连续 ${consecutiveReadOnlyTurns} 轮纯读取，强制要求总结`);
      contextNotes.push(buildReadOnlyTurnsWarningMessage(consecutiveReadOnlyTurns));
      toolChoiceOverride = "none";
      consecutiveReadOnlyTurns = 0;
    }

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
        loopMessages: captureLoopMessages(),
        workingMemorySnapshot: currentWorkingMemorySnapshot(),
      };
    }
    if (shouldWarnForToolNotFound(toolNotFoundStrikes)) {
      contextNotes.push(buildToolNotFoundWarningMessage(toolNotFoundStrikes, enabledToolNames));
    }

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
        loopMessages: captureLoopMessages(),
        workingMemorySnapshot: currentWorkingMemorySnapshot(),
      };
    }

    for (const [filePath, failCount] of fileEditFailureTracker) {
      if (failCount >= MAX_SAME_FILE_EDIT_FAILURES) {
        console.warn(`[Loop] 熔断: 文件 ${filePath} 连续编辑失败 ${failCount} 次`);
        contextNotes.push(buildSameFileEditFailureMessage(filePath, failCount));
        fileEditFailureTracker.delete(filePath);
        break;
      }
    }

    const noNewActionsThisTurn = proposedActions.length === actionCountBeforeTurn;

    if (
      noNewActionsThisTurn &&
      patchPreflightFailure &&
      patchRepairRounds < MAX_PATCH_REPAIR_ROUNDS
    ) {
      patchRepairRounds += 1;
      contextNotes.push(buildPatchPreflightRepairMessage(patchPreflightFailure));
      continue;
    }

    if (
      noNewActionsThisTurn &&
      createPathUsageFailure &&
      createHintRepairRounds < MAX_CREATE_HINT_REPAIR_ROUNDS
    ) {
      createHintRepairRounds += 1;
      contextNotes.push(buildCreatePathRepairMessage(createPathUsageFailure));
      continue;
    }

    if (
      noNewActionsThisTurn &&
      searchNotFoundFailure &&
      searchNotFoundRepairRounds < MAX_SEARCH_NOT_FOUND_REPAIR_ROUNDS
    ) {
      searchNotFoundRepairRounds += 1;
      contextNotes.push(buildSearchNotFoundRepairMessage(searchNotFoundFailure));
      continue;
    }

    if (
      noNewActionsThisTurn &&
      shellDialectRepairInstruction &&
      shellDialectRepairRounds < MAX_SHELL_DIALECT_REPAIR_ROUNDS
    ) {
      shellDialectRepairRounds += 1;
      contextNotes.push(shellDialectRepairInstruction);
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
        contextNotes.push([
          "系统提示：用户请求包含多个交付物。",
          `当前已提出 ${plannedArtifacts} 个交付物相关动作，目标至少 ${requestedArtifactCount} 个。`,
          "请继续提出剩余缺失交付物的审批动作；不要重复已有动作。",
          "仅在所有请求交付物都已覆盖，或确实无法继续时，才停止工具调用。",
        ].join("\n"));
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
        contextNotes.push(
          "系统提示：你已经提出了部分待审批动作。请继续补齐剩余缺失交付物，直到达到交付覆盖目标或达到单批动作上限。",
        );
        continue;
      }

      return {
        assistantReply: completion.assistantMessage.content.trim(),
        requestRecords,
        proposedActions,
        planState,
        toolTrace,
        loopMessages: captureLoopMessages(),
        workingMemorySnapshot: currentWorkingMemorySnapshot(),
      };
    }
  }
}
