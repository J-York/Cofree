/**
 * Resolves whether a sensitive action (patch / shell) should be
 * auto-executed, and decorates the response payload with the
 * auto-approval provenance so the UI audit trail can render it.
 *
 * Two independent inputs can authorize auto-execution:
 *   - The tool's configured permission level ("auto" in settings).
 *   - A per-workspace approval rule matched against the ActionProposal.
 *
 * A kill-switch (`autoExecutionPolicy === "disabled"`) forces the request
 * back through the HITL gate regardless of either source.
 */

import {
  describeApprovalRule,
  type ApprovalRule,
} from "../lib/approvalRuleStore";

export type SensitiveWriteAutoExecutionPolicy = "allow" | "disabled";

export function buildAutoApprovalMeta(
  source: "tool_permission" | "workspace_rule" | null,
  matchedRule?: ApprovalRule | null,
): Record<string, unknown> {
  if (!source) {
    return {};
  }

  return {
    approval_source: source,
    approval_rule_matched: source === "workspace_rule",
    approval_rule_kind:
      source === "workspace_rule" ? matchedRule?.kind ?? null : null,
    approval_rule_label:
      source === "workspace_rule" && matchedRule
        ? describeApprovalRule(matchedRule)
        : null,
  };
}

export function resolveSensitiveActionAutoApprovalSource(params: {
  permissionLevel: "auto" | "ask";
  matchedRule?: ApprovalRule | null;
  autoExecutionPolicy: SensitiveWriteAutoExecutionPolicy;
}): "tool_permission" | "workspace_rule" | null {
  if (params.autoExecutionPolicy === "disabled") {
    return null;
  }
  if (params.permissionLevel === "auto") {
    return "tool_permission";
  }
  return params.matchedRule ? "workspace_rule" : null;
}
