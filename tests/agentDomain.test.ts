import { describe, expect, it } from "vitest";
import {
  BUILTIN_CHAT_AGENTS,
  DEFAULT_CHAT_AGENT_ID,
  getBuiltinChatAgent,
  getChatAgentOrDefault,
} from "../src/agents/builtinChatAgents";
import { resolveAgentRuntime, createAgentBinding } from "../src/agents/resolveAgentRuntime";
import { buildScopedSessionKey } from "../src/orchestrator/checkpointStore";
import { DEFAULT_SETTINGS, createVendorConfig, createManagedModel } from "../src/lib/settingsStore";
import type { AppSettings } from "../src/lib/settingsStore";

function makeSettings(overrides?: Partial<AppSettings>): AppSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

describe("builtinChatAgents", () => {
  it("should have at least one agent", () => {
    expect(BUILTIN_CHAT_AGENTS.length).toBeGreaterThan(0);
  });

  it("default agent id should be found in the list", () => {
    const agent = getBuiltinChatAgent(DEFAULT_CHAT_AGENT_ID);
    expect(agent).not.toBeNull();
    expect(agent!.id).toBe(DEFAULT_CHAT_AGENT_ID);
  });

  it("getChatAgentOrDefault falls back to default for unknown id", () => {
    const agent = getChatAgentOrDefault("nonexistent-agent");
    expect(agent.id).toBe(DEFAULT_CHAT_AGENT_ID);
  });

  it("getChatAgentOrDefault falls back to default for null", () => {
    const agent = getChatAgentOrDefault(null);
    expect(agent.id).toBe(DEFAULT_CHAT_AGENT_ID);
  });

  it("all agents have unique ids", () => {
    const ids = BUILTIN_CHAT_AGENTS.map((agent) => agent.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all agents have non-empty system prompt templates", () => {
    for (const agent of BUILTIN_CHAT_AGENTS) {
      expect(agent.systemPromptTemplate.length).toBeGreaterThan(0);
    }
  });
});

describe("resolveAgentRuntime", () => {
  it("resolves the default agent when no id is given", () => {
    const runtime = resolveAgentRuntime(null, makeSettings());
    expect(runtime.agentId).toBe(DEFAULT_CHAT_AGENT_ID);
    expect(runtime.agentName).toBeTruthy();
    expect(runtime.enabledTools.length).toBeGreaterThan(0);
  });

  it("resolves a specific agent by id", () => {
    const runtime = resolveAgentRuntime("agent-code-reviewer", makeSettings());
    expect(runtime.agentId).toBe("agent-code-reviewer");
    expect(runtime.enabledTools).not.toContain("propose_file_edit");
    expect(runtime.enabledTools).toContain("read_file");
  });

  it("falls back to default for unknown agent id", () => {
    const runtime = resolveAgentRuntime("unknown-agent", makeSettings());
    expect(runtime.agentId).toBe(DEFAULT_CHAT_AGENT_ID);
  });

  it("resolves from a ConversationAgentBinding", () => {
    const binding = createAgentBinding(
      "agent-architect",
      {
        vendorId: DEFAULT_SETTINGS.activeVendorId!,
        modelId: DEFAULT_SETTINGS.activeModelId!,
      },
      "user-override",
      "架构师",
    );
    const runtime = resolveAgentRuntime(binding, makeSettings());
    expect(runtime.agentId).toBe("agent-architect");
  });

  it("uses model ref from active model selection", () => {
    const runtime = resolveAgentRuntime(null, makeSettings());
    expect(runtime.modelRef).toBeTruthy();
  });

  it("honours binding model selection instead of global active model", () => {
    const vendor = createVendorConfig("Alt Vendor", "openai-chat-completions", "http://alt:4000");
    const model = createManagedModel(vendor.id, "alt-model/big");

    const settings = makeSettings({
      vendors: [...DEFAULT_SETTINGS.vendors, vendor],
      managedModels: [...DEFAULT_SETTINGS.managedModels, model],
    });

    const binding = createAgentBinding(
      "agent-fullstack",
      { vendorId: vendor.id, modelId: model.id },
      "default",
      "全栈工程师",
    );
    const runtime = resolveAgentRuntime(binding, settings);

    expect(runtime.vendorId).toBe(vendor.id);
    expect(runtime.modelId).toBe(model.id);
    expect(runtime.modelRef).toBe("alt-model/big");
    expect(runtime.baseUrl).toBe("http://alt:4000");
  });

  it("uses the agent fixed model when no binding is present", () => {
    const vendor = createVendorConfig("Agent Vendor", "openai-chat-completions", "http://agent:4000");
    const model = createManagedModel(vendor.id, "agent-model/pro");
    const settings = makeSettings({
      vendors: [...DEFAULT_SETTINGS.vendors, vendor],
      managedModels: [...DEFAULT_SETTINGS.managedModels, model],
      builtinAgentOverrides: {
        "agent-fullstack": {
          modelSelection: {
            vendorId: vendor.id,
            modelId: model.id,
          },
        },
      },
    });

    const runtime = resolveAgentRuntime("agent-fullstack", settings);

    expect(runtime.vendorId).toBe(vendor.id);
    expect(runtime.modelId).toBe(model.id);
    expect(runtime.modelRef).toBe("agent-model/pro");
    expect(runtime.baseUrl).toBe("http://agent:4000");
  });

  it("falls back to the global active model when binding references a deleted model", () => {
    const settings = makeSettings();
    const binding = createAgentBinding(
      "agent-fullstack",
      { vendorId: "vendor-missing", modelId: "model-missing" },
      "default",
      "全栈工程师",
    );
    const runtime = resolveAgentRuntime(binding, settings);

    expect(runtime.vendorId).toBe(DEFAULT_SETTINGS.activeVendorId);
    expect(runtime.modelId).toBe(DEFAULT_SETTINGS.activeModelId);
    expect(runtime.modelRef).toBeTruthy();
  });
});

describe("createAgentBinding", () => {
  it("creates a binding with correct fields", () => {
    const binding = createAgentBinding(
      "agent-qa",
      { vendorId: "vendor-1", modelId: "model-1" },
      "default",
      "QA 工程师",
      { vendorName: "OpenAI", modelName: "gpt-4.1" },
    );
    expect(binding.agentId).toBe("agent-qa");
    expect(binding.vendorId).toBe("vendor-1");
    expect(binding.modelId).toBe("model-1");
    expect(binding.bindingSource).toBe("default");
    expect(binding.agentNameSnapshot).toBe("QA 工程师");
    expect(binding.vendorNameSnapshot).toBe("OpenAI");
    expect(binding.modelNameSnapshot).toBe("gpt-4.1");
    expect(binding.boundAt).toBeTruthy();
  });
});

describe("buildScopedSessionKey", () => {
  it("builds a scoped key when conversationId is given", () => {
    const key = buildScopedSessionKey("conv-123", "agent-fullstack");
    expect(key).toBe("csess:conv-123:agent-fullstack");
  });

  it("includes only conversation when agentId is missing", () => {
    const key = buildScopedSessionKey("conv-456");
    expect(key).toBe("csess:conv-456");
  });
});

describe("settings v3 migration", () => {
  it("DEFAULT_SETTINGS has agent fields", () => {
    expect(DEFAULT_SETTINGS.activeAgentId).toBeNull();
    expect(Array.isArray(DEFAULT_SETTINGS.customAgents)).toBe(true);
    expect(DEFAULT_SETTINGS.customAgents.length).toBe(0);
    expect(DEFAULT_SETTINGS.builtinAgentOverrides).toEqual({});
  });
});
