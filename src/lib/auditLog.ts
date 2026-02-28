/**
 * Cofree - AI Programming Cafe
 * File: src/lib/auditLog.ts
 * Milestone: 2
 * Task: 2.4
 * Status: Completed
 * Owner: Codex-GPT-5
 * Last Modified: 2026-02-27
 * Description: Minimal local audit logging for LLM request metadata.
 */

const AUDIT_LOG_STORAGE_KEY = "cofree.audit.llm.v1";
const ACTION_AUDIT_LOG_STORAGE_KEY = "cofree.audit.actions.v1";
const MAX_AUDIT_RECORDS = 200;

export interface LLMAuditRecord {
  requestId: string;
  provider: string;
  model: string;
  timestamp: string;
  inputLength: number;
  outputLength: number;
}

interface StoredAuditPayload {
  records: LLMAuditRecord[];
}

export interface SensitiveActionAuditRecord {
  actionId: string;
  actionType: string;
  status: "success" | "failed";
  startedAt: string;
  finishedAt: string;
  executor: string;
  reason: string;
  workspacePath: string;
  details: Record<string, unknown>;
}

interface StoredActionAuditPayload {
  records: SensitiveActionAuditRecord[];
}

function parseStoredRecords(raw: string | null): LLMAuditRecord[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as Partial<StoredAuditPayload>;
    if (!Array.isArray(parsed.records)) {
      return [];
    }

    return parsed.records.filter(
      (record): record is LLMAuditRecord =>
        typeof record.requestId === "string" &&
        typeof record.provider === "string" &&
        typeof record.model === "string" &&
        typeof record.timestamp === "string" &&
        typeof record.inputLength === "number" &&
        typeof record.outputLength === "number"
    );
  } catch (_error) {
    return [];
  }
}

function parseStoredActionRecords(raw: string | null): SensitiveActionAuditRecord[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as Partial<StoredActionAuditPayload>;
    if (!Array.isArray(parsed.records)) {
      return [];
    }

    return parsed.records.filter(
      (record): record is SensitiveActionAuditRecord =>
        typeof record.actionId === "string" &&
        typeof record.actionType === "string" &&
        (record.status === "success" || record.status === "failed") &&
        typeof record.startedAt === "string" &&
        typeof record.finishedAt === "string" &&
        typeof record.executor === "string" &&
        typeof record.reason === "string" &&
        typeof record.workspacePath === "string" &&
        typeof record.details === "object" &&
        record.details !== null
    );
  } catch (_error) {
    return [];
  }
}

export function readLLMAuditRecords(): LLMAuditRecord[] {
  if (typeof window === "undefined") {
    return [];
  }

  return parseStoredRecords(window.localStorage.getItem(AUDIT_LOG_STORAGE_KEY));
}

export function recordLLMAudit(record: LLMAuditRecord): void {
  if (typeof window === "undefined") {
    return;
  }

  const next = [record, ...readLLMAuditRecords()].slice(0, MAX_AUDIT_RECORDS);
  window.localStorage.setItem(AUDIT_LOG_STORAGE_KEY, JSON.stringify({ records: next }));
}

export function readSensitiveActionAuditRecords(): SensitiveActionAuditRecord[] {
  if (typeof window === "undefined") {
    return [];
  }

  return parseStoredActionRecords(window.localStorage.getItem(ACTION_AUDIT_LOG_STORAGE_KEY));
}

export function recordSensitiveActionAudit(record: SensitiveActionAuditRecord): void {
  if (typeof window === "undefined") {
    return;
  }

  const next = [record, ...readSensitiveActionAuditRecords()].slice(0, MAX_AUDIT_RECORDS);
  window.localStorage.setItem(ACTION_AUDIT_LOG_STORAGE_KEY, JSON.stringify({ records: next }));
}
