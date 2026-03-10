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
    promptIntent: "Break complex user requests into verifiable, actionable engineering steps (Vibe Coding methodology). Thoroughly analyze risks, dependencies, and Edge cases.",
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
    promptIntent: "Produce high-quality implementation edits/patches. Focus on atomic changes, write production-ready code with solid error handling, and explain technical tradeoffs if necessary.",
    tools: ["read_file", "grep", "glob", "propose_file_edit"],
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
  {
    role: "debugger",
    displayName: "Debugger",
    promptIntent: "Investigate bugs using hypothesis-driven debugging with instrumentation.",
    tools: ["read_file", "grep", "glob", "git_diff", "diagnostics", "propose_file_edit", "propose_shell"],
    sensitiveActionAllowed: false,
    allowAsSubAgent: true,
    subAgentMaxTurns: 30,
    workflowTemplate: [
      "## 调试工作流",
      "1. **理解问题**：读取相关代码和错误信息",
      "2. **形成假设**：基于证据提出 1-3 个可能的根因假设",
      "3. **验证假设**：通过阅读代码、搜索模式、运行诊断来验证/排除假设",
      "4. **定位根因**：确认最可能的根因",
      "5. **提出修复**：使用 propose_file_edit 提出修复方案",
    ].join("\n"),
    outputSchemaHint: [
      "完成调试后，请在回复末尾附上结构化输出：",
      "```json",
      "{",
      '  "hypotheses": [{"description": "...", "evidence": "...", "status": "confirmed|rejected|pending"}],',
      '  "rootCause": "...",',
      '  "fix": "..."',
      "}",
      "```",
    ].join("\n"),
  },
  {
    role: "reviewer",
    displayName: "Reviewer",
    promptIntent: "Perform structured code review with quality assessment.",
    tools: ["read_file", "grep", "glob", "git_diff", "diagnostics"],
    sensitiveActionAllowed: false,
    allowAsSubAgent: true,
    subAgentMaxTurns: 20,
    workflowTemplate: [
      "## 审查工作流",
      "1. **变更范围**：通过 git_diff 了解本次变更",
      "2. **逐文件审查**：读取每个变更文件，检查代码质量",
      "3. **交叉影响**：grep 搜索受影响的调用方",
      "4. **输出报告**：按严重程度分类的审查意见",
      "",
      "审查维度：正确性 | 安全性 | 性能 | 可维护性 | 一致性",
    ].join("\n"),
    outputSchemaHint: [
      "完成审查后，请在回复末尾附上结构化输出：",
      "```json",
      "{",
      '  "issues": [{"severity": "critical|warning|suggestion", "file": "...", "line": 123, "message": "..."}],',
      '  "overallAssessment": "approve|request_changes|comment",',
      '  "summary": "..."',
      "}",
      "```",
    ].join("\n"),
  },
];
