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
  if (status === "running") return "badge badge-warning";
  return "badge badge-default";
}

export function canApproveAction(action: ActionProposal): boolean {
  return action.status === "pending" || action.status === "failed";
}

export function canReviewAction(action: ActionProposal): boolean {
  return action.status === "pending" || action.status === "failed";
}
