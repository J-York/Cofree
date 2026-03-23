import { workspaceHash } from "./workspaceStorage";

export const WORKSPACE_TEAM_TRUST_STORAGE_KEY_PREFIX =
  "cofree.workspaceTeamTrust.v1";

export type WorkspaceTeamTrustMode = "team_yolo" | "team_manual";

export interface WorkspaceTeamTrustRecord {
  workspaceHash: string;
  mode: WorkspaceTeamTrustMode;
  decidedAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isBrowserStorageAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function normalizeWorkspacePath(workspacePath: string): string {
  return workspacePath.trim();
}

function normalizeWorkspaceTeamTrustMode(value: unknown): WorkspaceTeamTrustMode | null {
  return value === "team_yolo" || value === "team_manual" ? value : null;
}

function normalizeWorkspaceTeamTrustRecord(raw: unknown): WorkspaceTeamTrustRecord | null {
  if (!isRecord(raw)) {
    return null;
  }

  const recordWorkspaceHash =
    typeof raw.workspaceHash === "string" && raw.workspaceHash.trim()
      ? raw.workspaceHash.trim()
      : null;
  const mode = normalizeWorkspaceTeamTrustMode(raw.mode);
  const decidedAt =
    typeof raw.decidedAt === "string" && raw.decidedAt.trim()
      ? raw.decidedAt.trim()
      : null;

  if (!recordWorkspaceHash || !mode || !decidedAt) {
    return null;
  }

  return {
    workspaceHash: recordWorkspaceHash,
    mode,
    decidedAt,
  };
}

export function getWorkspaceTeamTrustStorageKey(workspacePath: string): string {
  return `${WORKSPACE_TEAM_TRUST_STORAGE_KEY_PREFIX}.ws.${workspaceHash(
    normalizeWorkspacePath(workspacePath),
  )}`;
}

export function loadWorkspaceTeamTrustRecord(
  workspacePath: string,
): WorkspaceTeamTrustRecord | null {
  const normalized = normalizeWorkspacePath(workspacePath);
  if (!normalized || !isBrowserStorageAvailable()) {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(getWorkspaceTeamTrustStorageKey(normalized));
    if (!raw) {
      return null;
    }
    return normalizeWorkspaceTeamTrustRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function loadWorkspaceTeamTrustMode(
  workspacePath: string,
): WorkspaceTeamTrustMode | null {
  return loadWorkspaceTeamTrustRecord(workspacePath)?.mode ?? null;
}

export function saveWorkspaceTeamTrustMode(
  workspacePath: string,
  mode: WorkspaceTeamTrustMode,
): WorkspaceTeamTrustRecord | null {
  const normalized = normalizeWorkspacePath(workspacePath);
  if (!normalized || !isBrowserStorageAvailable()) {
    return null;
  }

  const record: WorkspaceTeamTrustRecord = {
    workspaceHash: workspaceHash(normalized),
    mode,
    decidedAt: nowIso(),
  };

  window.localStorage.setItem(
    getWorkspaceTeamTrustStorageKey(normalized),
    JSON.stringify(record),
  );
  return record;
}

export function clearWorkspaceTeamTrustMode(workspacePath: string): void {
  const normalized = normalizeWorkspacePath(workspacePath);
  if (!normalized || !isBrowserStorageAvailable()) {
    return;
  }

  window.localStorage.removeItem(getWorkspaceTeamTrustStorageKey(normalized));
}
