import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../lib/settingsStore";
import { assembleRuntimeContext, assembleSystemPrompt } from "./promptAssembly";
import type { ResolvedAgentRuntime } from "./types";

function createRuntime(
  overrides: Partial<ResolvedAgentRuntime> = {},
): ResolvedAgentRuntime {
  return {
    agentId: "agent-general",
    agentName: "General",
    systemPrompt: "system prompt",
    enabledTools: ["read_file"],
    toolPermissions: {
      ...DEFAULT_SETTINGS.toolPermissions,
      read_file: "auto",
    },
    vendorId: "vendor-test",
    modelId: "model-test",
    modelRef: "vendor-test/model-test",
    vendorProtocol: "openai-chat-completions",
    baseUrl: "http://localhost:4000",
    apiKey: "",
    ...overrides,
  };
}

describe("promptAssembly system prompt", () => {
  it("includes agent system prompt", () => {
    const prompt = assembleSystemPrompt(
      createRuntime({
        enabledTools: ["read_file"],
      }),
    );

    expect(prompt).toContain("system prompt");
  });

  it("does not include sub-agent delegation rules (removed)", () => {
    const prompt = assembleSystemPrompt(
      createRuntime({
        enabledTools: ["read_file"],
      }),
    );

    expect(prompt).not.toContain("## Sub-Agent 委派");
  });

  it("includes runtime context tools", () => {
    const runtimeContext = assembleRuntimeContext(
      createRuntime({
        enabledTools: ["read_file"],
      }),
      "/workspace",
      ["update_plan"],
    );

    expect(runtimeContext).toContain("本轮可用工具");
  });
});
