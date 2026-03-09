import type { ActionProposal, SensitiveActionType } from "../orchestrator/types";
import { workspaceHash } from "./workspaceStorage";

export const APPROVAL_RULE_STORAGE_KEY_PREFIX = "cofree.approvalRules.v1";

export interface FingerprintApprovalRuleDraft {
  kind: "action_fingerprint";
  actionType: SensitiveActionType;
  fingerprint: string;
}

export interface ShellCommandPrefixApprovalRuleDraft {
  kind: "shell_command_prefix";
  commandTokens: string[];
}

export type ApprovalRuleDraft =
  | FingerprintApprovalRuleDraft
  | ShellCommandPrefixApprovalRuleDraft;

export type ApprovalRule =
  | (FingerprintApprovalRuleDraft & {
      id: string;
      createdAt: string;
    })
  | (ShellCommandPrefixApprovalRuleDraft & {
      id: string;
      createdAt: string;
    });

export interface ApprovalRuleOption {
  key: string;
  label: string;
  rule: ApprovalRuleDraft;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeCommandToken(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized ? normalized : null;
}

function normalizeCommandTokens(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => normalizeCommandToken(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function normalizeApprovalRule(raw: unknown): ApprovalRule | null {
  if (!isRecord(raw) || typeof raw.kind !== "string") {
    return null;
  }

  const id = typeof raw.id === "string" && raw.id.trim()
    ? raw.id.trim()
    : `approval-rule-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const createdAt = typeof raw.createdAt === "string" && raw.createdAt.trim()
    ? raw.createdAt
    : nowIso();

  if (raw.kind === "action_fingerprint") {
    if (
      (raw.actionType === "apply_patch" || raw.actionType === "shell") &&
      typeof raw.fingerprint === "string" &&
      raw.fingerprint.trim()
    ) {
      return {
        id,
        createdAt,
        kind: "action_fingerprint",
        actionType: raw.actionType,
        fingerprint: raw.fingerprint.trim(),
      };
    }
    return null;
  }

  if (raw.kind === "shell_command_prefix") {
    const commandTokens = normalizeCommandTokens(raw.commandTokens);
    if (commandTokens.length > 0) {
      return {
        id,
        createdAt,
        kind: "shell_command_prefix",
        commandTokens,
      };
    }
  }

  return null;
}

function getRuleIdentity(rule: ApprovalRuleDraft | ApprovalRule): string {
  if (rule.kind === "action_fingerprint") {
    return `${rule.kind}:${rule.actionType}:${rule.fingerprint}`;
  }
  return `${rule.kind}:${rule.commandTokens.join(" ")}`;
}

function toPersistedRule(rule: ApprovalRuleDraft | ApprovalRule): ApprovalRule {
  const existing = normalizeApprovalRule(rule);
  if (existing) {
    return existing;
  }

  if (rule.kind === "action_fingerprint") {
    return {
      id: `approval-rule-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
      createdAt: nowIso(),
      kind: "action_fingerprint",
      actionType: rule.actionType,
      fingerprint: rule.fingerprint.trim(),
    };
  }

  return {
    id: `approval-rule-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
    createdAt: nowIso(),
    kind: "shell_command_prefix",
    commandTokens: normalizeCommandTokens(rule.commandTokens),
  };
}

function dedupeRules(rules: ApprovalRule[]): ApprovalRule[] {
  const seen = new Set<string>();
  const next: ApprovalRule[] = [];
  for (const rule of rules) {
    const identity = getRuleIdentity(rule);
    if (seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    next.push(rule);
  }
  return next;
}

function isBrowserStorageAvailable(): boolean {
  return typeof window !== "undefined";
}

export function getWorkspaceApprovalRuleStorageKey(workspacePath: string): string {
  return `${APPROVAL_RULE_STORAGE_KEY_PREFIX}.ws.${workspaceHash(workspacePath.trim())}`;
}

function parseStoredRules(raw: string | null): ApprovalRule[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    const source = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed.rules)
        ? parsed.rules
        : [];
    return dedupeRules(
      source
        .map((entry) => normalizeApprovalRule(entry))
        .filter((entry): entry is ApprovalRule => Boolean(entry)),
    );
  } catch {
    return [];
  }
}

function saveWorkspaceApprovalRulesInternal(workspacePath: string, rules: ApprovalRule[]): void {
  if (!isBrowserStorageAvailable()) {
    return;
  }
  window.localStorage.setItem(
    getWorkspaceApprovalRuleStorageKey(workspacePath),
    JSON.stringify({ rules: dedupeRules(rules) }),
  );
}

export function loadWorkspaceApprovalRules(workspacePath: string): ApprovalRule[] {
  const normalized = workspacePath.trim();
  if (!normalized || !isBrowserStorageAvailable()) {
    return [];
  }
  return parseStoredRules(
    window.localStorage.getItem(getWorkspaceApprovalRuleStorageKey(normalized)),
  );
}

export function addWorkspaceApprovalRule(
  workspacePath: string,
  rule: ApprovalRuleDraft | ApprovalRule,
): { added: boolean; rules: ApprovalRule[] } {
  const normalized = workspacePath.trim();
  if (!normalized) {
    return { added: false, rules: [] };
  }

  const persisted = toPersistedRule(rule);
  const current = loadWorkspaceApprovalRules(normalized);
  const identity = getRuleIdentity(persisted);
  if (current.some((entry) => getRuleIdentity(entry) === identity)) {
    return { added: false, rules: current };
  }

  const next = [...current, persisted];
  saveWorkspaceApprovalRulesInternal(normalized, next);
  return { added: true, rules: dedupeRules(next) };
}

export function clearWorkspaceApprovalRules(workspacePath: string): void {
  const normalized = workspacePath.trim();
  if (!normalized || !isBrowserStorageAvailable()) {
    return;
  }
  window.localStorage.removeItem(getWorkspaceApprovalRuleStorageKey(normalized));
}

export function describeApprovalRule(rule: ApprovalRuleDraft | ApprovalRule): string {
  if (rule.kind === "action_fingerprint") {
    return rule.actionType === "shell" ? "当前完整命令" : "当前补丁动作";
  }
  return rule.commandTokens.join(" ") + " xxx";
}

function consumeQuotedToken(
  source: string,
  index: number,
  quote: "'" | '"',
): { nextIndex: number; value: string } {
  let cursor = index + 1;
  let value = "";
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === "\\" && quote === '"' && cursor + 1 < source.length) {
      value += source[cursor + 1];
      cursor += 2;
      continue;
    }
    if (char === quote) {
      return { nextIndex: cursor + 1, value };
    }
    value += char;
    cursor += 1;
  }
  return { nextIndex: cursor, value };
}

function tokenizeFirstShellCommand(shell: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let index = 0;

  const pushCurrent = () => {
    const normalized = current.trim();
    if (normalized) {
      tokens.push(normalized);
    }
    current = "";
  };

  while (index < shell.length) {
    const char = shell[index];
    const next = shell[index + 1];

    if (char === "\\" && index + 1 < shell.length) {
      current += shell[index + 1];
      index += 2;
      continue;
    }

    if (char === "'" || char === '"') {
      const quoted = consumeQuotedToken(shell, index, char);
      current += quoted.value;
      index = quoted.nextIndex;
      continue;
    }

    if (/\s/.test(char)) {
      pushCurrent();
      index += 1;
      continue;
    }

    if (
      char === ";" ||
      char === "|" ||
      char === "\n" ||
      char === "\r" ||
      (char === "&" && next === "&")
    ) {
      break;
    }

    current += char;
    index += 1;
  }

  pushCurrent();
  return tokens;
}

function hasShellControlOperators(shell: string): boolean {
  let index = 0;

  while (index < shell.length) {
    const char = shell[index];
    const next = shell[index + 1];

    if (char === "\\" && index + 1 < shell.length) {
      index += 2;
      continue;
    }

    if (char === "'" || char === '"') {
      const quoted = consumeQuotedToken(shell, index, char);
      index = quoted.nextIndex;
      continue;
    }

    if (
      char === ";" ||
      char === "|" ||
      char === "\n" ||
      char === "\r" ||
      char === ">" ||
      char === "<" ||
      char === "(" ||
      char === ")" ||
      (char === "&" && next === "&")
    ) {
      return true;
    }

    index += 1;
  }

  return false;
}

function unwrapCommandTokens(tokens: string[]): string[] {
  let index = 0;
  while (
    index < tokens.length &&
    /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? "")
  ) {
    index += 1;
  }

  while (index < tokens.length) {
    const token = tokens[index];
    if (token === "sudo" || token === "env" || token === "command" || token === "nohup") {
      index += 1;
      continue;
    }
    break;
  }

  return tokens.slice(index);
}

export function extractShellApprovalPrefixes(shell: string): string[][] {
  if (hasShellControlOperators(shell)) {
    return [];
  }

  const normalizedTokens = unwrapCommandTokens(
    tokenizeFirstShellCommand(shell).map((token) => token.trim().toLowerCase()).filter(Boolean),
  );
  if (normalizedTokens.length === 0) {
    return [];
  }

  const command = normalizedTokens[0];
  const prefixes: string[][] = [[command]];

  const flagsExpectingValue = new Set([
    "-c",
    "-C",
    "-m",
    "-p",
    "--config",
    "--cwd",
    "--directory",
    "--prefix",
  ].map((token) => token.toLowerCase()));
  let skipNextToken = false;

  for (let index = 1; index < normalizedTokens.length; index += 1) {
    const token = normalizedTokens[index];
    if (skipNextToken) {
      skipNextToken = false;
      continue;
    }
    if (!token || token.startsWith("-")) {
      if (token && flagsExpectingValue.has(token)) {
        skipNextToken = true;
      }
      continue;
    }
    prefixes.push([command, token]);
    break;
  }

  return prefixes;
}

export function buildApprovalRuleOptions(action: ActionProposal): ApprovalRuleOption[] {
  const options: ApprovalRuleOption[] = [];
  const seen = new Set<string>();

  const pushOption = (option: ApprovalRuleOption) => {
    const identity = getRuleIdentity(option.rule);
    if (seen.has(identity)) {
      return;
    }
    seen.add(identity);
    options.push(option);
  };

  if (typeof action.fingerprint === "string" && action.fingerprint.trim()) {
    pushOption({
      key: `exact:${action.fingerprint}`,
      label: action.type === "shell" ? "当前完整命令" : "当前补丁动作",
      rule: {
        kind: "action_fingerprint",
        actionType: action.type,
        fingerprint: action.fingerprint,
      },
    });
  }

  if (action.type === "shell") {
    for (const prefix of extractShellApprovalPrefixes(action.payload.shell)) {
      pushOption({
        key: `prefix:${prefix.join(" ")}`,
        label: `${prefix.join(" ")} xxx`,
        rule: {
          kind: "shell_command_prefix",
          commandTokens: prefix,
        },
      });
    }
  }

  return options;
}

export function matchesApprovalRule(
  rule: ApprovalRule | ApprovalRuleDraft,
  action: ActionProposal,
): boolean {
  if (rule.kind === "action_fingerprint") {
    return (
      rule.actionType === action.type &&
      typeof action.fingerprint === "string" &&
      action.fingerprint === rule.fingerprint
    );
  }

  if (action.type !== "shell") {
    return false;
  }

  const prefixes = extractShellApprovalPrefixes(action.payload.shell);
  return prefixes.some((prefix) =>
    prefix.length >= rule.commandTokens.length &&
    rule.commandTokens.every((token, index) => prefix[index] === token),
  );
}

export function findMatchingApprovalRule(
  workspacePath: string,
  action: ActionProposal,
): ApprovalRule | null {
  const rules = loadWorkspaceApprovalRules(workspacePath);
  for (const rule of rules) {
    if (matchesApprovalRule(rule, action)) {
      return rule;
    }
  }
  return null;
}
