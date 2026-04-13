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
    promptIntent: "Break complex user requests into verifiable, actionable engineering steps (Vibe Coding methodology). Thoroughly analyze risks, dependencies, and edge cases. Clearly explain your reasoning and trade-offs before outputting the final plan, so the user understands the 'why' behind the plan.",
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
    promptIntent: "Produce high-quality implementation edits/patches. Focus on atomic changes, write production-ready code with solid error handling. Provide a clear chain of thought explaining your technical decisions and trade-offs. Instead of a silent completion, narrate your progress briefly and summarize what was changed and why at the end.",
    tools: ["read_file", "grep", "glob", "propose_file_edit"],
    sensitiveActionAllowed: false,
    allowAsSubAgent: true,
    subAgentMaxTurns: 25,
  },
  {
    role: "tester",
    displayName: "Tester",
    promptIntent: "Propose validations and summarize risk before apply/commit. Clearly articulate your test strategy, what edge cases you considered, and provide a clear report on the test outcomes, rather than just raw command outputs.",
    tools: ["read_file", "grep", "glob", "propose_shell"],
    sensitiveActionAllowed: false,
    allowAsSubAgent: true,
    subAgentMaxTurns: 15,
  },
  {
    role: "debugger",
    displayName: "Debugger",
    promptIntent: "Investigate bugs using hypothesis-driven debugging with instrumentation. Clearly narrate your debugging process: state your hypotheses, what evidence you found, and how you deduced the root cause. Do not just silently fix the bug; help the user understand what went wrong.",
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
  },
  {
    role: "reviewer",
    displayName: "Reviewer",
    promptIntent: "Perform structured code review with quality assessment. Provide a professional, skimmable review report. Highlight not just the issues, but explain why they are issues and how they can be improved according to best practices.",
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
      "审查维度：correctness | security | maintainability | consistency（各 1-5 分）",
    ].join("\n"),
  },
  {
    role: "verifier",
    displayName: "Verifier",
    promptIntent: "Execute project test/lint/typecheck commands. Report pass/fail strictly based on exit codes. Never guess or assume results. Run the commands, observe the actual output, and report factually.",
    tools: ["propose_shell", "check_shell_job", "read_file", "glob"],
    sensitiveActionAllowed: false,
    allowAsSubAgent: true,
    subAgentMaxTurns: 10,
  },
];
