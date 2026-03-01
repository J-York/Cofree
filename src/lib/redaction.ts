/**
 * Cofree - AI Programming Cafe
 * File: src/lib/redaction.ts
 * Milestone: 3
 * Task: 3.5
 * Status: In Progress
 * Owner: Codex-GPT-5
 * Last Modified: 2026-02-28
 * Description: Shared helpers for truncating and redacting sensitive local data before persistence.
 */

const DEFAULT_MAX_STRING_LENGTH = 400;
const MAX_ARRAY_ITEMS = 20;
const MAX_OBJECT_KEYS = 20;
const MAX_DEPTH = 4;

const REDACTION_PATTERNS: RegExp[] = [
  /bearer\s+[^\s"'`]+/gi,
  /\bsk-[a-z0-9_\-]+\b/gi,
  /\b(api[_-]?key)\s*[:=]\s*["']?[^"'\s]+["']?/gi,
  /\b(token|secret|password)\s*[:=]\s*["']?[^"'\s]+["']?/gi
];

const LOCAL_ABSOLUTE_PATH_PATTERN =
  /(^|[\s"'`([{=])((?:[A-Za-z]:\\|\/)[^\s"'`)\]}]+(?:[\\/][^\s"'`)\]}]+)+)/g;

function normalizeWorkspacePath(workspacePath?: string): string {
  return typeof workspacePath === "string" ? workspacePath.trim() : "";
}

function redactLocalPathCandidate(candidate: string, workspacePath?: string): string {
  const normalizedCandidate = candidate.trim();
  if (!normalizedCandidate || normalizedCandidate.startsWith("//")) {
    return candidate;
  }

  const normalizedWorkspace = normalizeWorkspacePath(workspacePath);
  if (normalizedWorkspace) {
    if (normalizedCandidate === normalizedWorkspace) {
      return "<workspace>";
    }
    const workspacePrefix = `${normalizedWorkspace}/`;
    if (normalizedCandidate.startsWith(workspacePrefix)) {
      return `<workspace>/${normalizedCandidate.slice(workspacePrefix.length)}`;
    }
  }

  return "<local-path>";
}

export function redactLocalPathEgress(input: string, workspacePath?: string): string {
  return input.replace(LOCAL_ABSOLUTE_PATH_PATTERN, (match, prefix: string, candidate: string) => {
    const replacement = redactLocalPathCandidate(candidate, workspacePath);
    if (replacement === candidate) {
      return match;
    }
    return `${prefix}${replacement}`;
  });
}

export function redactSensitiveText(
  input: string,
  maxLength = DEFAULT_MAX_STRING_LENGTH,
  workspacePath?: string
): string {
  let value = redactLocalPathEgress(input, workspacePath);
  for (const pattern of REDACTION_PATTERNS) {
    value = value.replace(pattern, (match) => {
      const prefix = match.split(/[:=\s]/, 1)[0];
      if (/^(token|secret|password|api[_-]?key)$/i.test(prefix)) {
        return `${prefix}=***`;
      }
      if (/^bearer$/i.test(prefix)) {
        return "Bearer ***";
      }
      return "***";
    });
  }

  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 14))}… [truncated]`;
}

export function sanitizeForPersistence(value: unknown, depth = 0): unknown {
  if (depth >= MAX_DEPTH) {
    return "[max-depth]";
  }
  if (typeof value === "string") {
    return redactSensitiveText(value);
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeForPersistence(item, depth + 1));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_OBJECT_KEYS);
    return Object.fromEntries(
      entries.map(([key, entryValue]) => [key, sanitizeForPersistence(entryValue, depth + 1)])
    );
  }
  return String(value);
}
