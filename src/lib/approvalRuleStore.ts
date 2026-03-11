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

export interface PatchFilePathApprovalRuleDraft {
  kind: "patch_file_path";
  /** Workspace-relative file path, e.g. "src/app.ts" */
  filePath: string;
}

export interface PatchDirectoryApprovalRuleDraft {
  kind: "patch_directory";
  /** Workspace-relative directory prefix without trailing slash, e.g. "src/components" */
  directory: string;
}

export type ApprovalRuleDraft =
  | FingerprintApprovalRuleDraft
  | ShellCommandPrefixApprovalRuleDraft
  | PatchFilePathApprovalRuleDraft
  | PatchDirectoryApprovalRuleDraft;

export type ApprovalRule =
  | (FingerprintApprovalRuleDraft & {
      id: string;
      createdAt: string;
    })
  | (ShellCommandPrefixApprovalRuleDraft & {
      id: string;
      createdAt: string;
    })
  | (PatchFilePathApprovalRuleDraft & {
      id: string;
      createdAt: string;
    })
  | (PatchDirectoryApprovalRuleDraft & {
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

function normalizePatchPath(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || null;
}

/**
 * Extract workspace-relative file paths referenced in a unified diff patch.
 * Parses both `diff --git` headers and `+++ b/...` lines.
 */
export function extractPatchFilePaths(patch: string): string[] {
  const files = new Set<string>();
  for (const rawLine of patch.split(/\r?\n/)) {
    const line = rawLine.trim();
    const diffMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (diffMatch) {
      if (diffMatch[1] && diffMatch[1] !== "/dev/null") {
        files.add(diffMatch[1]);
      }
      if (diffMatch[2] && diffMatch[2] !== "/dev/null") {
        files.add(diffMatch[2]);
      }
      continue;
    }
    const plusMatch = line.match(/^\+\+\+\s+b\/(.+)$/);
    if (plusMatch?.[1]) {
      files.add(plusMatch[1]);
    }
  }
  return Array.from(files);
}

/**
 * Given a list of file paths, return the unique parent directories.
 * Only returns the immediate parent directory of each file.
 */
function extractPatchDirectories(filePaths: string[]): string[] {
  const dirs = new Set<string>();
  for (const filePath of filePaths) {
    const normalized = filePath.replace(/\\/g, "/");
    const slashIndex = normalized.lastIndexOf("/");
    if (slashIndex > 0) {
      dirs.add(normalized.slice(0, slashIndex));
    }
  }
  return Array.from(dirs);
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
    return null;
  }

  if (raw.kind === "patch_file_path") {
    const filePath = normalizePatchPath(raw.filePath);
    if (filePath) {
      return {
        id,
        createdAt,
        kind: "patch_file_path",
        filePath,
      };
    }
    return null;
  }

  if (raw.kind === "patch_directory") {
    const directory = normalizePatchPath(raw.directory);
    if (directory) {
      return {
        id,
        createdAt,
        kind: "patch_directory",
        directory,
      };
    }
    return null;
  }

  return null;
}

function getRuleIdentity(rule: ApprovalRuleDraft | ApprovalRule): string {
  if (rule.kind === "action_fingerprint") {
    return `${rule.kind}:${rule.actionType}:${rule.fingerprint}`;
  }
  if (rule.kind === "shell_command_prefix") {
    return `${rule.kind}:${rule.commandTokens.join(" ")}`;
  }
  if (rule.kind === "patch_file_path") {
    return `${rule.kind}:${rule.filePath}`;
  }
  if (rule.kind === "patch_directory") {
    return `${rule.kind}:${rule.directory}`;
  }
  return "(unknown)";
}

function toPersistedRule(rule: ApprovalRuleDraft | ApprovalRule): ApprovalRule {
  const existing = normalizeApprovalRule(rule);
  if (existing) {
    return existing;
  }

  const baseId = `approval-rule-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const baseCreatedAt = nowIso();

  if (rule.kind === "action_fingerprint") {
    return {
      id: baseId,
      createdAt: baseCreatedAt,
      kind: "action_fingerprint",
      actionType: rule.actionType,
      fingerprint: rule.fingerprint.trim(),
    };
  }

  if (rule.kind === "patch_file_path") {
    return {
      id: baseId,
      createdAt: baseCreatedAt,
      kind: "patch_file_path",
      filePath: rule.filePath.trim().replace(/\\/g, "/"),
    };
  }

  if (rule.kind === "patch_directory") {
    return {
      id: baseId,
      createdAt: baseCreatedAt,
      kind: "patch_directory",
      directory: rule.directory.trim().replace(/\\/g, "/").replace(/\/+$/, ""),
    };
  }

  return {
    id: baseId,
    createdAt: baseCreatedAt,
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
  if (rule.kind === "shell_command_prefix") {
    return rule.commandTokens.join(" ") + " xxx";
  }
  if (rule.kind === "patch_file_path") {
    return `修改 ${rule.filePath}`;
  }
  if (rule.kind === "patch_directory") {
    return `修改 ${rule.directory}/`;
  }
  return "(未知规则)";
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

  if (action.type === "apply_patch") {
    const filePaths = extractPatchFilePaths(action.payload.patch);
    for (const filePath of filePaths) {
      pushOption({
        key: `file:${filePath}`,
        label: `修改 ${filePath}`,
        rule: {
          kind: "patch_file_path",
          filePath,
        },
      });
    }
    const directories = extractPatchDirectories(filePaths);
    for (const directory of directories) {
      pushOption({
        key: `dir:${directory}`,
        label: `修改 ${directory}/`,
        rule: {
          kind: "patch_directory",
          directory,
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

  if (rule.kind === "shell_command_prefix") {
    if (action.type !== "shell") {
      return false;
    }
    const prefixes = extractShellApprovalPrefixes(action.payload.shell);
    return prefixes.some((prefix) =>
      prefix.length >= rule.commandTokens.length &&
      rule.commandTokens.every((token, index) => prefix[index] === token),
    );
  }

  if (rule.kind === "patch_file_path") {
    if (action.type !== "apply_patch") {
      return false;
    }
    const filePaths = extractPatchFilePaths(action.payload.patch);
    const normalizedTarget = rule.filePath.replace(/\\/g, "/");
    return filePaths.some((fp) => fp.replace(/\\/g, "/") === normalizedTarget);
  }

  if (rule.kind === "patch_directory") {
    if (action.type !== "apply_patch") {
      return false;
    }
    const filePaths = extractPatchFilePaths(action.payload.patch);
    const normalizedDir = rule.directory.replace(/\\/g, "/").replace(/\/+$/, "");
    return filePaths.some((fp) => {
      const normalizedFp = fp.replace(/\\/g, "/");
      return (
        normalizedFp === normalizedDir ||
        normalizedFp.startsWith(normalizedDir + "/")
      );
    });
  }

  return false;
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
