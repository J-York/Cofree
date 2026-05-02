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

import { redactSensitiveText, sanitizeForPersistence } from "./redaction";

const AUDIT_LOG_STORAGE_KEY = "cofree.audit.llm.v1";
const ACTION_AUDIT_LOG_STORAGE_KEY = "cofree.audit.actions.v1";
const ERROR_AUDIT_LOG_STORAGE_KEY = "cofree.audit.errors.v1";
/**
 * Capacity of the in-localStorage UI cache. The on-disk JSONL file at
 * ~/.cofree/audit.jsonl is the source of truth for sensitive-action history;
 * localStorage just keeps recent rows around for fast UI rendering.
 */
const MAX_AUDIT_RECORDS = 200;

function isTauriRuntime(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return "__TAURI_INTERNALS__" in window;
}

/**
 * Best-effort append to the persistent audit log on disk. Failures are logged
 * but never thrown — losing one row is preferable to breaking the action that
 * triggered the audit. Only invoked inside Tauri; in browser dev mode the
 * localStorage cache is the only sink.
 */
function appendActionAuditToDisk(record: SensitiveActionAuditRecord): void {
  if (!isTauriRuntime()) {
    return;
  }
  // Lazy import keeps the Tauri API out of test/jsdom bundles.
  void import("@tauri-apps/api/core")
    .then(({ invoke }) =>
      invoke("append_action_audit_log", { recordJson: JSON.stringify(record) }),
    )
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.warn("append_action_audit_log failed", error);
    });
}

export interface LLMAuditRecord {
  requestId: string;
  provider: string;
  model: string;
  agentId?: string;
  timestamp: string;
  inputLength: number;
  outputLength: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
}

export interface ErrorAuditRecord {
  category: string;
  title: string;
  message: string;
  retriable: boolean;
  guidance: string;
  rawError?: string;
  timestamp: string;
  conversationId?: string;
}

interface StoredAuditPayload {
  records: LLMAuditRecord[];
}

interface StoredErrorAuditPayload {
  records: ErrorAuditRecord[];
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

  const safeRecord: LLMAuditRecord = {
    ...record,
    requestId: redactSensitiveText(record.requestId, 120),
    provider: redactSensitiveText(record.provider, 80),
    model: redactSensitiveText(record.model, 120)
  };
  const next = [safeRecord, ...readLLMAuditRecords()].slice(0, MAX_AUDIT_RECORDS);
  window.localStorage.setItem(AUDIT_LOG_STORAGE_KEY, JSON.stringify({ records: next }));
}

export function readSensitiveActionAuditRecords(): SensitiveActionAuditRecord[] {
  if (typeof window === "undefined") {
    return [];
  }

  return parseStoredActionRecords(window.localStorage.getItem(ACTION_AUDIT_LOG_STORAGE_KEY));
}

function parseStoredErrorRecords(raw: string | null): ErrorAuditRecord[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as Partial<StoredErrorAuditPayload>;
    if (!Array.isArray(parsed.records)) {
      return [];
    }

    return parsed.records.filter(
      (record): record is ErrorAuditRecord =>
        typeof record.category === "string" &&
        typeof record.title === "string" &&
        typeof record.message === "string" &&
        typeof record.retriable === "boolean" &&
        typeof record.guidance === "string" &&
        typeof record.timestamp === "string"
    );
  } catch (_error) {
    return [];
  }
}

export function readErrorAuditRecords(): ErrorAuditRecord[] {
  if (typeof window === "undefined") {
    return [];
  }

  return parseStoredErrorRecords(window.localStorage.getItem(ERROR_AUDIT_LOG_STORAGE_KEY));
}

export function recordErrorAudit(record: ErrorAuditRecord): void {
  if (typeof window === "undefined") {
    return;
  }

  const safeRecord: ErrorAuditRecord = {
    ...record,
    title: redactSensitiveText(record.title, 120),
    message: redactSensitiveText(record.message, 400),
    rawError: record.rawError ? redactSensitiveText(record.rawError, 800) : undefined,
  };

  const next = [safeRecord, ...readErrorAuditRecords()].slice(0, MAX_AUDIT_RECORDS);
  window.localStorage.setItem(ERROR_AUDIT_LOG_STORAGE_KEY, JSON.stringify({ records: next }));
}

export function clearErrorAuditRecords(): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(ERROR_AUDIT_LOG_STORAGE_KEY);
}

export function recordSensitiveActionAudit(record: SensitiveActionAuditRecord): void {
  if (typeof window === "undefined") {
    return;
  }

  const safeRecord: SensitiveActionAuditRecord = {
    ...record,
    actionId: redactSensitiveText(record.actionId, 120),
    actionType: redactSensitiveText(record.actionType, 60),
    reason: redactSensitiveText(record.reason, 400),
    workspacePath: redactSensitiveText(record.workspacePath, 200),
    details: (sanitizeForPersistence(record.details) as Record<string, unknown>) ?? {}
  };

  // 1. Persistent on-disk JSONL — survives clearing browser data, app
  //    reinstalls, and the localStorage cache cap. This is the audit source
  //    of truth.
  appendActionAuditToDisk(safeRecord);

  // 2. localStorage UI cache — keeps the last N rows for fast rendering of
  //    the audit panel without hitting disk.
  const next = [safeRecord, ...readSensitiveActionAuditRecords()].slice(0, MAX_AUDIT_RECORDS);
  window.localStorage.setItem(ACTION_AUDIT_LOG_STORAGE_KEY, JSON.stringify({ records: next }));
}

/* ── Export functions ─────────────────────────────────── */

export function exportAuditToJSON(): string {
  const llm = readLLMAuditRecords();
  const actions = readSensitiveActionAuditRecords();
  const errors = readErrorAuditRecords();
  return JSON.stringify({ llm, actions, errors, exportedAt: new Date().toISOString() }, null, 2);
}

export function exportAuditToCSV(): string {
  const llm = readLLMAuditRecords();
  const actions = readSensitiveActionAuditRecords();
  const errors = readErrorAuditRecords();

  const llmHeader =
    "type,requestId,provider,model,timestamp,inputLength,outputLength,inputTokens,outputTokens,cacheCreationTokens,cacheReadTokens";
  const llmRows = llm.map(
    (r) =>
      `llm,"${r.requestId}","${r.provider}","${r.model}","${r.timestamp}",${r.inputLength},${r.outputLength},${r.inputTokens ?? ""},${r.outputTokens ?? ""},${r.cacheCreationTokens ?? ""},${r.cacheReadTokens ?? ""}`
  );

  const actionHeader = "type,actionId,actionType,status,startedAt,finishedAt,executor,reason,workspacePath";
  const actionRows = actions.map(
    (r) =>
      `action,"${r.actionId}","${r.actionType}","${r.status}","${r.startedAt}","${r.finishedAt}","${r.executor}","${r.reason.replace(/"/g, '""')}","${r.workspacePath}"`
  );

  const errorHeader = "type,category,title,message,retriable,guidance,timestamp,conversationId";
  const errorRows = errors.map(
    (r) =>
      `error,"${r.category}","${r.title}","${r.message.replace(/"/g, '""')}",${r.retriable},"${r.guidance.replace(/"/g, '""')}","${r.timestamp}","${r.conversationId ?? ""}"`
  );

  return [llmHeader, ...llmRows, "", actionHeader, ...actionRows, "", errorHeader, ...errorRows].join("\n");
}
