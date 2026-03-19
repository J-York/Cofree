/**
 * Cofree - AI Programming Cafe
 * File: src/agents/builtinChatAgents.ts
 * Description: Built-in ChatAgent definitions that ship with Cofree.
 *
 * These are the top-level user-selectable agents. Each agent has its own
 * system prompt template, tool policy, and sub-agent delegation rules.
 * The internal planner/coder/tester sub-agents are NOT listed here.
 */

import type { ChatAgentDefinition, ChatAgentOverride } from "./types";
import type { AppSettings } from "../lib/settingsStore";

export const BUILTIN_CHAT_AGENTS: ChatAgentDefinition[] = [
  {
    id: "agent-fullstack",
    name: "全栈工程师",
    description: "通用编程 Agent，可阅读代码、提出编辑、执行命令并委派子任务。适合大多数开发场景。",
    icon: "code",
    systemPromptTemplate: [
      "你是 Cofree 的全栈工程师 Agent。",
      "你的目标是作为一名顶级的全栈工程师协助用户。",
      "你是一个高度自主和专业的 Vibe Coding 实践者。",
      "1. 深刻理解需求，阅读代码收集完整上下文。",
      "2. 你的代码需符合最佳实践：健壮、高效、优雅、具有一致性。",
      "3. 保持清晰且有条理的沟通（Clear and Skimmable Communication）：在多步操作中提供简短的进度同步（1-3句话），让用户跟上你的思路。不要只是默默无闻地工作，也不要长篇大论。",
      "4. 当遇到问题时，像真正的高级工程师一样系统性地排查根因，而不仅仅是猜测。在任务结束时，提供清晰的交付总结。"
    ].join("\n"),
    toolPolicy: {},
    useGlobalModel: true,
    allowedSubAgents: ["planner", "coder", "tester", "debugger", "reviewer"],
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
      "你应该通过阅读代码和搜索来收集信息，给出专业、有条理且易于浏览的审查报告。",
      "在报告中，不仅要指出问题，还要清晰地解释“为什么”这是一个问题，并给出符合最佳实践的重构思路。",
      "除非用户明确要求修改，否则只提供分析和建议，不主动提出文件编辑。",
    ].join("\n"),
    toolPolicy: {
      enabledTools: [
        "list_files", "read_file", "grep", "glob",
        "git_status", "git_diff", "diagnostics",
      ],
    },
    useGlobalModel: true,
    allowedSubAgents: ["planner", "reviewer"],
    handoffPolicy: "none",
    builtin: true,
  },
  {
    id: "agent-architect",
    name: "架构师",
    description: "帮助设计系统架构、拆解需求、规划技术方案。侧重分析与规划，可委派 coder 验证想法。",
    icon: "layers",
    systemPromptTemplate: [
      "你是 Cofree 的架构师 Agent，专注于高内聚、低耦合的系统设计。",
      "你的职责是协助进行基础架构设计、需求模块化拆解、技术选型，以及审查当前结构问题。",
      "通过全局代码视野（grep/glob）、依赖分析等，深刻理解现有系统的设计哲学。",
      "遵循高质量的工程标准，考虑系统的扩展性、安全性、性能边界及可维护性。",
      "在交流时，请清晰地阐述你的设计决策、替代方案对比和权衡分析（Trade-offs），确保用户能完全理解你的系统规划。",
      "你可以用工具独立验证概念（PoC），也可拆分任务委派给 Coder 子节点。"
    ].join("\n"),
    toolPolicy: {
      enabledTools: [
        "list_files", "read_file", "grep", "glob",
        "git_status", "git_diff", "diagnostics", "fetch",
      ],
    },
    useGlobalModel: true,
    allowedSubAgents: ["planner", "coder", "reviewer"],
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
      "你的输出应包含明确的验证步骤、风险评估以及详尽的测试报告。不要只是干巴巴地返回测试命令的结果，而是要解读这些结果意味着什么。",
    ].join("\n"),
    toolPolicy: {
      enabledTools: [
        "list_files", "read_file", "grep", "glob",
        "git_status", "git_diff", "diagnostics", "propose_shell",
      ],
    },
    useGlobalModel: true,
    allowedSubAgents: ["tester", "reviewer"],
    handoffPolicy: "none",
    builtin: true,
  },
];

export const DEFAULT_CHAT_AGENT_ID = "agent-fullstack";

export function getBuiltinChatAgent(agentId: string): ChatAgentDefinition | null {
  return BUILTIN_CHAT_AGENTS.find((a) => a.id === agentId) ?? null;
}

function applyOverride(
  agent: ChatAgentDefinition,
  override: ChatAgentOverride | undefined,
): ChatAgentDefinition {
  if (!override) return agent;
  return {
    ...agent,
    ...override,
    id: agent.id,
    builtin: agent.builtin,
    toolPolicy: override.toolPolicy
      ? { ...agent.toolPolicy, ...override.toolPolicy }
      : agent.toolPolicy,
  };
}

type AgentSettings = Pick<AppSettings, "customAgents" | "builtinAgentOverrides">;

/**
 * Returns the merged list: builtin (with overrides applied) + custom agents.
 */
export function getAllChatAgents(settings: AgentSettings): ChatAgentDefinition[] {
  const overrides = settings.builtinAgentOverrides ?? {};
  const builtinWithOverrides = BUILTIN_CHAT_AGENTS.map((a) =>
    applyOverride(a, overrides[a.id]),
  );
  return [...builtinWithOverrides, ...(settings.customAgents ?? [])];
}

/**
 * Look up a single agent from the merged (builtin + custom) set.
 */
export function getChatAgentFromSettings(
  agentId: string | null | undefined,
  settings: AgentSettings,
): ChatAgentDefinition {
  if (agentId) {
    const custom = settings.customAgents?.find((a) => a.id === agentId);
    if (custom) return custom;

    const builtin = getBuiltinChatAgent(agentId);
    if (builtin) {
      return applyOverride(builtin, settings.builtinAgentOverrides?.[agentId]);
    }
  }
  return BUILTIN_CHAT_AGENTS.find((a) => a.id === DEFAULT_CHAT_AGENT_ID)!;
}

/** @deprecated Use getChatAgentFromSettings when settings are available. */
export function getChatAgentOrDefault(agentId: string | null | undefined): ChatAgentDefinition {
  if (agentId) {
    const found = getBuiltinChatAgent(agentId);
    if (found) return found;
  }
  return BUILTIN_CHAT_AGENTS.find((a) => a.id === DEFAULT_CHAT_AGENT_ID)!;
}

/**
 * Check whether a builtin agent has any user overrides.
 */
export function hasBuiltinOverride(
  agentId: string,
  settings: AgentSettings,
): boolean {
  const o = settings.builtinAgentOverrides?.[agentId];
  return !!o && Object.keys(o).length > 0;
}
