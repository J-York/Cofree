/**
 * Cofree - AI Programming Cafe
 * File: src/agents/types.ts
 * Description: Agent domain types shared across the application.
 */

import type { ToolPermissionLevel } from "../lib/settingsStore";

export type ChatAgentId = string;

export interface ChatAgentDefinition {
  id: ChatAgentId;
  name: string;
  description: string;
  systemPromptTemplate: string;
}

export interface ResolvedAgentRuntime {
  agentId: ChatAgentId;
  agentName: string;
  systemPrompt: string;
  enabledTools: string[];
  toolPermissions: Record<string, ToolPermissionLevel>;
  vendorId: string;
  modelId: string;
  modelRef: string;
  vendorProtocol: string;
  baseUrl: string;
  apiKey: string;
}

export type AgentBindingSource = "default" | "user-override";

export interface ConversationAgentBinding {
  agentId: ChatAgentId;
  vendorId: string;
  modelId: string;
  bindingSource: AgentBindingSource;
  /** Snapshot of agent name at binding time for display even if agent is removed later. */
  agentNameSnapshot: string;
  vendorNameSnapshot?: string;
  modelNameSnapshot?: string;
  boundAt: string;
}
