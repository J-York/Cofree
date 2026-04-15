/**
 * Cofree - AI Programming Cafe
 * File: src/agents/toolPolicy.ts
 * Description: Tool schema selection and permission enforcement for agents.
 */

import type { ResolvedAgentRuntime } from "./types";
import type { ToolPermissionLevel } from "../lib/settingsStore";
import type { LiteLLMToolDefinition } from "../lib/piAiBridge";

export interface AgentToolContext {
  visibleToolDefs: LiteLLMToolDefinition[];
  autoTools: string[];
  askTools: string[];
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
