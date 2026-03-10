import { describe, expect, it } from "vitest";
import { DEFAULT_AGENTS } from "../src/agents/defaultAgents";
import { BUILTIN_CHAT_AGENTS } from "../src/agents/builtinChatAgents";
import { resolveAgentRuntime } from "../src/agents/resolveAgentRuntime";
import { DEFAULT_SETTINGS } from "../src/lib/settingsStore";
import { runWithConcurrencyLimit } from "../src/lib/concurrency";

function makeSettings() {
  return { ...DEFAULT_SETTINGS };
}

describe("batch_read_files tool availability", () => {
  it("all DEFAULT_AGENTS that have read_file also have batch_read_files", () => {
    for (const agent of DEFAULT_AGENTS) {
      if (agent.tools.includes("read_file")) {
        expect(
          agent.tools,
          `Agent "${agent.role}" has read_file but missing batch_read_files`,
        ).toContain("batch_read_files");
      }
    }
  });

  it("all BUILTIN_CHAT_AGENTS with read_file in enabledTools also have batch_read_files", () => {
    for (const agent of BUILTIN_CHAT_AGENTS) {
      const enabled = agent.toolPolicy.enabledTools;
      if (enabled && enabled.includes("read_file")) {
        expect(
          enabled,
          `Chat agent "${agent.id}" has read_file but missing batch_read_files`,
        ).toContain("batch_read_files");
      }
    }
  });

  it("fullstack agent resolves with batch_read_files in enabledTools", () => {
    const runtime = resolveAgentRuntime("agent-fullstack", makeSettings());
    expect(runtime.enabledTools).toContain("batch_read_files");
  });

  it("code reviewer agent resolves with batch_read_files in enabledTools", () => {
    const runtime = resolveAgentRuntime("agent-code-reviewer", makeSettings());
    expect(runtime.enabledTools).toContain("batch_read_files");
  });
});

describe("concurrency limits for performance", () => {
  it("runWithConcurrencyLimit handles 8 concurrent tasks", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    const makeTask = (id: number) => async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 5));
      concurrent--;
      return id;
    };

    const results = await runWithConcurrencyLimit(
      Array.from({ length: 10 }, (_, i) => makeTask(i)),
      8,
    );

    expect(maxConcurrent).toBeLessThanOrEqual(8);
    expect(maxConcurrent).toBeGreaterThan(1);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(10);
  });

  it("runWithConcurrencyLimit handles 5 concurrent tasks (sub-agent limit)", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    const makeTask = (id: number) => async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 5));
      concurrent--;
      return id;
    };

    const results = await runWithConcurrencyLimit(
      Array.from({ length: 8 }, (_, i) => makeTask(i)),
      5,
    );

    expect(maxConcurrent).toBeLessThanOrEqual(5);
    expect(maxConcurrent).toBeGreaterThan(1);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(8);
  });
});
