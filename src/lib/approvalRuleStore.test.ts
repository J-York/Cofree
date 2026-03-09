import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionProposal } from "../orchestrator/types";
import {
  addWorkspaceApprovalRule,
  buildApprovalRuleOptions,
  extractShellApprovalPrefixes,
  findMatchingApprovalRule,
  getWorkspaceApprovalRuleStorageKey,
  loadWorkspaceApprovalRules,
  matchesApprovalRule,
} from "./approvalRuleStore";

class MemoryStorage implements Storage {
  private data = new Map<string, string>();

  get length(): number {
    return this.data.size;
  }

  clear(): void {
    this.data.clear();
  }

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.data.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

function createShellAction(shell: string): ActionProposal {
  return {
    id: "shell-1",
    type: "shell",
    description: "Run shell",
    gateRequired: true,
    status: "pending",
    executed: false,
    fingerprint: `shell:${shell}:120000`,
    payload: {
      shell,
      timeoutMs: 120000,
    },
  };
}

describe("approvalRuleStore", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { localStorage: new MemoryStorage() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stores approval rules per workspace", () => {
    addWorkspaceApprovalRule("/repo/a", {
      kind: "shell_command_prefix",
      commandTokens: ["git", "add"],
    });

    expect(loadWorkspaceApprovalRules("/repo/a")).toHaveLength(1);
    expect(loadWorkspaceApprovalRules("/repo/b")).toHaveLength(0);
    expect(window.localStorage.getItem(getWorkspaceApprovalRuleStorageKey("/repo/a"))).toContain("git");
  });

  it("deduplicates identical approval rules", () => {
    addWorkspaceApprovalRule("/repo/a", {
      kind: "shell_command_prefix",
      commandTokens: ["git"],
    });
    const second = addWorkspaceApprovalRule("/repo/a", {
      kind: "shell_command_prefix",
      commandTokens: ["git"],
    });

    expect(second.added).toBe(false);
    expect(loadWorkspaceApprovalRules("/repo/a")).toHaveLength(1);
  });

  it("extracts shell approval prefixes for first and second command levels", () => {
    expect(extractShellApprovalPrefixes("git -C repo add .")).toEqual([
      ["git"],
      ["git", "add"],
    ]);
  });

  it("matches shell prefix rules and exact action fingerprints", () => {
    const action = createShellAction("git add src/app.ts");

    expect(
      matchesApprovalRule(
        {
          kind: "shell_command_prefix",
          commandTokens: ["git"],
        },
        action,
      ),
    ).toBe(true);
    expect(
      matchesApprovalRule(
        {
          kind: "shell_command_prefix",
          commandTokens: ["git", "add"],
        },
        action,
      ),
    ).toBe(true);
    expect(
      matchesApprovalRule(
        {
          kind: "action_fingerprint",
          actionType: "shell",
          fingerprint: "shell:git add src/app.ts:120000",
        },
        action,
      ),
    ).toBe(true);
  });

  it("finds the first matching workspace rule for a shell action", () => {
    addWorkspaceApprovalRule("/repo/a", {
      kind: "shell_command_prefix",
      commandTokens: ["git", "add"],
    });

    const match = findMatchingApprovalRule("/repo/a", createShellAction("git add src/app.ts"));

    expect(match).toMatchObject({
      kind: "shell_command_prefix",
      commandTokens: ["git", "add"],
    });
  });

  it("builds UI approval options for exact and prefix rules", () => {
    const options = buildApprovalRuleOptions(createShellAction("git add src/app.ts"));

    expect(options.map((option) => option.label)).toEqual([
      "当前完整命令",
      "git xxx",
      "git add xxx",
    ]);
  });

  it("does not offer prefix approvals for chained shell commands", () => {
    const options = buildApprovalRuleOptions(createShellAction("git add src/app.ts && git commit -m test"));

    expect(options.map((option) => option.label)).toEqual([
      "当前完整命令",
    ]);
  });
});
