import type { ModelSelection } from "../modelSelection";
import type {
  ChatAgentDefinition,
  ChatAgentOverride,
} from "../../agents/types";
import type { AppSettings } from "./general";
import {
  getManagedModelById,
  resolveManagedModelSelection,
  syncRuntimeSettings,
} from "./general";

function normalizeModelSelection(
  settings: Pick<AppSettings, "vendors" | "managedModels">,
  selection?: ModelSelection,
): ModelSelection | undefined {
  if (!selection) return undefined;
  const resolved = resolveManagedModelSelection(settings, selection);
  const directModel = getManagedModelById(settings, selection.modelId);
  if (!resolved || !directModel) {
    return undefined;
  }
  return {
    vendorId: resolved.vendor.id,
    modelId: directModel.id,
  };
}

export function switchAgent(settings: AppSettings, agentId: string): AppSettings {
  return { ...settings, activeAgentId: agentId };
}

export function generateAgentId(): string {
  return `agent-custom-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
}

export function createCustomAgent(
  settings: AppSettings,
  params: {
    name: string;
    description?: string;
    systemPromptTemplate?: string;
    enabledTools?: string[];
    modelSelection?: ModelSelection;
    useGlobalModel?: boolean;
  },
): { settings: AppSettings; agent: ChatAgentDefinition } {
  const agent: ChatAgentDefinition = {
    id: generateAgentId(),
    name: params.name.trim() || "新 Agent",
    description: params.description?.trim() || "",
    systemPromptTemplate: params.systemPromptTemplate?.trim() || "",
    toolPolicy: params.enabledTools ? { enabledTools: params.enabledTools } : {},
    modelSelection: normalizeModelSelection(settings, params.modelSelection),
    useGlobalModel:
      params.useGlobalModel !== undefined ? params.useGlobalModel : true,
    builtin: false,
  };
  return {
    agent,
    settings: {
      ...settings,
      customAgents: [...settings.customAgents, agent],
      activeAgentId: agent.id,
    },
  };
}

export function updateCustomAgent(
  settings: AppSettings,
  agentId: string,
  updates: Partial<Omit<ChatAgentDefinition, "id" | "builtin">>,
): AppSettings {
  return syncRuntimeSettings({
    ...settings,
    customAgents: settings.customAgents.map((agent) =>
      agent.id === agentId
        ? {
            ...agent,
            ...updates,
            modelSelection: normalizeModelSelection(
              settings,
              updates.modelSelection ?? agent.modelSelection,
            ),
          }
        : agent,
    ),
  });
}

export function deleteCustomAgent(settings: AppSettings, agentId: string): AppSettings {
  const next = {
    ...settings,
    customAgents: settings.customAgents.filter((agent) => agent.id !== agentId),
  };
  if (next.activeAgentId === agentId) {
    next.activeAgentId = null;
  }
  return next;
}

export function cloneAgentAsCustom(
  settings: AppSettings,
  source: ChatAgentDefinition,
  name: string,
): { settings: AppSettings; agent: ChatAgentDefinition } {
  const agent: ChatAgentDefinition = {
    ...source,
    id: generateAgentId(),
    name: name.trim() || `${source.name} (副本)`,
    builtin: false,
    modelSelection: normalizeModelSelection(settings, source.modelSelection),
  };
  return {
    agent,
    settings: {
      ...settings,
      customAgents: [...settings.customAgents, agent],
      activeAgentId: agent.id,
    },
  };
}

export function updateBuiltinAgentOverride(
  settings: AppSettings,
  agentId: string,
  override: Partial<Omit<ChatAgentDefinition, "id" | "builtin">>,
): AppSettings {
  const normalizedOverride: ChatAgentOverride = {
    ...override,
    modelSelection: normalizeModelSelection(settings, override.modelSelection),
  };
  if (!normalizedOverride.modelSelection) {
    delete normalizedOverride.modelSelection;
  }
  return syncRuntimeSettings({
    ...settings,
    builtinAgentOverrides: {
      ...settings.builtinAgentOverrides,
      [agentId]: {
        ...settings.builtinAgentOverrides[agentId],
        ...normalizedOverride,
      },
    },
  });
}

export function resetBuiltinAgentOverride(
  settings: AppSettings,
  agentId: string,
): AppSettings {
  const next = { ...settings.builtinAgentOverrides };
  delete next[agentId];
  return { ...settings, builtinAgentOverrides: next };
}
