import type { ModelSelection } from "./modelSelection";
import {
  ACTIVE_CONVERSATION_KEY,
  CONVERSATIONS_STORAGE_KEY,
  type ConversationMetadata,
  workspaceHash,
} from "./conversationStore";

interface WorkspaceStorageKeys {
  workspacePrefix: string;
  listKey: string;
  activeKey: string;
}

interface ConversationStoreEventDetail {
  type: "workspace-cleared" | "all-cleared";
  workspacePath?: string;
}

const CONVERSATION_STORE_EVENT = "cofree:conversation-store-changed";

function isBrowserStorageAvailable(): boolean {
  return typeof window !== "undefined";
}

function getWorkspaceStorageKeys(workspacePath: string): WorkspaceStorageKeys {
  const hashedWorkspace = workspaceHash(workspacePath);
  return {
    workspacePrefix: `${CONVERSATIONS_STORAGE_KEY}.ws.${hashedWorkspace}`,
    listKey: `${CONVERSATIONS_STORAGE_KEY}.ws.${hashedWorkspace}`,
    activeKey: `${ACTIVE_CONVERSATION_KEY}.ws.${hashedWorkspace}`,
  };
}

function getConversationStorageKey(workspacePath: string, conversationId: string): string {
  return `${getWorkspaceStorageKeys(workspacePath).workspacePrefix}.${conversationId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function collectWorkspaceConversationKeys(workspacePath: string): string[] {
  if (!isBrowserStorageAvailable()) {
    return [];
  }

  const { workspacePrefix, activeKey } = getWorkspaceStorageKeys(workspacePath);
  const keysToRemove: string[] = [];

  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (!key) {
      continue;
    }

    if (key === workspacePrefix || key === activeKey || key.startsWith(`${workspacePrefix}.`)) {
      keysToRemove.push(key);
    }
  }

  return keysToRemove;
}

function collectAllConversationKeys(): string[] {
  if (!isBrowserStorageAvailable()) {
    return [];
  }

  const keysToRemove: string[] = [];

  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (
      key &&
      (key.startsWith(CONVERSATIONS_STORAGE_KEY) || key.startsWith(ACTIVE_CONVERSATION_KEY))
    ) {
      keysToRemove.push(key);
    }
  }

  return keysToRemove;
}

function removeStorageKeys(keys: string[]): void {
  if (!isBrowserStorageAvailable()) {
    return;
  }

  keys.forEach((key) => {
    window.localStorage.removeItem(key);
  });
}

function emitConversationStoreEvent(detail: ConversationStoreEventDetail): void {
  if (!isBrowserStorageAvailable()) {
    return;
  }

  window.dispatchEvent(new CustomEvent<ConversationStoreEventDetail>(CONVERSATION_STORE_EVENT, { detail }));
}

export function clearWorkspaceConversations(workspacePath: string): void {
  if (!isBrowserStorageAvailable()) {
    return;
  }

  try {
    const keysToRemove = collectWorkspaceConversationKeys(workspacePath);
    removeStorageKeys(keysToRemove);
    emitConversationStoreEvent({ type: "workspace-cleared", workspacePath });

    console.log(
      `[clearWorkspaceConversations] Cleared ${keysToRemove.length} conversation keys for workspace:`,
      workspacePath,
      keysToRemove,
    );
  } catch (error) {
    console.error("Failed to clear workspace conversations:", error);
  }
}

export function clearAllConversations(): void {
  if (!isBrowserStorageAvailable()) {
    return;
  }

  try {
    const keysToRemove = collectAllConversationKeys();
    removeStorageKeys(keysToRemove);
    emitConversationStoreEvent({ type: "all-cleared" });

    console.log(
      `[clearAllConversations] Cleared ${keysToRemove.length} conversation keys:`,
      keysToRemove,
    );
  } catch (error) {
    console.error("Failed to clear conversations:", error);
  }
}

export function migrateLegacyConversationBindings(
  legacyProfileSelections: Record<
    string,
    ModelSelection & { vendorName?: string; modelName?: string }
  >,
): void {
  if (!isBrowserStorageAvailable() || Object.keys(legacyProfileSelections).length === 0) {
    return;
  }

  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (!key || !key.startsWith(`${CONVERSATIONS_STORAGE_KEY}.ws.`)) {
      continue;
    }

    const parsed = parseJson<unknown>(window.localStorage.getItem(key));
    if (!isRecord(parsed)) {
      continue;
    }

    const binding = parsed.agentBinding;
    if (!isRecord(binding)) {
      continue;
    }

    if (typeof binding.vendorId === "string" && typeof binding.modelId === "string") {
      continue;
    }

    const legacyProfileId = typeof binding.profileId === "string" ? binding.profileId : null;
    if (!legacyProfileId) {
      continue;
    }

    const mapped = legacyProfileSelections[legacyProfileId];
    if (!mapped) {
      continue;
    }

    const migrated = {
      ...parsed,
      agentBinding: {
        ...binding,
        vendorId: mapped.vendorId,
        modelId: mapped.modelId,
        vendorNameSnapshot:
          typeof binding.vendorNameSnapshot === "string"
            ? binding.vendorNameSnapshot
            : mapped.vendorName,
        modelNameSnapshot:
          typeof binding.modelNameSnapshot === "string"
            ? binding.modelNameSnapshot
            : mapped.modelName,
      },
    };

    delete (migrated.agentBinding as Record<string, unknown>).profileId;

    try {
      window.localStorage.setItem(key, JSON.stringify(migrated));
    } catch {
      // ignore malformed historical payloads or storage failures during migration
    }
  }
}

export function migrateGlobalToWorkspace(workspacePath: string): void {
  if (!isBrowserStorageAvailable()) {
    return;
  }

  try {
    const globalListRaw = window.localStorage.getItem(CONVERSATIONS_STORAGE_KEY);
    if (!globalListRaw) {
      return;
    }

    const workspaceKeys = getWorkspaceStorageKeys(workspacePath);
    if (window.localStorage.getItem(workspaceKeys.listKey)) {
      return;
    }

    const globalList = parseJson<ConversationMetadata[]>(globalListRaw);
    if (!Array.isArray(globalList) || globalList.length === 0) {
      return;
    }

    window.localStorage.setItem(workspaceKeys.listKey, globalListRaw);

    for (const meta of globalList) {
      if (!meta?.id) {
        continue;
      }

      const globalConversationData = window.localStorage.getItem(
        `${CONVERSATIONS_STORAGE_KEY}.${meta.id}`,
      );
      if (globalConversationData) {
        window.localStorage.setItem(
          getConversationStorageKey(workspacePath, meta.id),
          globalConversationData,
        );
      }
    }

    const globalActiveConversationId = window.localStorage.getItem(ACTIVE_CONVERSATION_KEY);
    if (globalActiveConversationId) {
      window.localStorage.setItem(workspaceKeys.activeKey, globalActiveConversationId);
    }

    for (const meta of globalList) {
      if (!meta?.id) {
        continue;
      }
      window.localStorage.removeItem(`${CONVERSATIONS_STORAGE_KEY}.${meta.id}`);
    }

    window.localStorage.removeItem(CONVERSATIONS_STORAGE_KEY);
    window.localStorage.removeItem(ACTIVE_CONVERSATION_KEY);

    console.log(`Migrated ${globalList.length} conversations to workspace: ${workspacePath}`);
  } catch (error) {
    console.error("Failed to migrate global conversations to workspace:", error);
  }
}
