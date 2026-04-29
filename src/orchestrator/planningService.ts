/**
 * Cofree - AI Programming Cafe
 * File: src/orchestrator/planningService.ts
 * Description: Planning session facade, result reconciliation, and externally consumed planning helpers.
 */

import { invoke } from "@tauri-apps/api/core";
import { recordLLMAudit } from "../lib/auditLog";
import { type LiteLLMMessage } from "../lib/piAiBridge";
import {
  getActiveManagedModel,
  getActiveVendor,
  isActiveModelLocal,
  resolveEffectiveContextTokenLimit,
  type AppSettings,
} from "../lib/settingsStore";
import { resolveAgentRuntime } from "../agents/resolveAgentRuntime";
import {
  buildCofreeRcPromptFragment,
  loadCofreeRc,
  type CofreeRcConfig,
} from "../lib/cofreerc";
import { buildExplicitContextNote } from "./explicitContextService";
import { generateRepoMap } from "./repoMapService";
import {
  summarizeWorkspaceFiles,
  type WorkspaceOverviewBudget,
} from "./readOnlyWorkspaceService";
import {
  normalizeTodoPlanState,
  type TodoPlanState,
} from "./todoPlanState";
import type { ActionProposal, PlanStep } from "./types";
import type { ToolExecutionTrace } from "./toolTraceTypes";
import {
  detectPseudoToolCallNarration,
  detectPseudoToolJsonTranscript,
  summarizeToolArgs,
} from "./toolCallAnalysis";
import { pruneStaleSystemMessages } from "./loopPromptScaffolding";
import { sanitizeMessagesForToolCalling } from "./llmToolLoop";
import {
  actionFingerprint,
  buildProposedActionBatchMetadata,
  estimateRequestedArtifactCount,
  initializePlan,
} from "./planningCore";
import {
  executeToolCall,
  runNativeToolCallingLoop,
} from "./planningLoop";
import type {
  PlanningSessionResult,
  RunPlanningSessionInput,
} from "./planningSessionTypes";

export type {
  PlanningSessionPhase,
  PlanningSessionResult,
  RunPlanningSessionInput,
  ToolCallEvent,
} from "./planningSessionTypes";
export {
  actionFingerprint,
  estimateRequestedArtifactCount,
  initializePlan,
} from "./planningCore";

interface InitialPlanSeed extends TodoPlanState {
  source: "fallback" | "existing";
}

export class LocalOnlyPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalOnlyPolicyError";
  }
}

function normalizeFocusedPathList(paths: string[] | undefined): string[] {
  return [...new Set(
    (paths ?? [])
      .map((path) => path.trim().replace(/\\/g, "/").replace(/^\/+/, ""))
      .filter(Boolean),
  )];
}

function normalizeConversationHistory(
  conversationHistory: RunPlanningSessionInput["conversationHistory"],
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
        message.tool_calls.length > 0),
  );

  const answeredToolCallIds = new Set(
    filtered
      .filter((message) => message.role === "tool" && message.tool_call_id)
      .map((message) => message.tool_call_id as string),
  );

  return filtered.map((message) => {
    const normalized: LiteLLMMessage = {
      role: message.role as LiteLLMMessage["role"],
      content: message.content.trim(),
    };
    if (message.tool_calls) {
      const validCalls = message.tool_calls.filter((toolCall) => answeredToolCallIds.has(toolCall.id));
      const droppedCallIds = message.tool_calls
        .filter((toolCall) => !answeredToolCallIds.has(toolCall.id))
        .map((toolCall) => toolCall.id);
      if (droppedCallIds.length > 0) {
        // Surface a long-standing data-loss bug: an assistant message claimed
        // tool_calls but no matching tool_result rows survived in history. The
        // model will be unable to "see" what those tool calls returned and
        // typically re-runs the same searches in the next turn. If you hit this,
        // check that planningSession.loopMessages is being persisted into chat
        // history (see useChatExecution.ts).
        console.warn(
          `[Planning][NormalizeHistory] Dropping orphan tool_calls (no matching tool_result):` +
            ` ids=[${droppedCallIds.join(", ")}] | content_preview="${message.content.slice(0, 80)}"`,
        );
      }
      if (validCalls.length > 0) {
        normalized.tool_calls = validCalls;
      }
    }
    if (message.role === "tool" && message.tool_call_id) {
      normalized.tool_call_id = message.tool_call_id;
    }
    if (message.role === "tool" && message.name) {
      normalized.name = message.name;
    }
    return normalized;
  });
}

function sanitizeStepsFromPrompt(prompt: string): PlanStep[] {
  const normalized = prompt.trim() || "实现用户提出的功能";
  return normalizeTodoPlanState({
    steps: [
      {
        id: "step-plan",
        title: "分析需求",
        status: "in_progress",
        summary: `分析需求并拆解执行步骤: ${normalized}`,
      },
      {
        id: "step-implement",
        title: "执行实现",
        status: "pending",
        summary: "基于任务生成实现或回答",
        dependsOn: ["step-plan"],
      },
      {
        id: "step-verify",
        title: "补充验证",
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

function buildProposedActions(
  fromTools: ActionProposal[],
  blockedFingerprints: Iterable<string> = [],
): ActionProposal[] {
  const uniqueActions: ActionProposal[] = [];
  const seen = new Set<string>();
  const blocked = new Set(
    Array.from(blockedFingerprints, (value) => value.trim()).filter(Boolean),
  );

  for (const action of fromTools) {
    const validationError = validateProposedAction(action);
    if (validationError) {
      console.warn(
        `[Planning][ProposedActions] Dropping invalid proposed action | type=${action.type} | action=${action.id} | reason=${validationError}`,
      );
      continue;
    }

    const fingerprint = actionFingerprint(action);
    if (blocked.has(fingerprint)) {
      console.warn(
        `[Planning][ProposedActions] Dropping blocked proposed action | type=${action.type} | action=${action.id} | fingerprint=${fingerprint}`,
      );
      continue;
    }
    if (seen.has(fingerprint)) {
      console.warn(
        `[Planning][ProposedActions] Dropping duplicate proposed action | type=${action.type} | action=${action.id} | fingerprint=${fingerprint}`,
      );
      continue;
    }

    seen.add(fingerprint);
    if (!action.fingerprint) {
      action.fingerprint = fingerprint;
    }
    uniqueActions.push(action);
  }

  buildProposedActionBatchMetadata(uniqueActions);
  return uniqueActions;
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
    (sentence) => !APPROVAL_CARD_CLAIM_HINTS.some((hint) => sentence.includes(hint)),
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
        const hasSuccess = toolTrace.some((trace) => trace.status === "success");
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
    if (toolTrace.length > 0) {
      const hasSuccess = toolTrace.some((trace) => trace.status === "success");
      return hasSuccess ? "已完成工具调用。" : "工具调用已结束。";
    }
    return "处理完成。";
  }

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
      const hasSuccess = toolTrace.some((trace) => trace.status === "success");
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

  const hasSuccessfulToolCall = toolTrace.some((trace) => trace.status === "success");
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
  normalizeConversationHistory,
};

function assertLocalOnlyPolicy(settings: AppSettings): void {
  if (settings.allowCloudModels) {
    return;
  }
  if (isActiveModelLocal(settings)) {
    return;
  }
  throw new LocalOnlyPolicyError(
    "Local-only 已开启，请切换到本地 Provider（如 Ollama）后再发起请求。",
  );
}

export async function runPlanningSession(
  input: RunPlanningSessionInput,
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
    `[Planning] ═══ 会话开始 ═══ | agent=${runtime.agentId} | model=${input.settings.model} | phase=${phase} | history=${historyMessages.length} | continuation=${!!input.isContinuation}`,
  );
  console.log(
    `[Planning] prompt: "${normalizedPrompt.slice(0, 120)}${normalizedPrompt.length > 120 ? "…" : ""}"`,
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

  if (input.settings.workspacePath) {
    const shouldLoadProjectConfig =
      (historyMessages.length === 0 && !input.isContinuation) ||
      (input.contextAttachments?.length ?? 0) > 0;

    try {
      if (shouldLoadProjectConfig) {
        projectConfig = await loadCofreeRc(input.settings.workspacePath);
      }
    } catch (error) {
      console.warn("Failed to load .cofreerc", error);
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
      } catch (error) {
        console.warn("Failed to build explicit context note", error);
      }
    }

    if (historyMessages.length === 0 && !input.isContinuation) {
      try {
        const overviewBudget: WorkspaceOverviewBudget | undefined =
          projectConfig.overviewBudget;
        const overview = await summarizeWorkspaceFiles(
          input.settings.workspacePath,
          projectConfig.ignorePatterns && projectConfig.ignorePatterns.length > 0
            ? projectConfig.ignorePatterns
            : null,
          overviewBudget,
        );
        const overviewPrompt = `项目概览：\n${overview}`;
        initialInternalNote = initialInternalNote
          ? `${initialInternalNote}\n\n${overviewPrompt}`
          : overviewPrompt;
      } catch (error) {
        console.warn("Failed to generate workspace overview", error);
      }

      if (projectConfig.repoMap?.enabled !== false) {
        try {
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
            initialInternalNote = initialInternalNote
              ? `${initialInternalNote}\n\n${repoMap}`
              : repoMap;
            console.log(`[Planning] Repo-map injected (~${repoMap.length} chars)`);
          }
        } catch (error) {
          console.warn("Failed to generate repo-map", error);
        }
      }

      const rcFragment = buildCofreeRcPromptFragment(projectConfig);
      if (rcFragment) {
        initialInternalNote = initialInternalNote
          ? `${initialInternalNote}\n\n${rcFragment}`
          : rcFragment;
      }

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

        for (const relativePath of projectConfig.contextFiles) {
          try {
            const result = await invoke<{
              content: string;
              total_lines: number;
              start_line: number;
              end_line: number;
            }>("read_workspace_file", {
              workspacePath: input.settings.workspacePath,
              relativePath,
              startLine: null,
              endLine: null,
              ignorePatterns,
            });
            if (result.content && result.content.trim()) {
              const truncated =
                result.content.length > 2000
                  ? `${result.content.slice(0, 2000)}\n... (truncated)`
                  : result.content;
              contextSnippets.push(`--- ${relativePath} ---\n${truncated}`);
            }
          } catch {
            // File not found / ignored / unreadable: skip.
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
      input.restoredWorkingMemory,
      input.explicitSkillIds,
      input.onThinkingChunk,
      input.explicitSnippetIds,
    );

    for (const record of loopResult.requestRecords) {
      recordLLMAudit({
        requestId: record.requestId,
        provider: input.settings.provider ?? input.settings.liteLLMBaseUrl,
        model: input.settings.model,
        timestamp: new Date().toISOString(),
        inputLength: record.inputLength,
        outputLength: record.outputLength,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        cacheCreationTokens: record.cacheCreationTokens,
        cacheReadTokens: record.cacheReadTokens,
      });
    }

    const lastRecord = loopResult.requestRecords[loopResult.requestRecords.length - 1];
    const totalInputTokens = lastRecord
      ? (lastRecord.inputTokens ?? Math.ceil(lastRecord.inputLength / 2.5))
      : 0;
    const totalOutputTokens = loopResult.requestRecords.reduce((sum, record) => {
      return sum + (record.outputTokens ?? Math.ceil(record.outputLength / 2.5));
    }, 0);
    const totalCacheReadTokens = loopResult.requestRecords.reduce(
      (sum, record) => sum + (record.cacheReadTokens ?? 0),
      0,
    );
    const totalCacheCreationTokens = loopResult.requestRecords.reduce(
      (sum, record) => sum + (record.cacheCreationTokens ?? 0),
      0,
    );

    const sessionElapsed = ((performance.now() - sessionT0) / 1000).toFixed(2);
    console.log(
      `[Planning] ═══ 会话完成 ═══ | ${sessionElapsed}s` +
      ` | turns=${loopResult.requestRecords.length}` +
      ` | tools=${loopResult.toolTrace.length}` +
      ` | actions=${loopResult.proposedActions.length}` +
      ` | in≈${totalInputTokens} out≈${totalOutputTokens}` +
      (totalCacheReadTokens > 0 || totalCacheCreationTokens > 0
        ? ` | cacheRead=${totalCacheReadTokens} cacheCreate=${totalCacheCreationTokens}`
        : ""),
    );

    const proposedActions = buildProposedActions(
      loopResult.proposedActions,
      input.blockedActionFingerprints,
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
      assistantToolCallsFromFinalTurn: loopResult.assistantToolCallsFromFinalTurn,
    });

    // Loop already includes the FINAL assistant message at the tail when the
    // loop completed naturally (text reply or HITL gate). The placeholder
    // ChatMessageRecord on the UI side already represents that final message
    // via `assistantReply` + `assistantToolCalls`, so we drop the duplicate.
    // Early-termination paths (max-turn cap, tool-not-found burst) end with a
    // tool result instead of an assistant message — keep the slice intact so
    // the synthetic `assistantReply` becomes the only "final" entry.
    const rawLoop = loopResult.loopMessages ?? [];
    const tail = rawLoop.length > 0 ? rawLoop[rawLoop.length - 1] : undefined;
    const trailingIsFinalAssistant =
      tail?.role === "assistant" &&
      ((tail.content ?? "").trim() === loopResult.assistantReply.trim() ||
        // Final assistant may carry only tool_calls (HITL gate) — still drop.
        ((tail.tool_calls?.length ?? 0) > 0 && !(tail.content ?? "").trim()));
    const loopMessages = trailingIsFinalAssistant ? rawLoop.slice(0, -1) : rawLoop;

    return {
      assistantReply,
      plan,
      toolTrace: loopResult.toolTrace,
      assistantToolCalls,
      loopMessages,
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
      "",
      "调试信息:",
      `- 模型: ${modelName}`,
      `- 协议: ${protocol}`,
      `- 端点: ${baseUrl}`,
      `- 时间: ${new Date().toISOString()}`,
      `- 耗时: ${sessionElapsed}s`,
    ];

    if (errorStack) {
      debugInfo.push("", "堆栈跟踪:", errorStack);
    }

    console.error("[Planning] 完整错误信息:", debugInfo.join("\n"));
    throw error;
  }
}
