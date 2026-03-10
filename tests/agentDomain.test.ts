import { describe, expect, it } from "vitest";
import {
  BUILTIN_CHAT_AGENTS,
  DEFAULT_CHAT_AGENT_ID,
  getBuiltinChatAgent,
  getChatAgentOrDefault,
} from "../src/agents/builtinChatAgents";
import { resolveAgentRuntime, createAgentBinding } from "../src/agents/resolveAgentRuntime";
import { assembleSystemPrompt, assembleRuntimeContext } from "../src/agents/promptAssembly";
import { selectAgentTools } from "../src/agents/toolPolicy";
import { buildScopedSessionKey } from "../src/orchestrator/checkpointStore";
import { DEFAULT_SETTINGS, createVendorConfig, createManagedModel } from "../src/lib/settingsStore";
import type { AppSettings } from "../src/lib/settingsStore";
import type { LiteLLMToolDefinition } from "../src/lib/litellm";

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

// --- Sub-Agent delegation wiring tests ---

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
  { type: "function", function: { name: "task", description: "", parameters: { type: "object", properties: { role: { type: "string", enum: ["planner", "coder", "tester"] } } } } },
];

describe("selectAgentTools", () => {
  it("code reviewer does not see propose_file_edit or propose_apply_patch", () => {
    const runtime = resolveAgentRuntime("agent-code-reviewer", makeSettings());
    const ctx = selectAgentTools(runtime, FAKE_TOOL_DEFS);
    const toolNames = ctx.visibleToolDefs.map((t) => t.function.name);
    expect(toolNames).not.toContain("propose_file_edit");
    expect(toolNames).not.toContain("propose_apply_patch");
    expect(toolNames).toContain("read_file");
    expect(toolNames).toContain("grep");
  });

  it("fullstack agent sees all tools including task", () => {
    const runtime = resolveAgentRuntime("agent-fullstack", makeSettings());
    const ctx = selectAgentTools(runtime, FAKE_TOOL_DEFS);
    const toolNames = ctx.visibleToolDefs.map((t) => t.function.name);
    expect(toolNames).toContain("propose_file_edit");
    expect(toolNames).toContain("task");
  });

  it("QA agent allowedSubAgents is only tester", () => {
    const runtime = resolveAgentRuntime("agent-qa", makeSettings());
    expect(runtime.allowedSubAgents).toEqual(["tester", "reviewer"]);
  });

  it("fullstack agent allowedSubAgents includes all three roles", () => {
    const runtime = resolveAgentRuntime("agent-fullstack", makeSettings());
    expect(runtime.allowedSubAgents).toEqual(["planner", "coder", "tester", "debugger", "reviewer"]);
  });
});

describe("assembleSystemPrompt", () => {
  it("includes agent-specific prompt template", () => {
    const runtime = resolveAgentRuntime("agent-code-reviewer", makeSettings());
    const prompt = assembleSystemPrompt(runtime);
    expect(prompt).toContain("代码审查员");
  });

  it("includes base workflow rules", () => {
    const runtime = resolveAgentRuntime("agent-fullstack", makeSettings());
    const prompt = assembleSystemPrompt(runtime);
    expect(prompt).toContain("propose_file_edit");
    expect(prompt).toContain("Sub-Agent");
  });

  it("different agents produce different prompts", () => {
    const fullstackPrompt = assembleSystemPrompt(resolveAgentRuntime("agent-fullstack", makeSettings()));
    const reviewerPrompt = assembleSystemPrompt(resolveAgentRuntime("agent-code-reviewer", makeSettings()));
    expect(fullstackPrompt).not.toBe(reviewerPrompt);
  });
});

describe("assembleRuntimeContext", () => {
  it("includes workspace path", () => {
    const runtime = resolveAgentRuntime("agent-fullstack", makeSettings({ workspacePath: "/test/workspace" }));
    const ctx = assembleRuntimeContext(runtime, "/test/workspace");
    expect(ctx).toContain("/test/workspace");
  });

  it("lists only allowed sub-agent roles for the agent", () => {
    const reviewerRuntime = resolveAgentRuntime("agent-code-reviewer", makeSettings());
    const ctx = assembleRuntimeContext(reviewerRuntime, "/test");
    expect(ctx).toContain("planner");
    expect(ctx).not.toContain("coder");
    expect(ctx).not.toContain("tester");
  });

  it("lists all three roles for fullstack agent", () => {
    const runtime = resolveAgentRuntime("agent-fullstack", makeSettings());
    const ctx = assembleRuntimeContext(runtime, "/test");
    expect(ctx).toContain("planner");
    expect(ctx).toContain("coder");
    expect(ctx).toContain("tester");
  });

  it("does not include update_plan in 本轮可用工具 when no internalTools passed", () => {
    const runtime = resolveAgentRuntime("agent-fullstack", makeSettings());
    const ctx = assembleRuntimeContext(runtime, "/test");
    // Without internalTools, update_plan must NOT appear in the main tools line
    const toolsLine = ctx.split("\n").find((line) => line.startsWith("本轮可用工具:"));
    expect(toolsLine, "本轮可用工具 line should exist in context").toBeDefined();
    expect(toolsLine).not.toContain("update_plan");
  });

  it("includes update_plan in 本轮可用工具 when passed as internalTools", () => {
    const runtime = resolveAgentRuntime("agent-fullstack", makeSettings());
    const ctx = assembleRuntimeContext(runtime, "/test", ["update_plan"]);
    const toolsLine = ctx.split("\n").find((line) => line.startsWith("本轮可用工具:"));
    expect(toolsLine, "本轮可用工具 line should exist in context").toBeDefined();
    expect(toolsLine).toContain("update_plan");
  });

  it("includes update_plan in 自动执行工具 when passed as internalTools", () => {
    const runtime = resolveAgentRuntime("agent-fullstack", makeSettings());
    const ctx = assembleRuntimeContext(runtime, "/test", ["update_plan"]);
    const autoLine = ctx.split("\n").find((line) => line.startsWith("自动执行工具"));
    expect(autoLine, "自动执行工具 line should exist in context").toBeDefined();
    expect(autoLine).toContain("update_plan");
    // update_plan must NOT appear in the ask/approval list
    const askLine = ctx.split("\n").find((line) => line.startsWith("需审批工具:"));
    expect(askLine).not.toContain("update_plan");
  });
});
