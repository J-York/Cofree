/**
 * Team routing hooks for future supervisor / dynamic delegation.
 * Fixed pipelines (BUILTIN_TEAMS) stay the default; this module is the extension point.
 */

export interface TeamRoutingSnapshot {
  teamId: string;
  /** Monotonic count of repair-oriented coder stages executed in this run (best-effort). */
  repairRoundsUsed: number;
  stopReason?: string;
}

/**
 * Placeholder decision: today all teams use the static pipeline in `executeAgentTeam`.
 * A future supervisor can return `dynamic_handoff` and route via `task(role=...)` from the parent agent.
 */
export type TeamRoutingDecision =
  | { mode: "builtin_pipeline" }
  | { mode: "dynamic_handoff"; hint?: string };

export function decideTeamRouting(_snapshot: TeamRoutingSnapshot): TeamRoutingDecision {
  return { mode: "builtin_pipeline" };
}

/** Count completed coder stages whose labels look like repair steps (heuristic for metrics/UI). */
export function countRepairStages(
  stageResults: Record<string, { status: string; turnCount: number }>,
): number {
  const labels = [
    "审查问题修复",
    "测试失败修复",
    "修复实现",
  ];
  let n = 0;
  for (const label of labels) {
    const r = stageResults[label];
    if (r && r.status !== "skipped" && r.turnCount > 0) {
      n += 1;
    }
  }
  return n;
}
