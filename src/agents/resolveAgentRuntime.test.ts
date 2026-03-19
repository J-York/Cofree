import { describe, expect, it } from "vitest";
import { resolveAgentRuntime } from "./resolveAgentRuntime";
import {
  DEFAULT_SETTINGS,
  type AppSettings,
} from "../lib/settingsStore";
import type { ChatAgentDefinition } from "./types";

function createSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...overrides,
    toolPermissions: {
      ...DEFAULT_SETTINGS.toolPermissions,
      ...(overrides.toolPermissions ?? {}),
    },
    customAgents: overrides.customAgents ?? DEFAULT_SETTINGS.customAgents,
    builtinAgentOverrides:
      overrides.builtinAgentOverrides ?? DEFAULT_SETTINGS.builtinAgentOverrides,
    vendors: overrides.vendors ?? DEFAULT_SETTINGS.vendors,
    managedModels: overrides.managedModels ?? DEFAULT_SETTINGS.managedModels,
  };
}

describe("resolveAgentRuntime ask_user visibility", () => {
  it("includes ask_user for default fullstack agent", () => {
    const runtime = resolveAgentRuntime("agent-fullstack", createSettings());
    expect(runtime.enabledTools).toContain("ask_user");
  });

  it("includes ask_user even when builtin agent uses explicit enabledTools", () => {
    const runtime = resolveAgentRuntime("agent-code-reviewer", createSettings());
    expect(runtime.enabledTools).toContain("ask_user");
  });

  it("includes ask_user for custom agents with explicit tool lists", () => {
    const customAgent: ChatAgentDefinition = {
      id: "agent-custom-test",
      name: "Custom Test",
      description: "custom",
      systemPromptTemplate: "custom prompt",
      toolPolicy: {
        enabledTools: ["read_file"],
      },
      allowedSubAgents: [],
      builtin: false,
    };
    const settings = createSettings({
      customAgents: [customAgent],
      activeAgentId: customAgent.id,
    });

    const runtime = resolveAgentRuntime(customAgent.id, settings);
    expect(runtime.enabledTools).toEqual(
      expect.arrayContaining(["read_file", "ask_user"]),
    );
  });
});

describe("resolveAgentRuntime task visibility", () => {
  function createCustomAgent(
    overrides: Partial<ChatAgentDefinition> = {},
  ): ChatAgentDefinition {
    return {
      id: "agent-custom-task-test",
      name: "Custom Task Test",
      description: "custom",
      systemPromptTemplate: "custom prompt",
      toolPolicy: {
        enabledTools: ["read_file", "task"],
      },
      allowedSubAgents: ["planner"],
      handoffPolicy: "none",
      builtin: false,
      ...overrides,
    };
  }

  it("hides task when handoffPolicy is none", () => {
    const agent = createCustomAgent({ handoffPolicy: "none" });
    const runtime = resolveAgentRuntime(
      agent.id,
      createSettings({ customAgents: [agent], activeAgentId: agent.id }),
    );
    expect(runtime.enabledTools).not.toContain("task");
  });

  it("shows task when handoffPolicy is sequential", () => {
    const agent = createCustomAgent({ handoffPolicy: "sequential" });
    const runtime = resolveAgentRuntime(
      agent.id,
      createSettings({ customAgents: [agent], activeAgentId: agent.id }),
    );
    expect(runtime.enabledTools).toContain("task");
  });

  it("hides task when no sub-agents are allowed even if policy is parallel", () => {
    const agent = createCustomAgent({
      handoffPolicy: "parallel",
      allowedSubAgents: [],
    });
    const runtime = resolveAgentRuntime(
      agent.id,
      createSettings({ customAgents: [agent], activeAgentId: agent.id }),
    );
    expect(runtime.enabledTools).not.toContain("task");
  });
});
