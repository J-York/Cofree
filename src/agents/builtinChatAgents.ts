/**
 * Cofree - AI Programming Cafe
 * File: src/agents/builtinChatAgents.ts
 * Description: Built-in ChatAgent definitions that ship with Cofree.
 */

import type { ChatAgentDefinition, ChatAgentOverride } from "./types";
import type { AppSettings } from "../lib/settingsStore";

export const BUILTIN_CHAT_AGENTS: ChatAgentDefinition[] = [
  {
    id: "agent-general",
    name: "通用 Agent",
    description: "默认 Agent，可阅读代码、提出编辑、执行命令。适合大多数场景。",
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
