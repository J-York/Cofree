/**
 * Cofree - AI Programming Cafe
 * File: src/agents/builtinChatAgents.ts
 * Description: Built-in ChatAgent definitions that ship with Cofree.
 *
 * These are the top-level user-selectable agents. Each agent has its own
 * system prompt template, tool policy, and sub-agent delegation rules.
 * The internal planner/coder/tester sub-agents are NOT listed here.
 */

import type { ChatAgentDefinition } from "./types";

export const BUILTIN_CHAT_AGENTS: ChatAgentDefinition[] = [
  {
    id: "agent-fullstack",
    name: "全栈工程师",
    description: "通用编程 Agent，可阅读代码、提出编辑、执行命令并委派子任务。适合大多数开发场景。",
    icon: "code",
    systemPromptTemplate: [
      "你是 Cofree 的全栈工程师 Agent。",
      "你的目标是作为一名顶级的全栈工程师协助用户。",
      "你必须优先通过可用工具获取事实，再给出答案。",
      "回复遵循极简原则：少废话、多干活、信任系统回调。",
    ].join("\n"),
    toolPolicy: {},
    allowedSubAgents: ["planner", "coder", "tester"],
    handoffPolicy: "none",
    builtin: true,
  },
  {
    id: "agent-code-reviewer",
    name: "代码审查员",
    description: "专注于代码审查、质量分析与改进建议。只读取代码，不主动提出文件编辑。",
    icon: "search",
    systemPromptTemplate: [
      "你是 Cofree 的代码审查员 Agent。",
      "你的职责是审查代码质量、指出潜在问题、提供改进建议。",
      "你应该通过阅读代码和搜索来收集信息，给出有条理的审查报告。",
      "除非用户明确要求修改，否则只提供分析和建议，不主动提出文件编辑。",
    ].join("\n"),
    toolPolicy: {
      enabledTools: [
        "list_files", "read_file", "grep", "glob",
        "git_status", "git_diff", "diagnostics",
      ],
    },
    allowedSubAgents: ["planner"],
    handoffPolicy: "none",
    builtin: true,
  },
  {
    id: "agent-architect",
    name: "架构师",
    description: "帮助设计系统架构、拆解需求、规划技术方案。侧重分析与规划，可委派 coder 验证想法。",
    icon: "layers",
    systemPromptTemplate: [
      "你是 Cofree 的架构师 Agent。",
      "你的职责是帮助用户设计系统架构、拆解复杂需求、规划技术方案。",
      "你擅长从高层次理解系统结构，分析模块依赖，评估技术选型。",
      "当需要验证具体实现细节时，可以委派子任务。",
    ].join("\n"),
    toolPolicy: {
      enabledTools: [
        "list_files", "read_file", "grep", "glob",
        "git_status", "git_diff", "diagnostics", "fetch",
      ],
    },
    allowedSubAgents: ["planner", "coder"],
    handoffPolicy: "none",
    builtin: true,
  },
  {
    id: "agent-qa",
    name: "QA 工程师",
    description: "专注于测试策略、质量验证和风险评估。可读取代码、运行诊断和执行测试命令。",
    icon: "check-circle",
    systemPromptTemplate: [
      "你是 Cofree 的 QA 工程师 Agent。",
      "你的职责是帮助用户制定测试策略、验证代码质量、评估变更风险。",
      "你可以阅读代码、运行诊断工具和执行测试命令来收集证据。",
      "你的输出应包含明确的验证步骤和风险评估。",
    ].join("\n"),
    toolPolicy: {
      enabledTools: [
        "list_files", "read_file", "grep", "glob",
        "git_status", "git_diff", "diagnostics", "propose_shell",
      ],
    },
    allowedSubAgents: ["tester"],
    handoffPolicy: "none",
    builtin: true,
  },
];

export const DEFAULT_CHAT_AGENT_ID = "agent-fullstack";

export function getBuiltinChatAgent(agentId: string): ChatAgentDefinition | null {
  return BUILTIN_CHAT_AGENTS.find((a) => a.id === agentId) ?? null;
}

export function getChatAgentOrDefault(agentId: string | null | undefined): ChatAgentDefinition {
  if (agentId) {
    const found = getBuiltinChatAgent(agentId);
    if (found) return found;
  }
  return BUILTIN_CHAT_AGENTS.find((a) => a.id === DEFAULT_CHAT_AGENT_ID)!;
}
