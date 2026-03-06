/**
 * Cofree - AI Programming Cafe
 * File: src/agents/toolPolicy.ts
 * Description: Tool schema selection and permission enforcement for agents.
 *
 * Given a ResolvedAgentRuntime, filters the full tool definition list
 * to only the tools the agent is allowed to see and determines which
 * tools require human approval.
 */

import type { ResolvedAgentRuntime, SubAgentRole } from "./types";
import type { ToolPermissionLevel } from "../lib/settingsStore";
import type { LiteLLMToolDefinition } from "../lib/litellm";

export interface AgentToolContext {
  visibleToolDefs: LiteLLMToolDefinition[];
  autoTools: string[];
  askTools: string[];
  allowedSubAgentRoles: SubAgentRole[];
}

/**
 * Select tool definitions visible to this agent, filtered from the full set.
 */
export function selectAgentTools(
  runtime: ResolvedAgentRuntime,
  allToolDefs: LiteLLMToolDefinition[],
): AgentToolContext {
  const enabledSet = new Set(runtime.enabledTools);

  const visibleToolDefs = allToolDefs.filter(
    (td) => enabledSet.has(td.function.name),
  );

  const autoTools: string[] = [];
  const askTools: string[] = [];

  for (const toolName of runtime.enabledTools) {
    const level: ToolPermissionLevel = runtime.toolPermissions[toolName] ?? "ask";
    if (level === "auto") {
      autoTools.push(toolName);
    } else {
      askTools.push(toolName);
    }
  }

  return {
    visibleToolDefs,
    autoTools,
    askTools,
    allowedSubAgentRoles: runtime.allowedSubAgents,
  };
}

/**
 * Check whether a specific tool call should be auto-executed or requires approval.
 */
export function shouldAutoExecute(
  toolName: string,
  runtime: ResolvedAgentRuntime,
): boolean {
  const level: ToolPermissionLevel | undefined = runtime.toolPermissions[toolName];
  return level === "auto";
}
