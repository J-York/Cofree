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
  it("includes ask_user for default general agent", () => {
    const runtime = resolveAgentRuntime("agent-general", createSettings());
    expect(runtime.enabledTools).toContain("ask_user");
  });

  it("includes ask_user even for custom agent with explicit enabledTools", () => {
    const customAgent: ChatAgentDefinition = {
      id: "agent-custom-ask",
      name: "Custom Ask",
      description: "custom",
      systemPromptTemplate: "custom prompt",
      toolPolicy: {
        enabledTools: ["read_file"],
      },
      builtin: false,
    };
    const settings = createSettings({
      customAgents: [customAgent],
      activeAgentId: customAgent.id,
    });
    const runtime = resolveAgentRuntime(customAgent.id, settings);
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

  it("general agent has write tools", () => {
    const runtime = resolveAgentRuntime("agent-general", createSettings());
    expect(runtime.enabledTools).toContain("ask_user");
    expect(runtime.enabledTools).toContain("read_file");
    expect(runtime.enabledTools).toContain("propose_file_edit");
  });
});
