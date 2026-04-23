import { describe, expect, it } from "vitest";
import {
  BUILTIN_CHAT_AGENTS,
  DEFAULT_CHAT_AGENT_ID,
  getBuiltinChatAgent,
  getChatAgentFromSettings,
} from "../src/agents/builtinChatAgents";
import { resolveAgentRuntime, createAgentBinding } from "../src/agents/resolveAgentRuntime";
import { assembleSystemPrompt, assembleRuntimeContext } from "../src/agents/promptAssembly";
import { selectAgentTools } from "../src/agents/toolPolicy";
import { buildScopedSessionKey } from "../src/orchestrator/checkpointStore";
import { DEFAULT_SETTINGS, createVendorConfig, createManagedModel } from "../src/lib/settingsStore";
import type { AppSettings } from "../src/lib/settingsStore";
import type { LiteLLMToolDefinition } from "../src/lib/litellm";
import type { ChatAgentDefinition } from "../src/agents/types";

function makeSettings(overrides?: Partial<AppSettings>): AppSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

describe("builtinChatAgents", () => {
  it("should have exactly 1 agent", () => {
    expect(BUILTIN_CHAT_AGENTS.length).toBe(1);
  });

  it("default agent id should be found in the list", () => {
    const agent = getBuiltinChatAgent(DEFAULT_CHAT_AGENT_ID);
    expect(agent).not.toBeNull();
    expect(agent!.id).toBe(DEFAULT_CHAT_AGENT_ID);
  });

  it("getChatAgentFromSettings falls back to default for unknown id", () => {
    const agent = getChatAgentFromSettings("nonexistent-agent", DEFAULT_SETTINGS);
    expect(agent.id).toBe(DEFAULT_CHAT_AGENT_ID);
  });

  it("getChatAgentFromSettings falls back to default for null", () => {
    const agent = getChatAgentFromSettings(null, DEFAULT_SETTINGS);
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
    const runtime = resolveAgentRuntime("agent-general", makeSettings());
    expect(runtime.agentId).toBe("agent-general");
    expect(runtime.enabledTools).toContain("read_file");
  });

  it("falls back to default for unknown agent id", () => {
    const runtime = resolveAgentRuntime("unknown-agent", makeSettings());
    expect(runtime.agentId).toBe(DEFAULT_CHAT_AGENT_ID);
  });

  it("resolves from a ConversationAgentBinding", () => {
    const binding = createAgentBinding(
      "agent-general",
      {
        vendorId: DEFAULT_SETTINGS.activeVendorId!,
        modelId: DEFAULT_SETTINGS.activeModelId!,
      },
      "user-override",
      "通用 Agent",
    );
    const runtime = resolveAgentRuntime(binding, makeSettings());
    expect(runtime.agentId).toBe("agent-general");
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
      "agent-general",
      { vendorId: vendor.id, modelId: model.id },
      "default",
      "通用 Agent",
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
        "agent-general": {
          modelSelection: {
            vendorId: vendor.id,
            modelId: model.id,
          },
        },
      },
    });

    const runtime = resolveAgentRuntime("agent-general", settings);

    expect(runtime.vendorId).toBe(vendor.id);
    expect(runtime.modelId).toBe(model.id);
    expect(runtime.modelRef).toBe("agent-model/pro");
    expect(runtime.baseUrl).toBe("http://agent:4000");
  });

  it("falls back to the global active model when binding references a deleted model", () => {
    const settings = makeSettings();
    const binding = createAgentBinding(
      "agent-general",
      { vendorId: "vendor-missing", modelId: "model-missing" },
      "default",
      "通用 Agent",
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
      "agent-general",
      { vendorId: "vendor-1", modelId: "model-1" },
      "default",
      "通用 Agent",
      { vendorName: "OpenAI", modelName: "gpt-4.1" },
    );
    expect(binding.agentId).toBe("agent-general");
    expect(binding.vendorId).toBe("vendor-1");
    expect(binding.modelId).toBe("model-1");
    expect(binding.bindingSource).toBe("default");
    expect(binding.agentNameSnapshot).toBe("通用 Agent");
    expect(binding.vendorNameSnapshot).toBe("OpenAI");
    expect(binding.modelNameSnapshot).toBe("gpt-4.1");
    expect(binding.boundAt).toBeTruthy();
  });
});

describe("buildScopedSessionKey", () => {
  it("builds a scoped key when conversationId is given", () => {
    const key = buildScopedSessionKey("conv-123", "agent-general");
    expect(key).toBe("csess:conv-123:agent-general");
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

// --- Agent tool wiring tests ---

const FAKE_TOOL_DEFS: LiteLLMToolDefinition[] = [
  { type: "function", function: { name: "list_files", description: "", parameters: { type: "object" } } },
  { type: "function", function: { name: "read_file", description: "", parameters: { type: "object" } } },
  { type: "function", function: { name: "grep", description: "", parameters: { type: "object" } } },
  { type: "function", function: { name: "glob", description: "", parameters: { type: "object" } } },
  { type: "function", function: { name: "git_status", description: "", parameters: { type: "object" } } },
  { type: "function", function: { name: "git_diff", description: "", parameters: { type: "object" } } },
  { type: "function", function: { name: "propose_file_edit", description: "", parameters: { type: "object" } } },
  { type: "function", function: { name: "propose_apply_patch", description: "", parameters: { type: "object" } } },
  { type: "function", function: { name: "propose_shell", description: "", parameters: { type: "object" } } },
  { type: "function", function: { name: "diagnostics", description: "", parameters: { type: "object" } } },
  { type: "function", function: { name: "fetch", description: "", parameters: { type: "object" } } },
];

describe("selectAgentTools", () => {
  it("general agent sees propose_file_edit and propose_apply_patch", () => {
    const runtime = resolveAgentRuntime("agent-general", makeSettings());
    const ctx = selectAgentTools(runtime, FAKE_TOOL_DEFS);
    const toolNames = ctx.visibleToolDefs.map((t) => t.function.name);
    expect(toolNames).toContain("propose_file_edit");
    expect(toolNames).toContain("read_file");
    expect(toolNames).toContain("grep");
  });

  it("general agent does not see task tool (removed)", () => {
    const runtime = resolveAgentRuntime("agent-general", makeSettings());
    const ctx = selectAgentTools(runtime, FAKE_TOOL_DEFS);
    const toolNames = ctx.visibleToolDefs.map((t) => t.function.name);
    expect(toolNames).not.toContain("task");
  });
});

describe("assembleSystemPrompt", () => {
  it("includes agent-specific prompt template", () => {
    const runtime = resolveAgentRuntime("agent-general", makeSettings());
    const prompt = assembleSystemPrompt(runtime);
    expect(prompt).toContain("你是 Cofree 的通用 AI 编程助手");
  });

  it("includes base workflow rules", () => {
    const runtime = resolveAgentRuntime("agent-general", makeSettings());
    const prompt = assembleSystemPrompt(runtime);
    expect(prompt).toContain("propose_file_edit");
  });

  it("different custom agents produce different prompts", () => {
    const customAgent: ChatAgentDefinition = {
      id: "agent-custom-prompt",
      name: "Custom",
      description: "custom",
      systemPromptTemplate: "Custom unique prompt content XYZ",
      toolPolicy: {},
      builtin: false,
    };
    const settings = makeSettings({
      customAgents: [customAgent],
      activeAgentId: customAgent.id,
    });
    const generalPrompt = assembleSystemPrompt(resolveAgentRuntime("agent-general", makeSettings()));
    const customPrompt = assembleSystemPrompt(resolveAgentRuntime(customAgent.id, settings));
    expect(generalPrompt).not.toBe(customPrompt);
  });
});

describe("assembleRuntimeContext", () => {
  it("includes workspace path", () => {
    const runtime = resolveAgentRuntime("agent-general", makeSettings({ workspacePath: "/test/workspace" }));
    const ctx = assembleRuntimeContext(runtime, "/test/workspace");
    expect(ctx).toContain("/test/workspace");
  });

});
