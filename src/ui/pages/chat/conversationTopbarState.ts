import type { OrchestrationPlan, SubAgentProgressEvent } from "../../../orchestrator/types";
import type { LiveToolCall, SubAgentStatusItem } from "./types";

export type ConversationTopbarMode = "idle" | "single_agent" | "orchestrating";

export type ConversationTopbarAttentionLevel = "info" | "warning" | "blocked";

export interface ConversationTopbarBadge {
  key: string;
  label: string;
  tone?: "default" | "info" | "warning" | "blocked" | "success";
  action?: "tools" | "parallel" | "ask_user" | "context";
  disabled?: boolean;
}

export interface ConversationTopbarProgress {
  visible: boolean;
  label?: string;
  current?: number;
  total?: number;
  segments?: Array<"completed" | "active" | "pending" | "blocked">;
  disabled?: boolean;
}

export interface ConversationTopbarAttention {
  visible: boolean;
  level: ConversationTopbarAttentionLevel;
  message: string;
  ctaLabel?: string;
  ctaAction?: "approval" | "blocked_output" | "ask_user" | "restore";
  extraCount?: number;
  ctaDisabled?: boolean;
}

export interface ConversationTopbarState {
  mode: ConversationTopbarMode;
  source: "idle" | "assistant" | "tools" | "team";
  primaryLabel: string;
  agentLabel: string;
  badges: ConversationTopbarBadge[];
  progress: ConversationTopbarProgress;
  attention: ConversationTopbarAttention | null;
}

type AttentionKind = "blocked" | "ask_user" | "approval" | "restore" | "informational";

type DeriveInput = {
  agentLabel: string;
  isStreaming: boolean;
  liveToolCalls: LiveToolCall[];
  subAgentStatus: SubAgentStatusItem[];
  activePlan: OrchestrationPlan | null;
  hasAskUserPending: boolean;
  hasRestoreNotice: boolean;
  sessionNote: string;
};

function pickLatestEvent(items: SubAgentStatusItem[]): SubAgentProgressEvent | null {
  const trustedItems = items.filter((item) => hasOrchestrationStatusSignal(item.lastEvent));
  if (trustedItems.length === 0) return null;
  return [...trustedItems].sort((x, y) => y.updatedAt - x.updatedAt)[0]!.lastEvent;
}

function countPendingApprovals(plan: OrchestrationPlan | null): number {
  if (!plan || plan.state !== "human_review") return 0;
  return plan.proposedActions.filter((a) => a.status === "pending").length;
}

function hasFailedOrBlockedSteps(plan: OrchestrationPlan | null): boolean {
  if (!plan) return false;
  return plan.steps.some((s) => s.status === "failed" || s.status === "blocked");
}

function hasFailedProposals(plan: OrchestrationPlan | null): boolean {
  if (!plan) return false;
  return plan.proposedActions.some((a) => a.status === "failed");
}

function hasSubAgentFailureSignal(items: SubAgentStatusItem[]): boolean {
  return items.some(
    (item) =>
      item.lastEvent.kind === "stage_complete" &&
      (item.lastEvent.stageStatus === "failed" || item.lastEvent.stageStatus === "blocked"),
  );
}

function isInterruptedOrchestration(input: DeriveInput): boolean {
  const { activePlan } = input;
  if (!activePlan || activePlan.state !== "executing") return false;
  return hasFailedProposals(activePlan) || hasSubAgentFailureSignal(input.subAgentStatus);
}

function hasBlockedSignal(input: DeriveInput): boolean {
  return (
    isInterruptedOrchestration(input) ||
    hasFailedOrBlockedSteps(input.activePlan) ||
    hasFailedProposals(input.activePlan) ||
    hasSubAgentFailureSignal(input.subAgentStatus)
  );
}

function hasOrchestrationPlanSignal(plan: OrchestrationPlan | null): boolean {
  if (!plan) {
    return false;
  }
  return plan.proposedActions.some(
    (action) => action.origin === "sub_agent" || action.origin === "team_stage",
  );
}

/** Same bounds as trustworthy progress: avoids treating loose counters as team runtime. */
function hasTrustworthyStageIndexPair(event: SubAgentProgressEvent): boolean {
  const total = event.totalStages;
  const cur = event.currentStageIndex;
  return (
    typeof total === "number" &&
    total > 0 &&
    typeof cur === "number" &&
    cur >= 1 &&
    cur <= total
  );
}

function hasOrchestrationStatusSignal(event: SubAgentProgressEvent): boolean {
  if (event.kind === "stage_complete" || event.kind === "team_checkpoint") {
    return true;
  }
  if (event.teamId?.trim()) {
    return true;
  }
  if (event.stageLabel?.trim()) {
    return true;
  }
  return hasTrustworthyStageIndexPair(event);
}

function isOrchestratingContext(input: DeriveInput): boolean {
  return (
    input.subAgentStatus.some((item) => hasOrchestrationStatusSignal(item.lastEvent)) ||
    hasOrchestrationPlanSignal(input.activePlan)
  );
}

function hasUnresolvedPlanActivity(plan: OrchestrationPlan | null): boolean {
  if (!plan) {
    return false;
  }
  return plan.state !== "done";
}

function isCompletedWorkflow(input: DeriveInput): boolean {
  return isOrchestratingContext(input) && input.activePlan?.state === "done";
}

function readTrustworthyNumeric(
  ev: SubAgentProgressEvent | null,
  interrupted: boolean,
): {
  current: number;
  total: number;
  completedStageCount: number;
  activeParallelCount?: number;
} | null {
  if (interrupted || !ev) return null;
  const total = ev.totalStages;
  const cur = ev.currentStageIndex;
  if (typeof total !== "number" || total <= 0 || typeof cur !== "number" || cur < 1 || cur > total) {
    return null;
  }
  return {
    current: cur,
    total,
    completedStageCount: typeof ev.completedStageCount === "number" ? ev.completedStageCount : 0,
    activeParallelCount:
      typeof ev.activeParallelCount === "number" && ev.activeParallelCount > 0
        ? ev.activeParallelCount
        : undefined,
  };
}

function blockedStageIndices(plan: OrchestrationPlan | null): Set<number> {
  const out = new Set<number>();
  if (!plan) return out;
  plan.steps.forEach((step, idx) => {
    if (step.status === "failed" || step.status === "blocked") {
      out.add(idx + 1);
    }
  });
  return out;
}

function buildProgressSegments(params: {
  total: number;
  currentStageIndex: number;
  activeParallelCount: number;
  blockedOneBased: Set<number>;
}): Array<"completed" | "active" | "pending" | "blocked"> {
  const { total, currentStageIndex, activeParallelCount, blockedOneBased } = params;
  const segs: Array<"completed" | "active" | "pending" | "blocked"> = [];
  for (let i = 1; i <= total; i += 1) {
    let seg: "completed" | "active" | "pending" | "blocked";
    if (i < currentStageIndex) {
      seg = "completed";
    } else if (i < currentStageIndex + activeParallelCount) {
      seg = "active";
    } else {
      seg = "pending";
    }
    if (blockedOneBased.has(i)) {
      seg = "blocked";
    }
    segs.push(seg);
  }
  return segs;
}

function primaryStageLabelFromEvent(ev: SubAgentProgressEvent | null): string | undefined {
  const label = ev?.stageLabel?.trim();
  return label || undefined;
}

function shouldDegradeThinkingPrimary(ev: SubAgentProgressEvent | null): boolean {
  if (!ev || ev.kind !== "thinking") return false;
  const total = ev.totalStages;
  const cur = ev.currentStageIndex;
  return !(
    typeof total === "number" &&
    total > 0 &&
    typeof cur === "number" &&
    cur >= 1 &&
    cur <= total
  );
}

function deriveMode(input: DeriveInput, attentionKinds: AttentionKind[]): ConversationTopbarMode {
  if (isOrchestratingContext(input)) {
    return "orchestrating";
  }
  // Any attention candidate (e.g. trimmed sessionNote → informational) keeps the topbar off idle
  // so row-3 attention can render; primary row may still read "已就绪" for note-only cases.
  if (
    hasUnresolvedPlanActivity(input.activePlan) ||
    input.isStreaming ||
    input.liveToolCalls.length > 0 ||
    input.hasAskUserPending ||
    attentionKinds.length > 0
  ) {
    return "single_agent";
  }
  return "idle";
}

function deriveSource(mode: ConversationTopbarMode, liveToolCalls: LiveToolCall[]): ConversationTopbarState["source"] {
  if (mode === "idle") return "idle";
  if (mode === "orchestrating") return "team";
  return liveToolCalls.length > 0 ? "tools" : "assistant";
}

type AttentionCandidate = {
  kind: AttentionKind;
  level: ConversationTopbarAttentionLevel;
  message: string;
  ctaLabel?: string;
  ctaAction?: ConversationTopbarAttention["ctaAction"];
};

/** Latest `stage_complete` by `updatedAt` among sub-agent rows (same ordering as historical inline sorts). */
function pickLatestStageCompleteEvent(items: SubAgentStatusItem[]): SubAgentProgressEvent | undefined {
  const matches = items.filter((item) => item.lastEvent.kind === "stage_complete");
  if (matches.length === 0) return undefined;
  matches.sort((a, b) => b.updatedAt - a.updatedAt);
  return matches[0]!.lastEvent;
}

function collectAttentionCandidates(input: DeriveInput, pendingApprovalCount: number): AttentionCandidate[] {
  const candidates: AttentionCandidate[] = [];

  if (hasBlockedSignal(input)) {
    const stageFromEvent = pickLatestStageCompleteEvent(input.subAgentStatus);
    const failedOrBlockedStep = input.activePlan?.steps.find(
      (s) => s.status === "failed" || s.status === "blocked",
    );
    const msg =
      stageFromEvent && stageFromEvent.kind === "stage_complete"
        ? `阻塞：${stageFromEvent.stageLabel} 阶段失败`
        : failedOrBlockedStep?.title
          ? `阻塞：${failedOrBlockedStep.title}`
          : "阻塞：编排执行失败";
    candidates.push({
      kind: "blocked",
      level: "blocked",
      message: msg,
      ctaLabel: "查看失败输出",
      ctaAction: "blocked_output",
    });
  }

  if (input.hasAskUserPending) {
    candidates.push({
      kind: "ask_user",
      level: "warning",
      message: "等待你的输入以继续回复",
      ctaLabel: "继续回答",
      ctaAction: "ask_user",
    });
  }

  if (pendingApprovalCount > 0) {
    candidates.push({
      kind: "approval",
      level: "warning",
      message: `提醒：有 ${pendingApprovalCount} 个动作待你审批`,
      ctaLabel: "查看待审批",
      ctaAction: "approval",
    });
  }

  if (input.hasRestoreNotice) {
    candidates.push({
      kind: "restore",
      level: "info",
      message: "已恢复到上次进度",
      ctaLabel: "知道了",
      ctaAction: "restore",
    });
  }

  // Session notes are non-team UI hints; omit while restoring or during team orchestration
  // (orchestrating mode + row-2 progress already carry context).
  const note = input.sessionNote.trim();
  if (note && !input.hasRestoreNotice && !isOrchestratingContext(input)) {
    candidates.push({
      kind: "informational",
      level: "info",
      message: note,
    });
  }

  return candidates;
}

const ATTENTION_KIND_PRIORITY: Record<AttentionKind, number> = {
  blocked: 0,
  ask_user: 1,
  approval: 2,
  restore: 3,
  informational: 4,
};

function pickAttentionCandidate(candidates: AttentionCandidate[]): ConversationTopbarAttention | null {
  if (candidates.length === 0) return null;
  const ordered = [...candidates].sort(
    (a, b) => ATTENTION_KIND_PRIORITY[a.kind] - ATTENTION_KIND_PRIORITY[b.kind],
  );
  const main = ordered[0]!;
  const extra = ordered.length - 1;
  return {
    visible: true,
    level: main.level,
    message: main.message,
    ctaLabel: main.ctaLabel,
    ctaAction: main.ctaAction,
    extraCount: extra > 0 ? extra : undefined,
  };
}

function buildBadges(params: {
  input: DeriveInput;
  mode: ConversationTopbarMode;
  completed: boolean;
  numeric: ReturnType<typeof readTrustworthyNumeric>;
}): ConversationTopbarBadge[] {
  const { input, mode, completed, numeric } = params;
  const badges: ConversationTopbarBadge[] = [];

  if (!completed && input.liveToolCalls.length > 0) {
    badges.push({
      key: "tools",
      label: `工具 ${input.liveToolCalls.length}`,
      action: "tools",
      tone: "default",
    });
  }

  if (
    mode === "orchestrating" &&
    !completed &&
    numeric &&
    typeof numeric.activeParallelCount === "number" &&
    numeric.activeParallelCount > 1
  ) {
    badges.push({
      key: "parallel",
      label: `并行 ${numeric.activeParallelCount}`,
      action: "parallel",
      tone: "default",
    });
  }

  if (completed && numeric) {
    badges.push({
      key: "completion",
      label: `${numeric.total}/${numeric.total}`,
      tone: "success",
    });
  }

  return badges;
}

function derivePrimaryLabel(params: {
  input: DeriveInput;
  mode: ConversationTopbarMode;
  interrupted: boolean;
  completed: boolean;
  latest: SubAgentProgressEvent | null;
  numeric: ReturnType<typeof readTrustworthyNumeric>;
}): string {
  const { input, mode, interrupted, completed, latest, numeric } = params;
  const { isStreaming, liveToolCalls } = input;

  if (mode === "idle") {
    return "已就绪";
  }

  if (mode === "single_agent") {
    if (liveToolCalls.length > 0) {
      const name = liveToolCalls[0]!.toolName;
      return `正在使用 ${name}`;
    }
    if (isStreaming) {
      return "正在回答";
    }
    if (hasUnresolvedPlanActivity(input.activePlan)) {
      return "正在处理";
    }
    return "已就绪";
  }

  // orchestrating
  if (completed) {
    return "本轮编排已完成";
  }

  if (interrupted) {
    const stage =
      primaryStageLabelFromEvent(pickLatestStageCompleteEvent(input.subAgentStatus) ?? latest) ??
      primaryStageLabelFromEvent(latest);
    if (stage) {
      return `上次阶段：${stage}`;
    }
    return "编排已中断";
  }

  const stageLabel = primaryStageLabelFromEvent(latest);
  if (shouldDegradeThinkingPrimary(latest)) {
    return "正在编排";
  }

  if (numeric && stageLabel) {
    return `当前：${stageLabel}`;
  }

  return "正在编排";
}

function deriveProgress(params: {
  input: DeriveInput;
  mode: ConversationTopbarMode;
  interrupted: boolean;
  completed: boolean;
  latest: SubAgentProgressEvent | null;
  numeric: ReturnType<typeof readTrustworthyNumeric>;
  primaryLabel: string;
}): ConversationTopbarProgress {
  const { input, mode, interrupted, completed, latest, numeric, primaryLabel } = params;

  if (mode !== "orchestrating") {
    return { visible: false };
  }

  if (interrupted) {
    return { visible: false };
  }

  if (completed) {
    if (!numeric) {
      return { visible: false };
    }
    return {
      visible: true,
      current: numeric.total,
      total: numeric.total,
      label: `${numeric.total}/${numeric.total}`,
      segments: Array.from({ length: numeric.total }, () => "completed" as const),
    };
  }

  if (numeric) {
    const blocked = blockedStageIndices(input.activePlan);
    return {
      visible: true,
      current: numeric.current,
      total: numeric.total,
      label: `${numeric.current}/${numeric.total}`,
      segments:
        typeof numeric.activeParallelCount === "number"
          ? buildProgressSegments({
              total: numeric.total,
              currentStageIndex: numeric.current,
              activeParallelCount: numeric.activeParallelCount,
              blockedOneBased: blocked,
            })
          : undefined,
    };
  }

  const stageHint = primaryStageLabelFromEvent(latest);
  const fallback = stageHint ? `阶段推进中（${stageHint}）` : "阶段正按计划推进";
  return {
    visible: true,
    label: fallback === primaryLabel ? "编排活动进行中" : fallback,
  };
}

export function deriveConversationTopbarState(input: DeriveInput): ConversationTopbarState {
  const pendingApprovalCount = countPendingApprovals(input.activePlan);
  const latest = pickLatestEvent(input.subAgentStatus);
  const interrupted = isInterruptedOrchestration(input);
  const completed = isCompletedWorkflow(input);
  const numeric = readTrustworthyNumeric(latest, interrupted);

  const candidates = collectAttentionCandidates(input, pendingApprovalCount);
  const attentionKinds = candidates.map((c) => c.kind);
  const mode = deriveMode(input, attentionKinds);
  const source = deriveSource(mode, input.liveToolCalls);

  const primaryLabel = derivePrimaryLabel({
    input,
    mode,
    interrupted,
    completed,
    latest,
    numeric,
  });

  const progress = deriveProgress({
    input,
    mode,
    interrupted,
    completed,
    latest,
    numeric,
    primaryLabel,
  });

  const badges = buildBadges({
    input,
    mode,
    completed,
    numeric,
  });

  const attentionPick = mode === "idle" ? null : pickAttentionCandidate(candidates);

  return {
    mode,
    source,
    primaryLabel,
    agentLabel: input.agentLabel,
    badges,
    progress,
    attention: attentionPick,
  };
}
