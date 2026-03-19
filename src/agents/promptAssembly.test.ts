import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../lib/settingsStore";
import { assembleRuntimeContext, assembleSystemPrompt } from "./promptAssembly";
import type { ResolvedAgentRuntime } from "./types";

function createRuntime(
  overrides: Partial<ResolvedAgentRuntime> = {},
): ResolvedAgentRuntime {
  return {
    agentId: "agent-fullstack",
    agentName: "Fullstack",
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
    allowedSubAgents: [],
    handoffPolicy: "none",
    ...overrides,
  };
}

describe("promptAssembly task delegation guidance", () => {
  it("includes delegation rules when task delegation is enabled", () => {
    const prompt = assembleSystemPrompt(
      createRuntime({
        enabledTools: ["read_file", "task"],
        allowedSubAgents: ["planner"],
        handoffPolicy: "sequential",
      }),
    );

    expect(prompt).toContain("## Sub-Agent 委派");
    expect(prompt).toContain("可使用 task 工具委派给专业 Sub-Agent");
  });

  it("omits delegation rules when handoffPolicy disables task delegation", () => {
    const prompt = assembleSystemPrompt(
      createRuntime({
        enabledTools: ["read_file"],
        allowedSubAgents: ["planner"],
        handoffPolicy: "none",
      }),
    );

    expect(prompt).not.toContain("## Sub-Agent 委派");
  });

  it("explains disabled delegation in runtime context", () => {
    const runtimeContext = assembleRuntimeContext(
      createRuntime({
        enabledTools: ["read_file"],
        allowedSubAgents: ["planner", "coder"],
        handoffPolicy: "none",
      }),
      "/workspace",
      ["update_plan"],
    );

    expect(runtimeContext).toContain("委派策略: none（禁用委派）");
    expect(runtimeContext).toContain("当前已禁用 Sub-Agent 委派，不要调用 task 工具。");
  });
});
