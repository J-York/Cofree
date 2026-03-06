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
    subAgentMaxTurns: 15,
    outputSchemaHint: [
      "完成分析后，请在回复末尾附上结构化输出：",
      "```json",
      "{",
      '  "tasks": [{"title": "...", "description": "...", "targetFiles": ["..."], "estimatedComplexity": "low|medium|high"}],',
      '  "riskAssessment": "...",',
      '  "architectureNotes": "..."',
      "}",
      "```",
    ].join("\n"),
  },
  {
    role: "coder",
    displayName: "Coder",
    promptIntent: "Produce implementation edits/patches and explain technical tradeoffs.",
    tools: ["read_file", "grep", "glob", "propose_file_edit", "propose_apply_patch"],
    sensitiveActionAllowed: false,
    allowAsSubAgent: true,
    subAgentMaxTurns: 25,
    outputSchemaHint: [
      "完成实现后，请在回复末尾附上结构化输出：",
      "```json",
      "{",
      '  "changedFiles": ["..."],',
      '  "summary": "...",',
      '  "implementationNotes": "...",',
      '  "knownIssues": ["..."]',
      "}",
      "```",
    ].join("\n"),
  },
  {
    role: "tester",
    displayName: "Tester",
    promptIntent: "Propose validations and summarize risk before apply/commit.",
    tools: ["read_file", "grep", "glob", "propose_shell"],
    sensitiveActionAllowed: false,
    allowAsSubAgent: true,
    subAgentMaxTurns: 15,
    outputSchemaHint: [
      "完成测试分析后，请在回复末尾附上结构化输出：",
      "```json",
      "{",
      '  "testPlan": [{"testCase": "...", "steps": ["..."], "expectedResult": "...", "passed": true|false}],',
      '  "riskLevel": "low|medium|high",',
      '  "coverageGaps": ["..."]',
      "}",
      "```",
    ].join("\n"),
  },
];
