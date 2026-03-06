import { describe, expect, it } from "vitest";
import { BUILTIN_CHAT_AGENTS, DEFAULT_CHAT_AGENT_ID, getBuiltinChatAgent, getChatAgentOrDefault } from "../src/agents/builtinChatAgents";
import { resolveAgentRuntime, createAgentBinding } from "../src/agents/resolveAgentRuntime";
import { buildScopedSessionKey } from "../src/orchestrator/checkpointStore";
import { DEFAULT_SETTINGS, createVendorConfig, createManagedModel } from "../src/lib/settingsStore";
import type { AppSettings, ModelProfile } from "../src/lib/settingsStore";

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
    const ids = BUILTIN_CHAT_AGENTS.map((a) => a.id);
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
    const binding = createAgentBinding("agent-architect", "profile-default", "user-override", "架构师");
    const runtime = resolveAgentRuntime(binding, makeSettings());
    expect(runtime.agentId).toBe("agent-architect");
  });

  it("uses model ref from active profile", () => {
    const runtime = resolveAgentRuntime(null, makeSettings());
    expect(runtime.modelRef).toBeTruthy();
  });

  it("honours binding profileId instead of global active profile", () => {
    const vendor = createVendorConfig("Alt Vendor", "openai-chat-completions", "http://alt:4000");
    const model = createManagedModel(vendor.id, "alt-model/big");
    const boundProfile: ModelProfile = {
      id: "profile-alt",
      name: "Alt Profile",
      vendorId: vendor.id,
      modelId: model.id,
      model: model.name,
      liteLLMBaseUrl: vendor.baseUrl,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const settings = makeSettings({
      profiles: [...DEFAULT_SETTINGS.profiles, boundProfile],
      vendors: [...DEFAULT_SETTINGS.vendors, vendor],
      managedModels: [...DEFAULT_SETTINGS.managedModels, model],
    });

    const binding = createAgentBinding("agent-fullstack", "profile-alt", "default", "全栈工程师");
    const runtime = resolveAgentRuntime(binding, settings);

    expect(runtime.profileId).toBe("profile-alt");
    expect(runtime.modelRef).toBe("alt-model/big");
    expect(runtime.baseUrl).toBe("http://alt:4000");
  });

  it("falls back to global profile when binding references a deleted profile", () => {
    const settings = makeSettings();
    const binding = createAgentBinding("agent-fullstack", "profile-deleted", "default", "全栈工程师");
    const runtime = resolveAgentRuntime(binding, settings);

    expect(runtime.profileId).toBe(DEFAULT_SETTINGS.profiles[0].id);
    expect(runtime.modelRef).toBeTruthy();
  });
});

describe("createAgentBinding", () => {
  it("creates a binding with correct fields", () => {
    const binding = createAgentBinding("agent-qa", "profile-1", "default", "QA 工程师");
    expect(binding.agentId).toBe("agent-qa");
    expect(binding.profileId).toBe("profile-1");
    expect(binding.bindingSource).toBe("default");
    expect(binding.agentNameSnapshot).toBe("QA 工程师");
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
    expect(Array.isArray(DEFAULT_SETTINGS.agentPreferences)).toBe(true);
    expect(DEFAULT_SETTINGS.agentPreferences.length).toBe(0);
  });
});
