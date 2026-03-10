import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionProposal } from "../orchestrator/types";
import {
  addWorkspaceApprovalRule,
  buildApprovalRuleOptions,
  extractPatchFilePaths,
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

function createPatchAction(patch: string, fingerprint?: string): ActionProposal {
  return {
    id: "patch-1",
    type: "apply_patch",
    description: "Apply patch",
    gateRequired: true,
    status: "pending",
    executed: false,
    fingerprint: fingerprint ?? `apply_patch:modify:src/app.ts:abcd1234`,
    payload: { patch },
  };
}

const SAMPLE_PATCH_APP_TS = [
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,3 @@",
  "-old line",
  "+new line",
].join("\n");

const SAMPLE_PATCH_UTILS_TS = [
  "diff --git a/src/lib/utils.ts b/src/lib/utils.ts",
  "--- a/src/lib/utils.ts",
  "+++ b/src/lib/utils.ts",
  "@@ -1,3 +1,3 @@",
  "-old",
  "+new",
].join("\n");

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

  // ---------------------------------------------------------------------------
  // Patch file-path and directory rules
  // ---------------------------------------------------------------------------

  it("extracts file paths from a unified diff patch", () => {
    expect(extractPatchFilePaths(SAMPLE_PATCH_APP_TS)).toEqual(["src/app.ts"]);
    expect(extractPatchFilePaths(SAMPLE_PATCH_UTILS_TS)).toEqual(["src/lib/utils.ts"]);
  });

  it("builds file-level and directory-level approval options for patch actions", () => {
    const action = createPatchAction(SAMPLE_PATCH_APP_TS);
    const options = buildApprovalRuleOptions(action);

    expect(options.map((opt) => opt.label)).toEqual([
      "当前补丁动作",
      "修改 src/app.ts",
      "修改 src/",
    ]);
  });

  it("builds only exact option when the patch is in a root-level file (no directory)", () => {
    const rootPatch = [
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");
    const action = createPatchAction(rootPatch);
    const options = buildApprovalRuleOptions(action);

    expect(options.map((opt) => opt.label)).toEqual([
      "当前补丁动作",
      "修改 README.md",
      // no directory option because file is in root
    ]);
  });

  it("matches patch_file_path rule when the patch targets the specified file", () => {
    const action = createPatchAction(SAMPLE_PATCH_APP_TS);

    expect(matchesApprovalRule({ kind: "patch_file_path", filePath: "src/app.ts" }, action)).toBe(true);
    expect(matchesApprovalRule({ kind: "patch_file_path", filePath: "src/other.ts" }, action)).toBe(false);
  });

  it("matches patch_directory rule when the patch targets a file inside the directory", () => {
    const action = createPatchAction(SAMPLE_PATCH_UTILS_TS);

    expect(matchesApprovalRule({ kind: "patch_directory", directory: "src/lib" }, action)).toBe(true);
    expect(matchesApprovalRule({ kind: "patch_directory", directory: "src" }, action)).toBe(true);
    expect(matchesApprovalRule({ kind: "patch_directory", directory: "tests" }, action)).toBe(false);
  });

  it("does not match patch rules against shell actions", () => {
    const shellAction = createShellAction("git add src/app.ts");

    expect(matchesApprovalRule({ kind: "patch_file_path", filePath: "src/app.ts" }, shellAction)).toBe(false);
    expect(matchesApprovalRule({ kind: "patch_directory", directory: "src" }, shellAction)).toBe(false);
  });

  it("file-level rule auto-approves a different patch to the same file", () => {
    const anotherPatch = [
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -5,3 +5,3 @@",
      "-another old line",
      "+another new line",
    ].join("\n");

    addWorkspaceApprovalRule("/repo/a", {
      kind: "patch_file_path",
      filePath: "src/app.ts",
    });

    const match = findMatchingApprovalRule("/repo/a", createPatchAction(anotherPatch, "apply_patch:modify:src/app.ts:deadbeef"));
    expect(match).toMatchObject({ kind: "patch_file_path", filePath: "src/app.ts" });
  });

  it("directory-level rule auto-approves any patch within the directory", () => {
    addWorkspaceApprovalRule("/repo/a", {
      kind: "patch_directory",
      directory: "src/lib",
    });

    const match = findMatchingApprovalRule("/repo/a", createPatchAction(SAMPLE_PATCH_UTILS_TS));
    expect(match).toMatchObject({ kind: "patch_directory", directory: "src/lib" });

    // Should NOT match a patch outside the directory
    const outsideMatch = findMatchingApprovalRule("/repo/a", createPatchAction(SAMPLE_PATCH_APP_TS));
    expect(outsideMatch).toBeNull();
  });

  it("persists and reloads patch_file_path and patch_directory rules", () => {
    addWorkspaceApprovalRule("/repo/a", { kind: "patch_file_path", filePath: "src/app.ts" });
    addWorkspaceApprovalRule("/repo/a", { kind: "patch_directory", directory: "src/lib" });

    const rules = loadWorkspaceApprovalRules("/repo/a");
    expect(rules).toHaveLength(2);
    expect(rules[0]).toMatchObject({ kind: "patch_file_path", filePath: "src/app.ts" });
    expect(rules[1]).toMatchObject({ kind: "patch_directory", directory: "src/lib" });
  });

  it("deduplicates patch_file_path rules with the same path", () => {
    addWorkspaceApprovalRule("/repo/a", { kind: "patch_file_path", filePath: "src/app.ts" });
    const second = addWorkspaceApprovalRule("/repo/a", { kind: "patch_file_path", filePath: "src/app.ts" });

    expect(second.added).toBe(false);
    expect(loadWorkspaceApprovalRules("/repo/a")).toHaveLength(1);
  });
});
