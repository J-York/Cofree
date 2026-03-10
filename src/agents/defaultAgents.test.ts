import { describe, expect, it } from "vitest";
import { DEFAULT_AGENTS } from "./defaultAgents";

describe("DEFAULT_AGENTS coder tools", () => {
  it("does not expose propose_apply_patch to the coder sub-agent", () => {
    const coder = DEFAULT_AGENTS.find((agent) => agent.role === "coder");

    expect(coder).toBeDefined();
    expect(coder?.tools).toContain("propose_file_edit");
    expect(coder?.tools).not.toContain("propose_apply_patch");
  });
});