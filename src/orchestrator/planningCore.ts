import type { AppSettings } from "../lib/settingsStore";
import type {
  ActionProposal,
  ApplyPatchActionProposal,
  OrchestrationPlan,
} from "./types";
import {
  derivePlanWorkflowState,
  syncPlanStateWithActions,
  type TodoPlanState,
} from "./todoPlanState";
import { hashText } from "./summarization";

export function estimateRequestedArtifactCount(prompt: string): number {
  const normalized = prompt.trim();
  if (!normalized) {
    return 0;
  }

  const chineseNumWordMap: Record<string, number> = {
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };
  const cnNumMatch = normalized.match(/([二两三四五六七八九十]|\d+)\s*个\s*文件/);
  if (cnNumMatch) {
    const raw = cnNumMatch[1];
    const parsed = chineseNumWordMap[raw] ?? Number(raw);
    if (parsed >= 2) return parsed;
  }

  const enNumMatch = normalized.match(/(\d+)\s+(?:separate\s+|distinct\s+|new\s+)?files?\b/i);
  if (enNumMatch) {
    const parsed = Number(enNumMatch[1]);
    if (parsed >= 2) return parsed;
  }

  const splitMatch = normalized.match(/拆分[成为]?\s*(.+)/);
  if (splitMatch) {
    const tail = splitMatch[1];
    const parts = tail
      .split(/[、，,\s+和and]+/i)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length >= 2) return parts.length;
  }

  if (
    /(完整.{0,4}(前端|网页|页面)|完整的前端|完整前端|complete\s+(frontend|web\s*page)|full\s+(frontend|web\s*app))/i.test(
      normalized
    )
  ) {
    return 3;
  }

  const segments = normalized
    .split(/(?:\s+and\s+|\s+plus\s+|以及|并且|还有|和|，|,|；|;|、)/i)
    .map((segment) => segment.trim())
    .filter(Boolean);

  const artifactPattern =
    /(?:\.py\b|\.html\b|\.css\b|\.js\b|\.jsx\b|\.ts\b|\.tsx\b|\.json\b|python|html|css|javascript|typescript|脚本|页面|网页|文件)/i;
  const explicitCount = segments.filter((segment) => artifactPattern.test(segment)).length;
  if (explicitCount > 0) {
    return explicitCount;
  }

  return artifactPattern.test(normalized) ? 1 : 0;
}

export function collectPatchedFiles(patch: string): string[] {
  const files = new Set<string>();
  for (const rawLine of patch.split(/\r?\n/)) {
    const line = rawLine.trim();
    const diffMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (diffMatch) {
      if (diffMatch[1] && diffMatch[1] !== "/dev/null") {
        files.add(diffMatch[1]);
      }
      if (diffMatch[2] && diffMatch[2] !== "/dev/null") {
        files.add(diffMatch[2]);
      }
      continue;
    }

    const plusMatch = line.match(/^\+\+\+\s+b\/(.+)$/);
    if (plusMatch?.[1]) {
      files.add(plusMatch[1]);
    }
  }

  return Array.from(files);
}

function applyPatchTargetsAreDisjointForBatching(
  patchActions: ApplyPatchActionProposal[],
): boolean {
  if (patchActions.length <= 1) {
    return true;
  }
  const pathCounts = new Map<string, number>();
  for (const action of patchActions) {
    const files = collectPatchedFiles(action.payload.patch)
      .map((file) => file.trim())
      .filter(Boolean);
    if (files.length === 0) {
      return false;
    }
    const uniqInPatch = new Set(files);
    for (const file of uniqInPatch) {
      pathCounts.set(file, (pathCounts.get(file) ?? 0) + 1);
    }
  }
  for (const count of pathCounts.values()) {
    if (count > 1) {
      return false;
    }
  }
  return true;
}

export function countPlannedArtifacts(actions: ActionProposal[]): number {
  const artifacts = new Set<string>();

  for (const action of actions) {
    if (action.type === "apply_patch") {
      const patchFiles = collectPatchedFiles(action.payload.patch);
      if (patchFiles.length > 0) {
        patchFiles.forEach((file) => artifacts.add(`file:${file}`));
        continue;
      }
    }

    artifacts.add(`action:${action.id}`);
  }

  return artifacts.size;
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function detectPatchOperationKinds(patch: string): string[] {
  const kinds = new Set<string>();
  for (const rawLine of patch.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("new file mode ")) {
      kinds.add("create");
      continue;
    }
    if (line.startsWith("deleted file mode ")) {
      kinds.add("delete");
      continue;
    }
    if (line.startsWith("rename from ") || line.startsWith("rename to ")) {
      kinds.add("rename");
      continue;
    }
    if (line.startsWith("@@")) {
      kinds.add("modify");
    }
  }
  if (!kinds.size) {
    kinds.add("modify");
  }
  return Array.from(kinds).sort();
}

export function initializePlan(
  prompt: string,
  settings: AppSettings,
  proposedActions: ActionProposal[],
  planState: TodoPlanState,
): OrchestrationPlan {
  const normalizedPlanState = syncPlanStateWithActions(planState, proposedActions);
  return {
    state: derivePlanWorkflowState(proposedActions, normalizedPlanState),
    prompt: prompt.trim() || "实现用户提出的功能",
    steps: normalizedPlanState.steps,
    activeStepId: normalizedPlanState.activeStepId,
    proposedActions,
    workspacePath: settings.workspacePath.trim(),
  };
}

export function actionFingerprint(action: ActionProposal): string {
  if (action.type === "apply_patch") {
    const normalizedPatch = normalizeWhitespace(action.payload.patch);
    const patchHash = hashText(normalizedPatch);
    const files = collectPatchedFiles(action.payload.patch)
      .map((file) => file.trim())
      .filter(Boolean)
      .sort();
    const operationKinds = detectPatchOperationKinds(action.payload.patch);

    const context =
      files.length > 0
        ? `${operationKinds.join(",")}:${files.join("|")}`
        : "raw";
    return `${action.type}:${context}:${patchHash}`;
  }

  const normalizedShell = normalizeWhitespace(action.payload.shell);
  const executionMode = action.payload.executionMode ?? "foreground";
  const readyUrl = (action.payload.readyUrl ?? "").trim();
  const readyTimeoutMs = action.payload.readyTimeoutMs ?? "";
  return `${action.type}:${normalizedShell}:${action.payload.timeoutMs}:${executionMode}:${readyUrl}:${readyTimeoutMs}`;
}

export function buildProposedActionBatchMetadata(actions: ActionProposal[]): void {
  const patchActions = actions.filter(
    (action): action is ApplyPatchActionProposal => action.type === "apply_patch",
  );
  if (
    patchActions.length <= 1 ||
    !applyPatchTargetsAreDisjointForBatching(patchActions)
  ) {
    return;
  }

  const groupId = `action-group-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const createdAt = new Date().toISOString();
  const files = Array.from(
    new Set(patchActions.flatMap((action) => collectPatchedFiles(action.payload.patch))),
  );
  const title =
    files.length > 0
      ? `批量补丁（${files.length} 个文件）`
      : `批量补丁（${patchActions.length} 个 patch）`;

  for (const action of patchActions) {
    action.group = {
      groupId,
      title,
      atomicIntent: true,
      createdAt,
    };
  }
}
