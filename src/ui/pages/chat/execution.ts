import {
  getActiveVendor,
  loadVendorApiKey,
  resolveManagedModelSelection,
  syncRuntimeSettings,
  type AppSettings,
} from "../../../lib/settingsStore";
import type { ModelSelection } from "../../../lib/modelSelection";
import type { Conversation } from "../../../lib/conversationStore";
import type { ChatContextAttachment } from "../../../lib/contextAttachments";
import {
  actionFingerprint,
  derivePlanWorkflowState,
  setPlanStepStatus,
  syncPlanStateWithActions,
  type PlanningSessionPhase,
} from "../../../orchestrator/planningService";
import type { ChatAgentDefinition } from "../../../agents/types";
import { createAgentBinding } from "../../../agents/resolveAgentRuntime";
import type { OrchestrationPlan } from "../../../orchestrator/types";

export interface RunChatCycleOptions {
  visibleUserMessage?: boolean;
  internalSystemNote?: string;
  contextAttachments?: ChatContextAttachment[];
  phase?: PlanningSessionPhase;
  existingPlan?: OrchestrationPlan | null;
}

export function resolveConversationModelSelection(
  settings: AppSettings,
  activeAgent: ChatAgentDefinition,
  currentConversation: Conversation | null,
): ModelSelection | null {
  const binding = currentConversation?.agentBinding;
  if (binding) {
    return {
      vendorId: binding.vendorId,
      modelId: binding.modelId,
    };
  }

  if (activeAgent.modelSelection) {
    return activeAgent.modelSelection;
  }

  const activeSelection = resolveManagedModelSelection(settings, {
    vendorId: settings.activeVendorId,
    modelId: settings.activeModelId,
  });
  if (!activeSelection) {
    return null;
  }

  return {
    vendorId: activeSelection.vendor.id,
    modelId: activeSelection.managedModel.id,
  };
}

export async function buildExecutionSettings(
  settings: AppSettings,
  activeAgent: ChatAgentDefinition,
  currentConversation: Conversation | null,
): Promise<{
  settings: AppSettings;
  selection: ModelSelection | null;
  snapshots?: { vendorName?: string; modelName?: string };
}> {
  const selection = resolveConversationModelSelection(
    settings,
    activeAgent,
    currentConversation,
  );
  if (
    selection &&
    !resolveManagedModelSelection(settings, {
      vendorId: selection.vendorId,
      modelId: selection.modelId,
    })
  ) {
    throw new Error("Model selection is invalid. Please reselect a configured vendor/model.");
  }
  const modelScopedSettings = selection
    ? syncRuntimeSettings({
      ...settings,
      activeVendorId: selection.vendorId,
      activeModelId: selection.modelId,
    })
    : settings;
  const resolvedSelection = resolveManagedModelSelection(modelScopedSettings, selection);

  let apiKey = modelScopedSettings.apiKey;
  try {
    const vendorApiKey = await loadVendorApiKey(getActiveVendor(modelScopedSettings)?.id);
    if (vendorApiKey) {
      apiKey = vendorApiKey;
    }
  } catch {
    // ignore secure storage failures and fall back to the in-memory key
  }

  return {
    selection,
    snapshots: resolvedSelection
      ? {
        vendorName: resolvedSelection.vendor.name,
        modelName: resolvedSelection.managedModel.name,
      }
      : undefined,
    settings:
      apiKey === modelScopedSettings.apiKey
        ? modelScopedSettings
        : { ...modelScopedSettings, apiKey },
  };
}

export function ensureConversationAgentBinding(params: {
  conversation: Conversation | null;
  selection: ModelSelection | null;
  snapshots?: { vendorName?: string; modelName?: string };
  activeAgent: ChatAgentDefinition;
}): Conversation | null {
  const { conversation, selection, snapshots, activeAgent } = params;
  if (!conversation || conversation.agentBinding || !selection) {
    return conversation;
  }

  return {
    ...conversation,
    agentBinding: createAgentBinding(
      activeAgent.id,
      selection,
      "default",
      activeAgent.name,
      snapshots,
    ),
  };
}

export function createConversationAgentBinding(
  settings: AppSettings,
  activeAgent: ChatAgentDefinition,
) {
  const selection = resolveConversationModelSelection(settings, activeAgent, null);
  const resolvedSelection = selection
    ? resolveManagedModelSelection(settings, selection)
    : null;

  return selection
    ? createAgentBinding(activeAgent.id, selection, "default", activeAgent.name, {
      vendorName: resolvedSelection?.vendor.name,
      modelName: resolvedSelection?.managedModel.name,
    })
    : undefined;
}

export function collectBlockedActionFingerprints(
  plan: OrchestrationPlan,
): string[] {
  return plan.proposedActions
    .filter(
      (action) =>
        action.status === "completed" ||
        action.status === "rejected" ||
        action.status === "failed",
    )
    .map((action) => action.fingerprint ?? actionFingerprint(action));
}

export function markActionExecutionError(
  plan: OrchestrationPlan,
  actionId: string,
  reason: string,
): OrchestrationPlan {
  const timestamp = new Date().toISOString();
  const nextActions = plan.proposedActions.map((action) =>
    action.id === actionId
      ? {
        ...action,
        status: "failed" as const,
        executed: false,
        executionResult: { success: false, message: reason, timestamp },
        }
      : action,
  );
  const nextPlanState = syncPlanStateWithActions(
    {
      steps: plan.steps,
      activeStepId: plan.activeStepId,
    },
    nextActions,
    { promoteNextRunnable: false },
  );
  const nextAction = nextActions.find((action) => action.id === actionId);
  if (nextAction?.planStepId) {
    setPlanStepStatus(nextPlanState, nextAction.planStepId, "failed", reason);
  }
  return {
    ...plan,
    state: derivePlanWorkflowState(nextActions, nextPlanState),
    steps: nextPlanState.steps,
    activeStepId: nextPlanState.activeStepId,
    proposedActions: nextActions,
  };
}
