import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHAT_AGENT,
  DEFAULT_CHAT_AGENT_ID,
  getChatAgent,
} from "../src/agents/builtinChatAgents";
import {
  resolveAgentRuntime,
  createAgentBinding,
} from "../src/agents/resolveAgentRuntime";
import {
  assembleSystemPrompt,
  assembleRuntimeContext,
} from "../src/agents/promptAssembly";
import { selectAgentTools } from "../src/agents/toolPolicy";
import { buildScopedSessionKey } from "../src/orchestrator/checkpointStore";
import {
  DEFAULT_SETTINGS,
  createVendorConfig,
  createManagedModel,
} from "../src/lib/settingsStore";
import type { AppSettings } from "../src/lib/settingsStore";
import type { LiteLLMToolDefinition } from "../src/lib/litellm";

function makeSettings(overrides?: Partial<AppSettings>): AppSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

describe("builtin chat agent", () => {
  it("default agent id is exposed as a constant", () => {
    expect(DEFAULT_CHAT_AGENT.id).toBe(DEFAULT_CHAT_AGENT_ID);
    expect(DEFAULT_CHAT_AGENT.systemPromptTemplate.length).toBeGreaterThan(0);
  });

  it("getChatAgent always returns the default agent", () => {
    expect(getChatAgent(null).id).toBe(DEFAULT_CHAT_AGENT_ID);
    expect(getChatAgent("anything").id).toBe(DEFAULT_CHAT_AGENT_ID);
  });
});

describe("resolveAgentRuntime", () => {
  it("resolves the default agent when no id is given", () => {
    const runtime = resolveAgentRuntime(null, makeSettings());
    expect(runtime.agentId).toBe(DEFAULT_CHAT_AGENT_ID);
    expect(runtime.agentName).toBeTruthy();
    expect(runtime.enabledTools.length).toBeGreaterThan(0);
  });

  it("honours binding model selection instead of global active model", () => {
    const vendor = createVendorConfig(
      "Alt Vendor",
      "openai-chat-completions",
      "http://alt:4000",
    );
    const model = createManagedModel(vendor.id, "alt-model/big");

    const settings = makeSettings({
      vendors: [...DEFAULT_SETTINGS.vendors, vendor],
      managedModels: [...DEFAULT_SETTINGS.managedModels, model],
    });

    const binding = createAgentBinding(
      DEFAULT_CHAT_AGENT_ID,
      { vendorId: vendor.id, modelId: model.id },
      "default",
      DEFAULT_CHAT_AGENT.name,
    );
    const runtime = resolveAgentRuntime(binding, settings);

    expect(runtime.vendorId).toBe(vendor.id);
    expect(runtime.modelId).toBe(model.id);
    expect(runtime.modelRef).toBe("alt-model/big");
    expect(runtime.baseUrl).toBe("http://alt:4000");
  });

  it("falls back to the global active model when binding references a deleted model", () => {
    const settings = makeSettings();
    const binding = createAgentBinding(
      DEFAULT_CHAT_AGENT_ID,
      { vendorId: "vendor-missing", modelId: "model-missing" },
      "default",
      DEFAULT_CHAT_AGENT.name,
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
      DEFAULT_CHAT_AGENT_ID,
      { vendorId: "vendor-1", modelId: "model-1" },
      "default",
      DEFAULT_CHAT_AGENT.name,
      { vendorName: "OpenAI", modelName: "gpt-4.1" },
    );
    expect(binding.agentId).toBe(DEFAULT_CHAT_AGENT_ID);
    expect(binding.vendorId).toBe("vendor-1");
    expect(binding.modelId).toBe("model-1");
    expect(binding.bindingSource).toBe("default");
    expect(binding.agentNameSnapshot).toBe(DEFAULT_CHAT_AGENT.name);
    expect(binding.vendorNameSnapshot).toBe("OpenAI");
    expect(binding.modelNameSnapshot).toBe("gpt-4.1");
    expect(binding.boundAt).toBeTruthy();
  });
});

describe("buildScopedSessionKey", () => {
  it("builds a scoped key when conversationId is given", () => {
    const key = buildScopedSessionKey("conv-123", DEFAULT_CHAT_AGENT_ID);
    expect(key).toBe(`csess:conv-123:${DEFAULT_CHAT_AGENT_ID}`);
  });

  it("includes only conversation when agentId is missing", () => {
    const key = buildScopedSessionKey("conv-456");
    expect(key).toBe("csess:conv-456");
  });
});

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
  it("default agent sees read and write tools", () => {
    const runtime = resolveAgentRuntime(DEFAULT_CHAT_AGENT_ID, makeSettings());
    const ctx = selectAgentTools(runtime, FAKE_TOOL_DEFS);
    const toolNames = ctx.visibleToolDefs.map((t) => t.function.name);
    expect(toolNames).toContain("propose_file_edit");
    expect(toolNames).toContain("read_file");
    expect(toolNames).toContain("grep");
  });

  it("default agent does not see unknown tools", () => {
    const runtime = resolveAgentRuntime(DEFAULT_CHAT_AGENT_ID, makeSettings());
    const ctx = selectAgentTools(runtime, FAKE_TOOL_DEFS);
    const toolNames = ctx.visibleToolDefs.map((t) => t.function.name);
    expect(toolNames).not.toContain("task");
  });
});

describe("assembleSystemPrompt", () => {
  it("includes agent-specific prompt template", () => {
    const runtime = resolveAgentRuntime(DEFAULT_CHAT_AGENT_ID, makeSettings());
    const prompt = assembleSystemPrompt(runtime);
    expect(prompt).toContain("你是 Cofree 的通用 AI 编程助手");
  });

  it("includes base workflow rules", () => {
    const runtime = resolveAgentRuntime(DEFAULT_CHAT_AGENT_ID, makeSettings());
    const prompt = assembleSystemPrompt(runtime);
    expect(prompt).toContain("propose_file_edit");
  });
});

describe("assembleRuntimeContext", () => {
  it("includes workspace path", () => {
    const runtime = resolveAgentRuntime(
      DEFAULT_CHAT_AGENT_ID,
      makeSettings({ workspacePath: "/test/workspace" }),
    );
    const ctx = assembleRuntimeContext(runtime, "/test/workspace");
    expect(ctx).toContain("/test/workspace");
  });
});
