import { describe, expect, it } from "vitest";

import type { ConversationAgentBinding } from "../../../agents/types";
import type { Conversation } from "../../../lib/conversationStore";
import {
  buildDraftConversationBindingUpdate,
  resolveConversationAssistantDisplayName,
} from "./conversationAgentDisplay";

function binding(overrides: Partial<ConversationAgentBinding> = {}): ConversationAgentBinding {
  return {
    agentId: "general",
    vendorId: "vendor-a",
    modelId: "model-a",
    bindingSource: "default",
    agentNameSnapshot: "通用 Agent",
    vendorNameSnapshot: "Vendor A",
    modelNameSnapshot: "Model A",
    boundAt: "2026-03-24T00:00:00.000Z",
    ...overrides,
  };
}

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv-1",
    title: "新对话",
    createdAt: "2026-03-24T00:00:00.000Z",
    updatedAt: "2026-03-24T00:00:00.000Z",
    messages: [],
    agentBinding: binding(),
    ...overrides,
  };
}

describe("resolveConversationAssistantDisplayName", () => {
  it("uses the currently selected agent name for a draft conversation", () => {
    const name = resolveConversationAssistantDisplayName({
      conversation: conversation({
        agentBinding: binding({ agentId: "general", agentNameSnapshot: "通用 Agent" }),
      }),
      messageCount: 0,
      activeAgentName: "编排 Agent",
    });

    expect(name).toBe("编排 Agent");
  });

  it("keeps the bound snapshot once the conversation already has messages", () => {
    const name = resolveConversationAssistantDisplayName({
      conversation: conversation({
        messages: [
          {
            id: "m1",
            role: "user",
            content: "hello",
            createdAt: "2026-03-24T00:00:00.000Z",
            plan: null,
          },
        ],
      }),
      messageCount: 1,
      activeAgentName: "编排 Agent",
    });

    expect(name).toBe("通用 Agent");
  });
});

describe("buildDraftConversationBindingUpdate", () => {
  it("replaces the binding for a draft conversation when the selected agent changed", () => {
    const nextBinding = binding({
      agentId: "orchestrator",
      agentNameSnapshot: "编排 Agent",
      vendorId: "vendor-b",
      modelId: "model-b",
    });

    const updated = buildDraftConversationBindingUpdate({
      conversation: conversation(),
      messageCount: 0,
      nextBinding,
    });

    expect(updated?.agentBinding).toEqual(nextBinding);
  });

  it("does not replace the binding once the conversation already has messages", () => {
    const updated = buildDraftConversationBindingUpdate({
      conversation: conversation({
        messages: [
          {
            id: "m1",
            role: "user",
            content: "hello",
            createdAt: "2026-03-24T00:00:00.000Z",
            plan: null,
          },
        ],
      }),
      messageCount: 1,
      nextBinding: binding({
        agentId: "orchestrator",
        agentNameSnapshot: "编排 Agent",
      }),
    });

    expect(updated).toBeNull();
  });
});
