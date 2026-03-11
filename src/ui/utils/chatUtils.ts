/**
 * Cofree - AI Programming Cafe
 * File: src/ui/utils/chatUtils.ts
 * Milestone: 4
 * Task: 4.1
 * Description: Utility functions extracted from ChatPage for reuse.
 */

import type { ActionProposal } from "../../orchestrator/types";

export function formatTime(isoTime: string): string {
  const ts = new Date(isoTime);
  if (Number.isNaN(ts.getTime())) return "";
  return ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function actionStatusBadgeClass(status: string): string {
  if (status === "completed" || status === "success") return "badge badge-success";
  if (status === "failed" || status === "rejected") return "badge badge-error";
  if (status === "background") return "badge badge-warning";
  if (status === "running" || status === "pending_approval") return "badge badge-warning";
  return "badge badge-default";
}

export function canApproveAction(action: ActionProposal): boolean {
  return action.status === "pending";
}

export function canRetryAction(action: ActionProposal): boolean {
  return action.type === "shell" && action.status === "failed";
}

export function canCancelAction(
  action: ActionProposal,
  hasActiveShellJob: boolean,
): boolean {
  return (
    action.type === "shell" &&
    (action.status === "running" || action.status === "background") &&
    hasActiveShellJob
  );
}

export function canReviewAction(action: ActionProposal): boolean {
  return action.status === "pending" || action.status === "failed";
}
