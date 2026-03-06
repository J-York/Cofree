/**
 * Cofree - AI Programming Cafe
 * File: src/agents/defaultAgents.ts
 * Description: Internal sub-agent roster used by the orchestrator's `task` tool.
 *
 * These are NOT user-selectable agents. For user-facing ChatAgents see
 * builtinChatAgents.ts. The types are re-exported from agents/types.ts
 * for backward compatibility.
 */

import type { SubAgentRole, SubAgentDefinition } from "./types";

/** @deprecated Use SubAgentRole from agents/types.ts */
export type AgentRole = SubAgentRole;

/** @deprecated Use SubAgentDefinition from agents/types.ts */
export type AgentDefinition = SubAgentDefinition;

export const DEFAULT_AGENTS: AgentDefinition[] = [
  {
    role: "planner",
    displayName: "Planner",
    promptIntent: "Break user requests into verifiable development steps.",
    tools: ["list_files", "read_file", "grep", "glob", "git_status", "git_diff"],
    sensitiveActionAllowed: false,
    allowAsSubAgent: true,
    subAgentMaxTurns: 15
  },
  {
    role: "coder",
    displayName: "Coder",
    promptIntent: "Produce implementation edits/patches and explain technical tradeoffs.",
    tools: ["read_file", "grep", "glob", "propose_file_edit", "propose_apply_patch"],
    sensitiveActionAllowed: false,
    allowAsSubAgent: true,
    subAgentMaxTurns: 25
  },
  {
    role: "tester",
    displayName: "Tester",
    promptIntent: "Propose validations and summarize risk before apply/commit.",
    tools: ["read_file", "grep", "glob", "propose_shell"],
    sensitiveActionAllowed: false,
    allowAsSubAgent: true,
    subAgentMaxTurns: 15
  }
];
