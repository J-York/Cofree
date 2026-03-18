/**
 * Cofree - AI Programming Cafe
 * File: src/agents/resolveAgentRuntime.ts
 * Description: Resolves a ChatAgentDefinition + AppSettings into a concrete
 *              ResolvedAgentRuntime that the orchestrator can execute against.
 */

import type { AppSettings, ToolPermissions, ToolPermissionLevel } from "../lib/settingsStore";
import {
  getActiveVendor,
  getActiveManagedModel,
  resolveManagedModelSelection,
  DEFAULT_TOOL_PERMISSIONS,
} from "../lib/settingsStore";
import type {
  ChatAgentDefinition,
  ResolvedAgentRuntime,
  ConversationAgentBinding,
} from "./types";
import { getChatAgentFromSettings } from "./builtinChatAgents";
import type { ModelSelection } from "../lib/modelSelection";

const ALL_TOOL_NAMES = [
  "list_files", "read_file", "grep", "glob",
  "git_status", "git_diff",
  "propose_file_edit", "propose_apply_patch", "propose_shell",
  "check_shell_job",
  "diagnostics", "fetch", "ask_user", "task",
];

function resolveEnabledTools(agent: ChatAgentDefinition): string[] {
  if (agent.toolPolicy.enabledTools && agent.toolPolicy.enabledTools.length > 0) {
    const base = new Set(agent.toolPolicy.enabledTools);
    // Keep human-in-the-loop clarification always available for top-level agents.
    base.add("ask_user");
    if (agent.allowedSubAgents.length > 0) {
      base.add("task");
    }
    return ALL_TOOL_NAMES.filter((toolName) => base.has(toolName));
  }
  return [...ALL_TOOL_NAMES];
}

function resolveToolPermissions(
  agent: ChatAgentDefinition,
  globalPermissions: ToolPermissions,
): Record<string, ToolPermissionLevel> {
  const merged: Record<string, ToolPermissionLevel> = {
    ...DEFAULT_TOOL_PERMISSIONS,
    ...globalPermissions,
  };
  if (agent.toolPolicy.toolPermissionOverrides) {
    for (const [tool, level] of Object.entries(agent.toolPolicy.toolPermissionOverrides)) {
      if (level) {
        merged[tool] = level;
      }
    }
  }
  return merged;
}

function resolveSelectionForAgent(
  agent: ChatAgentDefinition,
  binding: ConversationAgentBinding | null,
): ModelSelection | undefined {
  if (binding) {
    return {
      vendorId: binding.vendorId,
      modelId: binding.modelId,
    };
  }
  return agent.modelSelection;
}

export function resolveAgentRuntime(
  agentIdOrBinding: string | ConversationAgentBinding | null | undefined,
  settings: AppSettings,
): ResolvedAgentRuntime {
  const binding =
    agentIdOrBinding && typeof agentIdOrBinding === "object" ? agentIdOrBinding : null;

  const agentId = binding?.agentId ?? (typeof agentIdOrBinding === "string" ? agentIdOrBinding : null);
  const agent = getChatAgentFromSettings(agentId, settings);
  const selection = resolveManagedModelSelection(
    settings,
    resolveSelectionForAgent(agent, binding),
  );
  const vendor = selection?.vendor ?? getActiveVendor(settings);
  const model = selection?.managedModel ?? getActiveManagedModel(settings);

  return {
    agentId: agent.id,
    agentName: agent.name,
    systemPrompt: agent.systemPromptTemplate,
    enabledTools: resolveEnabledTools(agent),
    toolPermissions: resolveToolPermissions(agent, settings.toolPermissions),
    vendorId: vendor?.id || settings.activeVendorId || "",
    modelId: model?.id || settings.activeModelId || "",
    modelRef: model?.name || settings.model,
    vendorProtocol: vendor?.protocol || "openai-chat-completions",
    baseUrl: vendor?.baseUrl || settings.liteLLMBaseUrl,
    apiKey: settings.apiKey,
    allowedSubAgents: agent.allowedSubAgents,
    handoffPolicy: agent.handoffPolicy ?? "none",
  };
}

export function createAgentBinding(
  agentId: string,
  selection: ModelSelection,
  source: "default" | "user-override",
  agentName: string,
  snapshots?: {
    vendorName?: string;
    modelName?: string;
  },
): ConversationAgentBinding {
  return {
    agentId,
    vendorId: selection.vendorId,
    modelId: selection.modelId,
    bindingSource: source,
    agentNameSnapshot: agentName,
    vendorNameSnapshot: snapshots?.vendorName,
    modelNameSnapshot: snapshots?.modelName,
    boundAt: new Date().toISOString(),
  };
}
