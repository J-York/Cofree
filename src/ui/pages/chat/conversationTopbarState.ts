import type { OrchestrationPlan } from "../../../orchestrator/types";
import type { LiveToolCall } from "./types";

export type ConversationTopbarMode = "idle" | "active";

export type ConversationTopbarAttentionLevel = "info" | "warning" | "blocked";

export interface ConversationTopbarBadge {
  key: string;
  label: string;
  tone?: "default" | "info" | "warning" | "blocked" | "success";
  action?: "tools" | "ask_user" | "context";
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
  source: "idle" | "assistant" | "tools";
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
  activePlan: OrchestrationPlan | null;
  hasAskUserPending: boolean;
  hasRestoreNotice: boolean;
  sessionNote: string;
};

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

function isInterruptedPlan(input: DeriveInput): boolean {
  const { activePlan } = input;
  if (!activePlan || activePlan.state !== "executing") return false;
  return hasFailedProposals(activePlan);
}

function hasBlockedSignal(input: DeriveInput): boolean {
  return (
    isInterruptedPlan(input) ||
    hasFailedOrBlockedSteps(input.activePlan) ||
    hasFailedProposals(input.activePlan)
  );
}

function hasUnresolvedPlanActivity(plan: OrchestrationPlan | null): boolean {
  if (!plan) {
    return false;
  }
  return plan.state !== "done";
}

function deriveMode(input: DeriveInput, attentionKinds: AttentionKind[]): ConversationTopbarMode {
  if (
    hasUnresolvedPlanActivity(input.activePlan) ||
    input.isStreaming ||
    input.liveToolCalls.length > 0 ||
    input.hasAskUserPending ||
    attentionKinds.length > 0
  ) {
    return "active";
  }
  return "idle";
}

function deriveSource(mode: ConversationTopbarMode, liveToolCalls: LiveToolCall[]): ConversationTopbarState["source"] {
  if (mode === "idle") return "idle";
  return liveToolCalls.length > 0 ? "tools" : "assistant";
}

type AttentionCandidate = {
  kind: AttentionKind;
  level: ConversationTopbarAttentionLevel;
  message: string;
  ctaLabel?: string;
  ctaAction?: ConversationTopbarAttention["ctaAction"];
};

function collectAttentionCandidates(input: DeriveInput, pendingApprovalCount: number): AttentionCandidate[] {
  const candidates: AttentionCandidate[] = [];

  if (hasBlockedSignal(input)) {
    const failedOrBlockedStep = input.activePlan?.steps.find(
      (s) => s.status === "failed" || s.status === "blocked",
    );
    const msg = failedOrBlockedStep?.title
      ? `阻塞：${failedOrBlockedStep.title}`
      : "阻塞：执行失败";
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

  const note = input.sessionNote.trim();
  if (note && !input.hasRestoreNotice) {
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
}): ConversationTopbarBadge[] {
  const { input, mode } = params;
  const badges: ConversationTopbarBadge[] = [];

  if (mode !== "idle" && input.liveToolCalls.length > 0) {
    badges.push({
      key: "tools",
      label: `工具 ${input.liveToolCalls.length}`,
      action: "tools",
      tone: "default",
    });
  }

  return badges;
}

function derivePrimaryLabel(params: {
  input: DeriveInput;
  mode: ConversationTopbarMode;
  interrupted: boolean;
}): string {
  const { input, mode, interrupted } = params;
  const { isStreaming, liveToolCalls } = input;

  if (mode === "idle") {
    return "已就绪";
  }

  // active mode
  if (liveToolCalls.length > 0) {
    const name = liveToolCalls[0]!.toolName;
    return `正在使用 ${name}`;
  }
  if (isStreaming) {
    return "正在回答";
  }
  if (interrupted) {
    return "执行已中断";
  }
  if (hasUnresolvedPlanActivity(input.activePlan)) {
    return "正在处理";
  }
  return "已就绪";
}

function deriveProgress(_params: {
  mode: ConversationTopbarMode;
}): ConversationTopbarProgress {
  return { visible: false };
}

export function deriveConversationTopbarState(input: DeriveInput): ConversationTopbarState {
  const pendingApprovalCount = countPendingApprovals(input.activePlan);
  const interrupted = isInterruptedPlan(input);

  const candidates = collectAttentionCandidates(input, pendingApprovalCount);
  const attentionKinds = candidates.map((c) => c.kind);
  const mode = deriveMode(input, attentionKinds);
  const source = deriveSource(mode, input.liveToolCalls);

  const primaryLabel = derivePrimaryLabel({
    input,
    mode,
    interrupted,
  });

  const progress = deriveProgress({ mode });

  const badges = buildBadges({ input, mode });

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