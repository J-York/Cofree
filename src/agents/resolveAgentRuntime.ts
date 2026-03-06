/**
 * Cofree - AI Programming Cafe
 * File: src/agents/resolveAgentRuntime.ts
 * Description: Resolves a ChatAgentDefinition + AppSettings into a concrete
 *              ResolvedAgentRuntime that the orchestrator can execute against.
 */

import type { AppSettings, ToolPermissions, ToolPermissionLevel } from "../lib/settingsStore";
import {
  getActiveProfile,
  getActiveVendor,
  getActiveManagedModel,
  getProfileSelection,
  DEFAULT_TOOL_PERMISSIONS,
} from "../lib/settingsStore";
import type {
  ChatAgentDefinition,
  ResolvedAgentRuntime,
  ConversationAgentBinding,
} from "./types";
import { getChatAgentOrDefault } from "./builtinChatAgents";

const ALL_TOOL_NAMES = [
  "list_files", "read_file", "grep", "glob",
  "git_status", "git_diff",
  "propose_file_edit", "propose_apply_patch", "propose_shell",
  "diagnostics", "fetch", "task",
];

function resolveEnabledTools(agent: ChatAgentDefinition): string[] {
  if (agent.toolPolicy.enabledTools && agent.toolPolicy.enabledTools.length > 0) {
    const base = new Set(agent.toolPolicy.enabledTools);
    if (agent.allowedSubAgents.length > 0) {
      base.add("task");
    }
    return ALL_TOOL_NAMES.filter((t) => base.has(t));
  }
  return [...ALL_TOOL_NAMES];
}

function resolveToolPermissions(
  agent: ChatAgentDefinition,
  globalPermissions: ToolPermissions,
): Record<string, ToolPermissionLevel> {
  const merged: Record<string, ToolPermissionLevel> = { ...DEFAULT_TOOL_PERMISSIONS, ...globalPermissions };
  if (agent.toolPolicy.toolPermissionOverrides) {
    for (const [tool, level] of Object.entries(agent.toolPolicy.toolPermissionOverrides)) {
      if (level) {
        merged[tool] = level;
      }
    }
  }
  return merged;
}

export function resolveAgentRuntime(
  agentIdOrBinding: string | ConversationAgentBinding | null | undefined,
  settings: AppSettings,
): ResolvedAgentRuntime {
  const binding =
    agentIdOrBinding && typeof agentIdOrBinding === "object" ? agentIdOrBinding : null;

  const agentId = binding?.agentId ?? (typeof agentIdOrBinding === "string" ? agentIdOrBinding : null);
  const agent = getChatAgentOrDefault(agentId);

  // When a binding carries a profileId, honour it instead of the global active profile.
  // This keeps existing conversations pinned to the model they were created with.
  const boundProfile = binding?.profileId
    ? settings.profiles.find((p) => p.id === binding.profileId) ?? null
    : null;

  const profile = boundProfile ?? getActiveProfile(settings);
  const selection = getProfileSelection(settings, profile);
  const vendor = selection?.vendor ?? getActiveVendor(settings);
  const model = selection?.managedModel ?? getActiveManagedModel(settings);

  return {
    agentId: agent.id,
    agentName: agent.name,
    systemPrompt: agent.systemPromptTemplate,
    enabledTools: resolveEnabledTools(agent),
    toolPermissions: resolveToolPermissions(agent, settings.toolPermissions),
    modelRef: model?.name || settings.model,
    profileId: profile?.id || "",
    vendorProtocol: vendor?.protocol || "openai-chat-completions",
    baseUrl: vendor?.baseUrl || settings.liteLLMBaseUrl,
    apiKey: settings.apiKey,
    allowedSubAgents: agent.allowedSubAgents,
    handoffPolicy: agent.handoffPolicy ?? "none",
  };
}

export function createAgentBinding(
  agentId: string,
  profileId: string,
  source: "default" | "user-override",
  agentName: string,
): ConversationAgentBinding {
  return {
    agentId,
    profileId,
    bindingSource: source,
    agentNameSnapshot: agentName,
    boundAt: new Date().toISOString(),
  };
}
