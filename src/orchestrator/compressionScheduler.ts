/**
 * Scheduling state & decisions for context-compression and summarization.
 *
 * - Dynamic cooldown per workspace, derived from token growth rate.
 * - Summary-attempt rate-limiting (canSummarizeNow / markSummarizedNow).
 * - Safe-zone check that short-circuits the compression pipeline when the
 *   prompt is well under budget.
 *
 * Module-level Maps persist across sessions within a process; entries are
 * capped/evicted to avoid unbounded growth.
 */

import type { LiteLLMMessage } from "../lib/piAiBridge";
import type { MessageTokenTracker } from "./contextBudget";

const BASE_SUMMARY_COOLDOWN_MS = 120 * 1000;
const MAX_TRACKED_WORKSPACES = 20;
const TRACKER_STALE_MS = 30 * 60 * 1000; // evict entries idle for >30 min

// P2-2: Dynamic cooldown state — tracks token growth to adjust cooldown.
// Capped at MAX_TRACKED_WORKSPACES to prevent unbounded memory growth.
const tokenGrowthTracker = new Map<
  string,
  { timestamps: number[]; tokenCounts: number[] }
>();

// Cooldown is per workspace to reduce oscillation on retries.
const lastSummaryAtMsByWorkspace = new Map<string, number>();

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

function computeDynamicCooldownMs(
  workspacePath: string | undefined,
  currentTokens: number,
): number {
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

  if (growthRate > 500) return 45_000;
  if (growthRate > 200) return 60_000;
  return BASE_SUMMARY_COOLDOWN_MS;
}

export function canSummarizeNow(
  workspacePath: string | undefined,
  currentTokens?: number,
): boolean {
  const ws = workspacePath?.trim() || "";
  if (!ws) return true;
  const last = lastSummaryAtMsByWorkspace.get(ws) ?? 0;
  // P2-2: Use dynamic cooldown based on token growth rate.
  const cooldown = computeDynamicCooldownMs(workspacePath, currentTokens ?? 0);
  return Date.now() - last >= cooldown;
}

export function markSummarizedNow(workspacePath: string | undefined): void {
  const ws = workspacePath?.trim() || "";
  if (!ws) return;
  lastSummaryAtMsByWorkspace.set(ws, Date.now());
}

export function evaluateCompressionSafeZone(params: {
  tokenTracker: MessageTokenTracker;
  messages: LiteLLMMessage[];
  promptBudgetTarget: number;
  safeZoneRatio: number;
}): {
  currentTokens: number;
  compressionSafeZone: number;
  skipCompression: boolean;
} {
  const currentTokens = params.tokenTracker.update(params.messages);
  const compressionSafeZone = params.promptBudgetTarget * params.safeZoneRatio;
  return {
    currentTokens,
    compressionSafeZone,
    skipCompression: currentTokens <= compressionSafeZone,
  };
}
