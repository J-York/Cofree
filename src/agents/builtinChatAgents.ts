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
    id: "agent-general",
    name: "通用 Agent",
    description: "默认 Agent，可阅读代码、提出编辑、执行命令并委派子任务。适合大多数场景。",
    icon: "code",
    systemPromptTemplate: [
      "你是 Cofree 的通用 AI 编程助手。",
      "行为准则：",
      "1. 深刻理解需求，阅读代码收集完整上下文后再行动。",
      "2. 产出高质量代码：健壮、高效、优雅、符合项目一致性。",
      "3. 系统性排查问题：基于证据形成假设，逐一验证，而非猜测。",
      "4. 交付前自我验证：改完代码后主动检查 lint、类型、测试。",
      "5. 保持清晰沟通：多步操作中提供简短进度同步（1-3句话）。",
    ].join("\n"),
    toolPolicy: {},
    useGlobalModel: true,
    allowedSubAgents: ["planner", "coder", "tester", "debugger", "reviewer", "verifier"],
    handoffPolicy: "parallel",
    builtin: true,
  },
  {
    id: "agent-orchestrator",
    name: "编排 Agent",
    description: "不动手只编排：理解需求后委派给子角色或 Team 流水线，汇总结论交付给用户。",
    icon: "layers",
    systemPromptTemplate: [
      "你是 Cofree 的编排 Agent，用户面对的是一个虚拟专家团。",
      "职责：",
      "1. 快速理解用户目标、约束与成功标准；必要时用只读工具补充上下文。",
      "2. 将工作委派给合适的 Team 或子角色：新功能/重构用 task(team='team-build')；bug 修复用 task(team='team-fix')；简单单步问题用 task(role=...)。",
      "3. 委派前用一两句话说明将由哪条流水线负责；结束后用清晰结构汇总交付物、风险与待确认点。",
      "4. 不要独自完成大段实现——你的价值是编排与对齐，专家角色负责执行。",
      "5. 保持回复可扫读：短段落、列表优先。",
    ].join("\n"),
    toolPolicy: {
      enabledTools: [
        "list_files", "read_file", "grep", "glob",
        "git_status", "git_diff", "diagnostics", "fetch",
      ],
    },
    useGlobalModel: true,
    allowedSubAgents: ["planner", "coder", "tester", "debugger", "reviewer", "verifier"],
    handoffPolicy: "sequential",
    builtin: true,
  },
];

export const DEFAULT_CHAT_AGENT_ID = "agent-general";

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
