import { describe, expect, it } from "vitest";
import type { ApprovalRule } from "../lib/approvalRuleStore";
import {
  buildAutoApprovalMeta,
  resolveSensitiveActionAutoApprovalSource,
} from "./toolApprovalResolver";

const FIXED_TS = "2026-04-22T00:00:00.000Z";

const fingerprintRule: ApprovalRule = {
  kind: "action_fingerprint",
  actionType: "apply_patch",
  fingerprint: "abc123",
  id: "rule-1",
  createdAt: FIXED_TS,
};

const shellRule: ApprovalRule = {
  kind: "shell_command_prefix",
  commandTokens: ["pnpm", "test"],
  id: "rule-2",
  createdAt: FIXED_TS,
};

describe("resolveSensitiveActionAutoApprovalSource", () => {
  it("returns null when policy is disabled even if permission is auto", () => {
    expect(
      resolveSensitiveActionAutoApprovalSource({
        permissionLevel: "auto",
        matchedRule: shellRule,
        autoExecutionPolicy: "disabled",
      }),
    ).toBeNull();
  });

  it("returns null when policy is disabled and rule matches", () => {
    expect(
      resolveSensitiveActionAutoApprovalSource({
        permissionLevel: "ask",
        matchedRule: shellRule,
        autoExecutionPolicy: "disabled",
      }),
    ).toBeNull();
  });

  it("prefers tool_permission when permissionLevel is 'auto'", () => {
    expect(
      resolveSensitiveActionAutoApprovalSource({
        permissionLevel: "auto",
        matchedRule: shellRule,
        autoExecutionPolicy: "allow",
      }),
    ).toBe("tool_permission");
  });

  it("returns tool_permission even when no rule matches", () => {
    expect(
      resolveSensitiveActionAutoApprovalSource({
        permissionLevel: "auto",
        matchedRule: null,
        autoExecutionPolicy: "allow",
      }),
    ).toBe("tool_permission");
  });

  it("falls through to workspace_rule when permission is 'ask' and a rule matches", () => {
    expect(
      resolveSensitiveActionAutoApprovalSource({
        permissionLevel: "ask",
        matchedRule: shellRule,
        autoExecutionPolicy: "allow",
      }),
    ).toBe("workspace_rule");
  });

  it("returns null when permission is 'ask' and no rule matches", () => {
    expect(
      resolveSensitiveActionAutoApprovalSource({
        permissionLevel: "ask",
        matchedRule: null,
        autoExecutionPolicy: "allow",
      }),
    ).toBeNull();

    expect(
      resolveSensitiveActionAutoApprovalSource({
        permissionLevel: "ask",
        matchedRule: undefined,
        autoExecutionPolicy: "allow",
      }),
    ).toBeNull();
  });
});

describe("buildAutoApprovalMeta", () => {
  it("returns empty object when source is null", () => {
    expect(buildAutoApprovalMeta(null)).toEqual({});
    expect(buildAutoApprovalMeta(null, shellRule)).toEqual({});
  });

  it("marks tool_permission source with rule_matched=false and null rule fields", () => {
    expect(buildAutoApprovalMeta("tool_permission")).toEqual({
      approval_source: "tool_permission",
      approval_rule_matched: false,
      approval_rule_kind: null,
      approval_rule_label: null,
    });
  });

  it("tool_permission ignores matchedRule when included", () => {
    expect(buildAutoApprovalMeta("tool_permission", shellRule)).toEqual({
      approval_source: "tool_permission",
      approval_rule_matched: false,
      approval_rule_kind: null,
      approval_rule_label: null,
    });
  });

  it("workspace_rule with a fingerprint rule surfaces kind and descriptive label", () => {
    expect(buildAutoApprovalMeta("workspace_rule", fingerprintRule)).toEqual({
      approval_source: "workspace_rule",
      approval_rule_matched: true,
      approval_rule_kind: "action_fingerprint",
      approval_rule_label: "当前补丁动作",
    });
  });

  it("workspace_rule with a shell prefix rule joins tokens for the label", () => {
    expect(buildAutoApprovalMeta("workspace_rule", shellRule)).toEqual({
      approval_source: "workspace_rule",
      approval_rule_matched: true,
      approval_rule_kind: "shell_command_prefix",
      approval_rule_label: "pnpm test xxx",
    });
  });

  it("workspace_rule without matchedRule falls back to null kind and label", () => {
    expect(buildAutoApprovalMeta("workspace_rule")).toEqual({
      approval_source: "workspace_rule",
      approval_rule_matched: true,
      approval_rule_kind: null,
      approval_rule_label: null,
    });
  });
});
