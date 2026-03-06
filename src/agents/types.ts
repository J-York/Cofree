/**
 * Cofree - AI Programming Cafe
 * File: src/agents/types.ts
 * Description: Agent domain types shared across the application.
 *
 * Two distinct agent layers:
 *   - ChatAgent: user-selectable top-level agent that drives a conversation.
 *   - SubAgentRole: internal planner/coder/tester used by the orchestrator.
 */

import type { ToolPermissionLevel } from "../lib/settingsStore";

// ---------------------------------------------------------------------------
// Sub-agent layer (internal orchestrator roles, NOT user-selectable)
// ---------------------------------------------------------------------------

export type SubAgentRole = "planner" | "coder" | "tester";

export interface SubAgentDefinition {
  role: SubAgentRole;
  displayName: string;
  promptIntent: string;
  tools: string[];
  sensitiveActionAllowed: boolean;
  allowAsSubAgent?: boolean;
  subAgentMaxTurns?: number;
}

// ---------------------------------------------------------------------------
// ChatAgent layer (user-selectable, top-level)
// ---------------------------------------------------------------------------

export type ChatAgentId = string;

export interface ChatAgentToolPolicy {
  enabledTools?: string[];
  toolPermissionOverrides?: Partial<Record<string, ToolPermissionLevel>>;
}

export interface ChatAgentDefinition {
  id: ChatAgentId;
  name: string;
  description: string;
  icon?: string;
  systemPromptTemplate: string;
  toolPolicy: ChatAgentToolPolicy;
  defaultProfileId?: string;
  /** Sub-agent roles this agent is allowed to delegate to via `task`. */
  allowedSubAgents: SubAgentRole[];
  /** Reserved for future Agent Teams orchestration. */
  handoffPolicy?: "none" | "sequential" | "parallel";
  /** Reserved for future team composition. */
  teamMembers?: ChatAgentId[];
  builtin: boolean;
}

// ---------------------------------------------------------------------------
// Resolved runtime (produced by the resolver before each request)
// ---------------------------------------------------------------------------

export interface ResolvedAgentRuntime {
  agentId: ChatAgentId;
  agentName: string;
  systemPrompt: string;
  enabledTools: string[];
  toolPermissions: Record<string, ToolPermissionLevel>;
  modelRef: string;
  profileId: string;
  vendorProtocol: string;
  baseUrl: string;
  apiKey: string;
  allowedSubAgents: SubAgentRole[];
  handoffPolicy: "none" | "sequential" | "parallel";
}

// ---------------------------------------------------------------------------
// Conversation-level agent binding (persisted with each conversation)
// ---------------------------------------------------------------------------

export type AgentBindingSource = "default" | "user-override";

export interface ConversationAgentBinding {
  agentId: ChatAgentId;
  profileId: string;
  bindingSource: AgentBindingSource;
  /** Snapshot of agent name at binding time for display even if agent is removed later. */
  agentNameSnapshot: string;
  boundAt: string;
}
