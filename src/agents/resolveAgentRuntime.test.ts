import { describe, expect, it } from "vitest";
import { resolveAgentRuntime } from "./resolveAgentRuntime";
import {
  DEFAULT_SETTINGS,
  type AppSettings,
} from "../lib/settingsStore";

function createSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...overrides,
    toolPermissions: {
      ...DEFAULT_SETTINGS.toolPermissions,
      ...(overrides.toolPermissions ?? {}),
    },
    vendors: overrides.vendors ?? DEFAULT_SETTINGS.vendors,
    managedModels: overrides.managedModels ?? DEFAULT_SETTINGS.managedModels,
  };
}

describe("resolveAgentRuntime", () => {
  it("includes ask_user and all core tools for the default agent", () => {
    const runtime = resolveAgentRuntime("agent-general", createSettings());
    expect(runtime.enabledTools).toContain("ask_user");
    expect(runtime.enabledTools).toContain("read_file");
    expect(runtime.enabledTools).toContain("propose_file_edit");
  });

  it("falls back to the default agent when given a null/unknown id", () => {
    const runtime = resolveAgentRuntime(null, createSettings());
    expect(runtime.agentId).toBe("agent-general");
  });
});
