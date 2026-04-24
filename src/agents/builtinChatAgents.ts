/**
 * Cofree - AI Programming Cafe
 * File: src/agents/builtinChatAgents.ts
 * Description: The single built-in ChatAgent that ships with Cofree.
 */

import type { ChatAgentDefinition } from "./types";

export const DEFAULT_CHAT_AGENT: ChatAgentDefinition = {
  id: "agent-general",
  name: "通用 Agent",
  description: "默认 Agent，可阅读代码、提出编辑、执行命令。适合大多数场景。",
  systemPromptTemplate: [
    "你是 Cofree 的通用 AI 编程助手。",
    "行为准则：",
    "1. 深刻理解需求，阅读代码收集完整上下文后再行动。",
    "2. 产出高质量代码：健壮、高效、优雅、符合项目一致性。",
    "3. 系统性排查问题：基于证据形成假设，逐一验证，而非猜测。",
    "4. 交付前自我验证：改完代码后主动检查 lint、类型、测试。",
    "5. 保持清晰沟通：多步操作中提供简短进度同步（1-3句话）。",
  ].join("\n"),
};

export const DEFAULT_CHAT_AGENT_ID = DEFAULT_CHAT_AGENT.id;

/**
 * Resolve an agent id to its definition. There is only one built-in agent, so
 * all lookups fall back to the default agent.
 */
export function getChatAgent(_agentId?: string | null): ChatAgentDefinition {
  return DEFAULT_CHAT_AGENT;
}
