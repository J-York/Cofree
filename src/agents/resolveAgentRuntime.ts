/**
 * Cofree - AI Programming Cafe
 * File: src/agents/resolveAgentRuntime.ts
 * Description: Resolves the default ChatAgent + AppSettings into a concrete
 *              ResolvedAgentRuntime that the orchestrator can execute against.
 */

import type { AppSettings, ToolPermissionLevel } from "../lib/settingsStore";
import {
  getActiveVendor,
  getActiveManagedModel,
  resolveManagedModelSelection,
  DEFAULT_TOOL_PERMISSIONS,
} from "../lib/settingsStore";
import type {
  ResolvedAgentRuntime,
  ConversationAgentBinding,
} from "./types";
import { DEFAULT_CHAT_AGENT } from "./builtinChatAgents";
import type { ModelSelection } from "../lib/modelSelection";

const ALL_TOOL_NAMES = [
  "list_files", "read_file", "grep", "glob",
  "git_status", "git_diff",
  "propose_file_edit", "propose_shell",
  "check_shell_job",
  "diagnostics", "fetch", "ask_user",
];

function resolveToolPermissions(
  settings: AppSettings,
): Record<string, ToolPermissionLevel> {
  return {
    ...DEFAULT_TOOL_PERMISSIONS,
    ...settings.toolPermissions,
  };
}

export function resolveAgentRuntime(
  agentIdOrBinding: string | ConversationAgentBinding | null | undefined,
  settings: AppSettings,
): ResolvedAgentRuntime {
  const binding =
    agentIdOrBinding && typeof agentIdOrBinding === "object" ? agentIdOrBinding : null;

  const agent = DEFAULT_CHAT_AGENT;
  const bindingSelection: ModelSelection | undefined = binding
    ? { vendorId: binding.vendorId, modelId: binding.modelId }
    : undefined;
  const selection = resolveManagedModelSelection(settings, bindingSelection);
  const vendor = selection?.vendor ?? getActiveVendor(settings);
  const model = selection?.managedModel ?? getActiveManagedModel(settings);

  return {
    agentId: agent.id,
    agentName: agent.name,
    systemPrompt: agent.systemPromptTemplate,
    enabledTools: [...ALL_TOOL_NAMES],
    toolPermissions: resolveToolPermissions(settings),
    vendorId: vendor?.id || settings.activeVendorId || "",
    modelId: model?.id || settings.activeModelId || "",
    modelRef: model?.name || settings.model,
    vendorProtocol: vendor?.protocol || "openai-chat-completions",
    baseUrl: vendor?.baseUrl || settings.liteLLMBaseUrl,
    apiKey: settings.apiKey,
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
