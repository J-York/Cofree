import type {
  ActionProposal,
  OrchestrationPlan,
  PlanStep,
  PlanStepStatus,
} from "./types";

export interface TodoPlanState {
  steps: PlanStep[];
  activeStepId?: string;
}

interface SyncPlanStateOptions {
  promoteNextRunnable?: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function createPlanStepId(): string {
  return `step-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function clonePlanStep(step: PlanStep): PlanStep {
  return {
    ...step,
    dependsOn: step.dependsOn ? [...step.dependsOn] : undefined,
    linkedActionIds: step.linkedActionIds ? [...step.linkedActionIds] : undefined,
  };
}

export function clonePlanState(state: TodoPlanState): TodoPlanState {
  return {
    steps: state.steps.map(clonePlanStep),
    activeStepId: state.activeStepId,
  };
}

function sanitizeStepTitle(title: string, fallback: string): string {
  const normalized = title.trim() || fallback.trim();
  return normalized || "未命名步骤";
}

function isTerminalPlanStepStatus(status: PlanStepStatus): boolean {
  return status === "completed" || status === "failed" || status === "skipped";
}

function areStepDependenciesSatisfied(step: PlanStep, steps: PlanStep[]): boolean {
  if (!step.dependsOn?.length) {
    return true;
  }
  const byId = new Map(steps.map((entry) => [entry.id, entry]));
  return step.dependsOn.every((depId) => {
    const dependency = byId.get(depId);
    return dependency ? dependency.status === "completed" || dependency.status === "skipped" : false;
  });
}

function findRunnablePendingStep(steps: PlanStep[]): PlanStep | undefined {
  return steps.find(
    (step) => step.status === "pending" && areStepDependenciesSatisfied(step, steps),
  );
}

function normalizeTodoPlanStateInternal(
  state: TodoPlanState,
  options?: SyncPlanStateOptions,
): TodoPlanState {
  const promoteNextRunnable = options?.promoteNextRunnable !== false;
  const steps = state.steps.map((step, index) => {
    const fallbackTitle = step.summary?.trim() || `步骤 ${index + 1}`;
    return {
      ...clonePlanStep(step),
      title: sanitizeStepTitle(step.title ?? "", fallbackTitle),
      summary: step.summary?.trim() || fallbackTitle,
      status: step.status ?? "pending",
      dependsOn: step.dependsOn?.filter(Boolean),
      linkedActionIds: step.linkedActionIds?.filter(Boolean),
    };
  });

  let activeStepId = state.activeStepId?.trim() || steps.find((step) => step.status === "in_progress")?.id;
  if (activeStepId) {
    const active = steps.find((step) => step.id === activeStepId);
    if (!active || isTerminalPlanStepStatus(active.status)) {
      activeStepId = undefined;
    } else if (active.status !== "in_progress") {
      active.status = "in_progress";
      active.startedAt = active.startedAt ?? nowIso();
    }
  }

  if (!activeStepId && promoteNextRunnable) {
    const runnable = findRunnablePendingStep(steps);
    if (runnable) {
      runnable.status = "in_progress";
      runnable.startedAt = runnable.startedAt ?? nowIso();
      activeStepId = runnable.id;
    }
  }

  for (const step of steps) {
    if (step.id !== activeStepId && step.status === "in_progress") {
      step.status = "pending";
    }
  }

  return { steps, activeStepId };
}

export function normalizeTodoPlanState(state: TodoPlanState): TodoPlanState {
  return normalizeTodoPlanStateInternal(state);
}

export function appendPlanStepNote(step: PlanStep, note?: string): void {
  const normalized = note?.trim();
  if (!normalized) {
    return;
  }
  step.note = step.note?.trim()
    ? `${step.note.trim()}\n${normalized}`
    : normalized;
}

export function setActivePlanStep(state: TodoPlanState, stepId: string): string {
  const target = state.steps.find((step) => step.id === stepId);
  if (!target) {
    return `未找到步骤 ${stepId}`;
  }

  for (const step of state.steps) {
    if (step.id !== stepId && step.status === "in_progress") {
      step.status = "pending";
    }
  }

  target.status = "in_progress";
  target.startedAt = target.startedAt ?? nowIso();
  state.activeStepId = target.id;
  return `当前执行步骤已切换为「${target.title}」`;
}

function promoteNextRunnableStep(state: TodoPlanState): void {
  if (state.activeStepId) {
    return;
  }
  const runnable = findRunnablePendingStep(state.steps);
  if (!runnable) {
    return;
  }
  runnable.status = "in_progress";
  runnable.startedAt = runnable.startedAt ?? nowIso();
  state.activeStepId = runnable.id;
}

export function setPlanStepStatus(
  state: TodoPlanState,
  stepId: string,
  status: Exclude<PlanStepStatus, "pending" | "in_progress">,
  note?: string,
): string {
  const target = state.steps.find((step) => step.id === stepId);
  if (!target) {
    return `未找到步骤 ${stepId}`;
  }

  target.status = status;
  appendPlanStepNote(target, note);
  if (status === "completed") {
    target.completedAt = nowIso();
  }
  if (state.activeStepId === stepId) {
    state.activeStepId = undefined;
  }
  if (status === "completed" || status === "skipped") {
    promoteNextRunnableStep(state);
  }
  return `步骤「${target.title}」已更新为 ${status}`;
}

export function addPlanStep(state: TodoPlanState, params: {
  title: string;
  summary?: string;
  afterStepId?: string;
  note?: string;
}): PlanStep {
  const step: PlanStep = {
    id: createPlanStepId(),
    title: sanitizeStepTitle(params.title, params.summary ?? params.title),
    summary: params.summary?.trim() || params.title.trim(),
    status: "pending",
    note: params.note?.trim() || undefined,
  };

  const afterIndex = params.afterStepId
    ? state.steps.findIndex((entry) => entry.id === params.afterStepId)
    : -1;
  if (afterIndex >= 0) {
    state.steps.splice(afterIndex + 1, 0, step);
  } else {
    state.steps.push(step);
  }

  if (!state.activeStepId) {
    promoteNextRunnableStep(state);
  }
  return step;
}

export function attachActionToPlanStep(state: TodoPlanState, action: ActionProposal): ActionProposal {
  const planStepId = action.planStepId ?? state.activeStepId;
  if (!planStepId) {
    return action;
  }
  const target = state.steps.find((step) => step.id === planStepId);
  if (!target) {
    return action;
  }
  if (!target.linkedActionIds?.includes(action.id)) {
    target.linkedActionIds = [...(target.linkedActionIds ?? []), action.id];
  }
  if (target.status === "pending") {
    target.status = "in_progress";
    target.startedAt = target.startedAt ?? nowIso();
  }
  return {
    ...action,
    planStepId,
  };
}

export function syncPlanStateWithActions(
  state: TodoPlanState,
  actions: ActionProposal[],
  options?: SyncPlanStateOptions,
): TodoPlanState {
  const next = clonePlanState(state);
  for (const step of next.steps) {
    step.linkedActionIds = [];
  }
  for (const action of actions) {
    if (!action.planStepId) {
      continue;
    }
    const target = next.steps.find((step) => step.id === action.planStepId);
    if (!target) {
      continue;
    }
    target.linkedActionIds = [...(target.linkedActionIds ?? []), action.id];
  }
  return normalizeTodoPlanStateInternal(next, options);
}

export function formatTodoPlanBlock(state: TodoPlanState): string {
  if (!state.steps.length) {
    return "暂无 todo。";
  }
  return state.steps
    .map((step) => {
      const icon = step.status === "completed"
        ? "✓"
        : step.status === "in_progress"
          ? "▶"
          : step.status === "blocked"
            ? "⏸"
            : step.status === "failed"
              ? "✕"
              : step.status === "skipped"
                ? "↷"
                : "○";
      const suffix = step.id === state.activeStepId ? " [当前]" : "";
      return `${icon} [${step.id}] (${step.status}) ${step.title}${suffix}`;
    })
    .join("\n");
}

export function buildTodoSystemPrompt(state: TodoPlanState): string {
  if (!state.steps.length) {
    return "";
  }
  return [
    "[Todo Plan]",
    "当前任务已经拆解为以下 todo。一次只推进一个步骤；完成、阻塞或失败时，必须调用 update_plan 更新状态。",
    "如果新增了明确的子任务，可以用 update_plan 添加步骤；不要静默偏离当前 todo。",
    formatTodoPlanBlock(state),
  ].join("\n");
}

export function derivePlanWorkflowState(
  proposedActions: ActionProposal[],
  planState: TodoPlanState,
): OrchestrationPlan["state"] {
  if (proposedActions.some((action) => action.status === "running")) {
    return "executing";
  }
  if (proposedActions.some((action) => action.status === "pending" || action.status === "failed")) {
    return "human_review";
  }
  if (planState.steps.some((step) => step.status === "in_progress")) {
    return "executing";
  }
  if (planState.steps.some((step) => step.status === "pending" || step.status === "blocked" || step.status === "failed")) {
    return "planning";
  }
  return "done";
}
