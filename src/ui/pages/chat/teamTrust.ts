import type { OrchestrationPlan, ActionProposal } from "../../../orchestrator/types";
import type { ChatMessageRecord } from "../../../lib/chatHistoryStore";
import type { WorkspaceTeamTrustMode } from "../../../lib/workspaceTeamTrustStore";
import { workspaceHash } from "../../../lib/workspaceStorage";

export type WorkspaceTeamTrustDecisionKind =
  | "manual"
  | "yolo"
  | "prompt_first_run"
  | "disabled_no_workspace";

export interface WorkspaceTeamTrustDecision {
  kind: WorkspaceTeamTrustDecisionKind;
  teamActionIds: string[];
}

export type WorkspaceTeamTrustMessageAction =
  | { kind: "none" }
  | { kind: "prompt"; messageId: string; teamActionIds: string[]; promptKey: string }
  | { kind: "yolo"; messageId: string; teamActionIds: string[] };

const YOLO_ELIGIBLE_ACTION_TYPES = new Set<ActionProposal["type"]>([
  "shell",
  "apply_patch",
]);

export function parseTeamIdFromOriginDetail(originDetail?: string): string | null {
  if (typeof originDetail !== "string") {
    return null;
  }

  const normalized = originDetail.trim();
  if (!normalized) {
    return null;
  }

  const separatorIndex = normalized.indexOf(" / ");
  const teamId =
    separatorIndex >= 0 ? normalized.slice(0, separatorIndex).trim() : normalized;

  return teamId || null;
}

export function isExpertTeamAction(
  action: Pick<ActionProposal, "type" | "origin" | "originDetail" | "gateRequired">,
): boolean {
  if (action.origin !== "team_stage") {
    return false;
  }
  if (!action.gateRequired || !YOLO_ELIGIBLE_ACTION_TYPES.has(action.type)) {
    return false;
  }

  const teamId = parseTeamIdFromOriginDetail(action.originDetail);
  return Boolean(teamId && teamId.startsWith("team-"));
}

export function collectPendingExpertTeamActionIds(
  plan: Pick<OrchestrationPlan, "proposedActions">,
): string[] {
  return plan.proposedActions
    .filter((action) => action.status === "pending" && isExpertTeamAction(action))
    .map((action) => action.id);
}

/** Pending shell/patch from team pipeline or delegated sub-agent (orchestration). */
export function isOrchestrationAction(
  action: Pick<ActionProposal, "type" | "origin" | "gateRequired">,
): boolean {
  if (action.origin !== "team_stage" && action.origin !== "sub_agent") {
    return false;
  }
  if (!action.gateRequired || !YOLO_ELIGIBLE_ACTION_TYPES.has(action.type)) {
    return false;
  }
  return true;
}

export function collectPendingOrchestrationActionIds(
  plan: Pick<OrchestrationPlan, "proposedActions">,
): string[] {
  return plan.proposedActions
    .filter((action) => action.status === "pending" && isOrchestrationAction(action))
    .map((action) => action.id);
}

/** All pending gated shell/patch actions on the plan (any origin), for YOLO auto-approve batch. */
export function collectAllPendingYoloActionIds(
  plan: Pick<OrchestrationPlan, "proposedActions">,
): string[] {
  return plan.proposedActions
    .filter(
      (action) =>
        action.status === "pending" &&
        action.gateRequired &&
        YOLO_ELIGIBLE_ACTION_TYPES.has(action.type),
    )
    .map((action) => action.id);
}

export function resolveWorkspaceTeamTrustDecision(params: {
  workspacePath?: string;
  mode: WorkspaceTeamTrustMode | null;
  plan: Pick<OrchestrationPlan, "proposedActions">;
}): WorkspaceTeamTrustDecision {
  const orchestrationActionIds = collectPendingOrchestrationActionIds(params.plan);
  if (orchestrationActionIds.length === 0) {
    return {
      kind: "manual",
      teamActionIds: [],
    };
  }

  const allYoloActionIds = collectAllPendingYoloActionIds(params.plan);

  if (!params.workspacePath?.trim()) {
    return {
      kind: "disabled_no_workspace",
      teamActionIds: allYoloActionIds,
    };
  }

  if (params.mode === "team_yolo") {
    return {
      kind: "yolo",
      teamActionIds: allYoloActionIds,
    };
  }

  if (params.mode === "team_manual") {
    return {
      kind: "manual",
      teamActionIds: allYoloActionIds,
    };
  }

  return {
    kind: "prompt_first_run",
    teamActionIds: allYoloActionIds,
  };
}

export function getWorkspaceTeamTrustModeLabel(
  mode: WorkspaceTeamTrustMode | null,
): string {
  if (mode === "team_yolo") {
    return "YOLO";
  }
  if (mode === "team_manual") {
    return "审批";
  }
  return "未设置（首次进入编排时询问）";
}

export function buildWorkspaceTeamTrustPromptKey(
  workspacePath?: string,
): string | null {
  const normalized = workspacePath?.trim();
  if (!normalized) {
    return null;
  }
  return `workspace-team-trust:${workspaceHash(normalized)}`;
}

export function shouldOpenWorkspaceTeamTrustPrompt(params: {
  decision: WorkspaceTeamTrustDecision;
  workspacePath?: string;
  activePromptKey?: string | null;
  restoredPromptKey?: string | null;
}): boolean {
  if (params.decision.kind !== "prompt_first_run") {
    return false;
  }

  const promptKey = buildWorkspaceTeamTrustPromptKey(params.workspacePath);
  if (!promptKey) {
    return false;
  }

  return (
    params.activePromptKey !== promptKey &&
    params.restoredPromptKey !== promptKey
  );
}

export function resolveWorkspaceTeamTrustMessageAction(params: {
  message: Pick<ChatMessageRecord, "id" | "plan"> | null;
  workspacePath?: string;
  mode: WorkspaceTeamTrustMode | null;
  activePromptKey?: string | null;
  restoredPromptKey?: string | null;
}): WorkspaceTeamTrustMessageAction {
  if (!params.message?.plan) {
    return { kind: "none" };
  }

  const decision = resolveWorkspaceTeamTrustDecision({
    workspacePath: params.workspacePath,
    mode: params.mode,
    plan: params.message.plan,
  });

  if (decision.kind === "yolo") {
    return {
      kind: "yolo",
      messageId: params.message.id,
      teamActionIds: decision.teamActionIds,
    };
  }

  if (
    shouldOpenWorkspaceTeamTrustPrompt({
      decision,
      workspacePath: params.workspacePath,
      activePromptKey: params.activePromptKey,
      restoredPromptKey: params.restoredPromptKey,
    })
  ) {
    const promptKey = buildWorkspaceTeamTrustPromptKey(params.workspacePath);
    if (!promptKey) {
      return { kind: "none" };
    }
    return {
      kind: "prompt",
      messageId: params.message.id,
      teamActionIds: decision.teamActionIds,
      promptKey,
    };
  }

  return { kind: "none" };
}
