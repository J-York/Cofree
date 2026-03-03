/**
 * Cofree - AI Programming Cafe
 * File: src/orchestrator/hitlContinuationMachine.ts
 * Description: State-machine style continuation logic after HITL review completes.
 */

import type { ActionProposal, OrchestrationPlan } from "./types";
import { actionFingerprint } from "./planningService";

export interface ToolReplayMessage {
  role: "tool";
  tool_call_id: string;
  name: string;
  content: string;
}

export interface HitlContinuationMemory {
  roundsByPrompt: Record<string, number>;
  seenContinuationKeys: string[];
  recentModifiedFilesByPrompt: Record<string, string[][]>;
}

export const DEFAULT_HITL_CONTINUATION_MEMORY: HitlContinuationMemory = {
  roundsByPrompt: {},
  seenContinuationKeys: [],
  recentModifiedFilesByPrompt: {}
};

export const DEFAULT_MAX_HITL_CONTINUATION_ROUNDS = 10;

export type HitlContinuationDecision =
  | {
      kind: "continue";
      memory: HitlContinuationMemory;
      prompt: string;
      internalSystemNote: string;
      toolReplayMessages: ToolReplayMessage[];
    }
  | {
      kind: "stop";
      memory: HitlContinuationMemory;
      reason: string;
    };

function hasPendingOrRunningActions(plan: OrchestrationPlan): boolean {
  return plan.proposedActions.some((action) => action.status === "pending" || action.status === "running");
}

export function normalizeHitlContinuationMemory(value: unknown): HitlContinuationMemory {
  if (!value || typeof value !== "object") {
    return DEFAULT_HITL_CONTINUATION_MEMORY;
  }

  const record = value as Record<string, unknown>;
  const roundsByPromptRaw = record.roundsByPrompt;
  const seenKeysRaw = record.seenContinuationKeys;
  const recentRaw = record.recentModifiedFilesByPrompt;

  const roundsByPrompt: Record<string, number> = {};
  if (roundsByPromptRaw && typeof roundsByPromptRaw === "object") {
    for (const [key, entry] of Object.entries(roundsByPromptRaw as Record<string, unknown>)) {
      if (!key.trim()) continue;
      if (typeof entry === "number" && Number.isFinite(entry) && entry >= 0) {
        roundsByPrompt[key] = Math.min(100, Math.floor(entry));
      }
      if (Object.keys(roundsByPrompt).length >= 50) break;
    }
  }

  const seenContinuationKeys: string[] = [];
  if (Array.isArray(seenKeysRaw)) {
    for (const entry of seenKeysRaw) {
      if (typeof entry === "string" && entry.trim()) {
        seenContinuationKeys.push(entry.trim().slice(0, 800));
      }
      if (seenContinuationKeys.length >= 80) break;
    }
  }

  const recentModifiedFilesByPrompt: Record<string, string[][]> = {};
  if (recentRaw && typeof recentRaw === "object") {
    for (const [key, entry] of Object.entries(recentRaw as Record<string, unknown>)) {
      if (!key.trim() || !Array.isArray(entry)) continue;
      const rounds: string[][] = [];
      for (const roundEntry of entry) {
        if (!Array.isArray(roundEntry)) continue;
        const files: string[] = [];
        for (const file of roundEntry) {
          if (typeof file === "string" && file.trim()) {
            files.push(file.trim().slice(0, 300));
          }
          if (files.length >= 50) break;
        }
        rounds.push(files);
        if (rounds.length >= 5) break;
      }
      recentModifiedFilesByPrompt[key] = rounds;
      if (Object.keys(recentModifiedFilesByPrompt).length >= 50) break;
    }
  }

  return {
    roundsByPrompt,
    seenContinuationKeys,
    recentModifiedFilesByPrompt
  };
}

function getActionToolName(action: ActionProposal): string {
  return action.toolName || (action.type === "shell" ? "propose_shell" : "propose_file_edit");
}

function getActionToolCallId(action: ActionProposal): string {
  return action.toolCallId || action.id;
}

function ensureFingerprint(action: ActionProposal): string {
  return action.fingerprint ?? actionFingerprint(action);
}

function buildContinuationKey(plan: OrchestrationPlan): string {
  const executedFingerprints = plan.proposedActions
    .filter((action) => action.status === "completed" && action.executed)
    .map((action) => ensureFingerprint(action))
    .sort();
  return `${plan.prompt.trim()}::${executedFingerprints.join(";;")}`;
}

function extractModifiedFilesFromPatch(patch: string): string[] {
  if (/^new file mode/m.test(patch)) {
    return [];
  }
  const matches = patch.match(/^diff --git a\/(.+?) b\//gm) ?? [];
  const files = matches
    .map((match) => match.replace(/^diff --git a\//, "").replace(/ b\/$/, "").trim())
    .filter(Boolean);
  return Array.from(new Set(files)).sort();
}

function extractModifiedFilesFromPlan(plan: OrchestrationPlan): string[] {
  const files = new Set<string>();
  for (const action of plan.proposedActions) {
    if (action.type !== "apply_patch") continue;
    extractModifiedFilesFromPatch(action.payload.patch).forEach((file) => files.add(file));
  }
  return Array.from(files).sort();
}

function wouldThrashSameFiles(
  memory: HitlContinuationMemory,
  promptKey: string,
  currentFiles: string[],
  rounds: number
): boolean {
  if (currentFiles.length === 0 || rounds < 2) {
    return false;
  }

  const prevRounds = memory.recentModifiedFilesByPrompt[promptKey] ?? [];
  if (prevRounds.length === 0) {
    return false;
  }

  const fileCounts = new Map<string, number>();
  for (const roundFiles of prevRounds.slice(-3)) {
    const uniq = new Set(roundFiles);
    for (const file of uniq) {
      fileCounts.set(file, (fileCounts.get(file) ?? 0) + 1);
    }
  }

  return currentFiles.some((file) => (fileCounts.get(file) ?? 0) >= 2);
}

function updateRecentModifiedFiles(
  memory: HitlContinuationMemory,
  promptKey: string,
  currentFiles: string[]
): HitlContinuationMemory {
  const prev = memory.recentModifiedFilesByPrompt[promptKey] ?? [];
  const next = [...prev, currentFiles].slice(-3);
  return {
    ...memory,
    recentModifiedFilesByPrompt: {
      ...memory.recentModifiedFilesByPrompt,
      [promptKey]: next
    }
  };
}

function buildReviewSummarySystemNote(plan: OrchestrationPlan): string {
  const summaryLines = plan.proposedActions.map((action) => {
    if (action.status === "rejected") {
      return `[${action.type}] 用户拒绝了执行。原因：${action.executionResult?.message || "无"}`;
    }
    if (!action.executionResult) {
      return `[${action.type}] 状态异常未执行`;
    }
    const resultLabel = action.executionResult.success ? "成功" : "失败";
    let detailText = action.executionResult.message;

    if (action.type === "apply_patch" && action.executionResult.metadata) {
      const meta = action.executionResult.metadata;
      const files = Array.isArray(meta.files)
        ? meta.files.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        : [];
      if (files.length > 0) {
        const normalizedFiles = files.join("、");
        detailText = action.executionResult.success
          ? `已执行补丁。实际影响文件：${normalizedFiles}`
          : `补丁执行失败。涉及文件：${normalizedFiles}。错误：${action.executionResult.message}`;
      }
    }

    if (action.type === "shell" && action.executionResult.metadata) {
      const meta = action.executionResult.metadata;
      const cmdInfo = [`命令: ${String(meta.command || "")}`];
      if (meta.stdout && String(meta.stdout).trim()) {
        cmdInfo.push(`标准输出:\n${String(meta.stdout).trim()}`);
      }
      if (meta.stderr && String(meta.stderr).trim()) {
        cmdInfo.push(`标准错误:\n${String(meta.stderr).trim()}`);
      }
      cmdInfo.push(`退出码: ${String(meta.status ?? "unknown")}`);
      detailText = cmdInfo.join("\n");
    }

    return `[${action.type}] 执行${resultLabel}。详细信息：\n${detailText}`;
  });

  const completedFiles: string[] = [];
  plan.proposedActions.forEach((action) => {
    if (action.type === "apply_patch" && action.executionResult?.success && action.executionResult.metadata) {
      const meta = action.executionResult.metadata;
      const files = Array.isArray(meta.files)
        ? meta.files.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        : [];
      completedFiles.push(...files);
    }
  });

  const progressInfo = completedFiles.length > 0
    ? `\n\n[进度] 本轮已完成文件：${completedFiles.join("、")}`
    : "";

  return [
    "[系统通知] 计划中的所有审批动作已处理完毕。结果汇总：",
    "",
    summaryLines.join("\n\n"),
    "",
    `原始用户请求："${plan.prompt}"`,
    `请对照原始请求检查是否所有交付物都已完成。如有剩余工作，请继续提出动作；如全部完成，请简短汇报。${progressInfo}`
  ].join("\n");
}

function buildToolReplayMessages(plan: OrchestrationPlan): ToolReplayMessage[] {
  return plan.proposedActions.map((action) => {
    const isSuccess = action.executionResult?.success ?? false;
    const resultObj: Record<string, unknown> = {
      ok: isSuccess,
      action_type: action.type,
      action_id: action.id
    };

    if (isSuccess) {
      if (action.type === "apply_patch") {
        resultObj.message = action.executionResult?.message || "Patch applied successfully";
        const files = action.executionResult?.metadata?.files;
        if (Array.isArray(files) && files.every((value) => typeof value === "string")) {
          resultObj.files = files;
        }
      } else if (action.type === "shell") {
        resultObj.shell = action.payload.shell;
        resultObj.stdout = action.executionResult?.metadata?.stdout;
        resultObj.stderr = action.executionResult?.metadata?.stderr;
        resultObj.exitCode = action.executionResult?.metadata?.status;
      }
    } else {
      resultObj.error = action.executionResult?.message || "Action failed";
    }

    return {
      role: "tool",
      tool_call_id: getActionToolCallId(action),
      name: getActionToolName(action),
      content: JSON.stringify(resultObj)
    };
  });
}

export function decideHitlContinuation(params: {
  plan: OrchestrationPlan;
  memory?: HitlContinuationMemory;
  maxRoundsPerPrompt?: number;
}): HitlContinuationDecision {
  const plan = params.plan;
  const memory = params.memory ?? DEFAULT_HITL_CONTINUATION_MEMORY;
  const maxRounds = Math.max(1, params.maxRoundsPerPrompt ?? DEFAULT_MAX_HITL_CONTINUATION_ROUNDS);

  if (plan.proposedActions.length === 0) {
    return {
      kind: "stop",
      memory,
      reason: "审批结果已同步。LLM 未提出新动作，任务可能已完成。"
    };
  }

  if (hasPendingOrRunningActions(plan)) {
    return {
      kind: "stop",
      memory,
      reason: "动作已执行，还有待审批动作。"
    };
  }

  const promptKey = plan.prompt.trim();
  const rounds = memory.roundsByPrompt[promptKey] ?? 0;
  if (rounds >= maxRounds) {
    return {
      kind: "stop",
      memory,
      reason: `自动续跑轮次已达上限（最多 ${maxRounds} 轮），已停止。如需继续，请手动发送消息。`
    };
  }

  const continuationKey = buildContinuationKey(plan);
  if (memory.seenContinuationKeys.includes(continuationKey)) {
    return {
      kind: "stop",
      memory,
      reason: "检测到重复续跑（相同的执行结果），已自动停止以避免循环。"
    };
  }

  const currentFiles = extractModifiedFilesFromPlan(plan);
  if (wouldThrashSameFiles(memory, promptKey, currentFiles, rounds)) {
    return {
      kind: "stop",
      memory,
      reason: `检测到 LLM 连续修改相同文件（${currentFiles.join(", ")}），可能陷入循环。已停止自动续跑。`
    };
  }

  const nextMemoryBase: HitlContinuationMemory = {
    ...memory,
    roundsByPrompt: {
      ...memory.roundsByPrompt,
      [promptKey]: rounds + 1
    },
    seenContinuationKeys: [...memory.seenContinuationKeys, continuationKey].slice(-80)
  };
  const nextMemory = updateRecentModifiedFiles(nextMemoryBase, promptKey, currentFiles);

  return {
    kind: "continue",
    memory: nextMemory,
    prompt: plan.prompt,
    internalSystemNote: buildReviewSummarySystemNote(plan),
    toolReplayMessages: buildToolReplayMessages(plan)
  };
}
