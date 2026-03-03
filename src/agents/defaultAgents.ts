/**
 * Cofree - AI Programming Cafe
 * File: src/agents/defaultAgents.ts
 * Milestone: 1
 * Task: 1.2
 * Status: Completed
 * Owner: Codex-GPT-5
 * Last Modified: 2026-03-01
 * Description: Default expert roster used by Milestone 1 mock orchestration.
 */

export type AgentRole = "planner" | "coder" | "tester";

export interface AgentDefinition {
  role: AgentRole;
  displayName: string;
  promptIntent: string;
  tools: string[];
  sensitiveActionAllowed: boolean;
  /** When true, this agent can be invoked as a sub-agent via the `task` tool. */
  allowAsSubAgent?: boolean;
  /** Maximum tool-calling loop turns when running as a sub-agent. */
  subAgentMaxTurns?: number;
}

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
