/**
 * Cofree - AI Programming Cafe
 * File: src/lib/conversationStore.ts
 * Description: Multi-conversation management with localStorage persistence.
 *              Runtime CRUD and migration concerns are intentionally kept separate.
 */

import type { ChatMessageRecord } from "./chatHistoryStore";
import type { ConversationAgentBinding } from "../agents/types";

export const CONVERSATIONS_STORAGE_KEY = "cofree.conversations.v1";
export const ACTIVE_CONVERSATION_KEY = "cofree.activeConversation.v1";

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessageRecord[];
  lastTokenCount?: number | null;
  agentBinding?: ConversationAgentBinding;
}

export interface ConversationMetadata {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  agentId?: string;
  agentName?: string;
}


interface WorkspaceStorageKeys {
  workspacePrefix: string;
  listKey: string;
  activeKey: string;
}

/**
 * djb2 hash of a string, returned as a short base36 string.
 * Falls back to "default" if path is empty/undefined.
 */
export function workspaceHash(workspacePath: string): string {
  if (!workspacePath) return "default";
  let hash = 5381;
  for (let i = 0; i < workspacePath.length; i++) {
    hash = ((hash << 5) + hash + workspacePath.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

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

function normalizeAgentBinding(value: unknown): ConversationAgentBinding | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  if (typeof obj.agentId !== "string" || !obj.agentId) return undefined;
  if (typeof obj.vendorId !== "string" || typeof obj.modelId !== "string") {
    return undefined;
  }
  return {
    agentId: obj.agentId,
    vendorId: obj.vendorId,
    modelId: obj.modelId,
    bindingSource: obj.bindingSource === "user-override" ? "user-override" : "default",
    agentNameSnapshot: typeof obj.agentNameSnapshot === "string" ? obj.agentNameSnapshot : obj.agentId,
    vendorNameSnapshot:
      typeof obj.vendorNameSnapshot === "string" ? obj.vendorNameSnapshot : undefined,
    modelNameSnapshot:
      typeof obj.modelNameSnapshot === "string" ? obj.modelNameSnapshot : undefined,
    boundAt: typeof obj.boundAt === "string" ? obj.boundAt : "",
  };
}

function normalizeConversationMetadata(value: unknown): ConversationMetadata | null {
  if (!isRecord(value)) {
    return null;
  }

  const metadata: ConversationMetadata = {
    id: typeof value.id === "string" ? value.id : "",
    title: typeof value.title === "string" ? value.title : "未命名对话",
    createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
    messageCount: typeof value.messageCount === "number" ? value.messageCount : 0,
    agentId: typeof value.agentId === "string" ? value.agentId : undefined,
    agentName: typeof value.agentName === "string" ? value.agentName : undefined,
  };

  return metadata.id && metadata.createdAt ? metadata : null;
}

function normalizeConversation(value: unknown, fallbackConversationId: string): Conversation | null {
  if (!isRecord(value)) {
    return null;
  }

  return {
    id: typeof value.id === "string" ? value.id : fallbackConversationId,
    title: typeof value.title === "string" ? value.title : "未命名对话",
    createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
    messages: Array.isArray(value.messages) ? (value.messages as ChatMessageRecord[]) : [],
    lastTokenCount: typeof value.lastTokenCount === "number" ? value.lastTokenCount : null,
    agentBinding: normalizeAgentBinding(value.agentBinding),
  };
}

function toConversationMetadata(conversation: Conversation): ConversationMetadata {
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messageCount: conversation.messages.length,
    agentId: conversation.agentBinding?.agentId,
    agentName: conversation.agentBinding?.agentNameSnapshot,
  };
}

function sortConversationMetadata(list: ConversationMetadata[]): ConversationMetadata[] {
  return [...list].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}

function loadStoredConversationList(workspacePath: string): ConversationMetadata[] {
  if (!isBrowserStorageAvailable()) {
    return [];
  }

  const raw = window.localStorage.getItem(getWorkspaceStorageKeys(workspacePath).listKey);
  const parsed = parseJson<unknown>(raw);
  if (!Array.isArray(parsed)) {
    return [];
  }

  return sortConversationMetadata(
    parsed
      .map((entry) => normalizeConversationMetadata(entry))
      .filter((entry): entry is ConversationMetadata => Boolean(entry)),
  );
}

function saveStoredConversationList(workspacePath: string, list: ConversationMetadata[]): void {
  if (!isBrowserStorageAvailable()) {
    return;
  }

  window.localStorage.setItem(
    getWorkspaceStorageKeys(workspacePath).listKey,
    JSON.stringify(sortConversationMetadata(list)),
  );
}

function loadStoredConversation(workspacePath: string, conversationId: string): Conversation | null {
  if (!isBrowserStorageAvailable()) {
    return null;
  }

  const raw = window.localStorage.getItem(getConversationStorageKey(workspacePath, conversationId));
  return normalizeConversation(parseJson<unknown>(raw), conversationId);
}

function saveStoredConversation(workspacePath: string, conversation: Conversation): void {
  if (!isBrowserStorageAvailable()) {
    return;
  }

  window.localStorage.setItem(
    getConversationStorageKey(workspacePath, conversation.id),
    JSON.stringify(conversation),
  );
}

function removeStoredConversation(workspacePath: string, conversationId: string): void {
  if (!isBrowserStorageAvailable()) {
    return;
  }

  window.localStorage.removeItem(getConversationStorageKey(workspacePath, conversationId));
}

function loadStoredActiveConversationId(workspacePath: string): string | null {
  if (!isBrowserStorageAvailable()) {
    return null;
  }

  return window.localStorage.getItem(getWorkspaceStorageKeys(workspacePath).activeKey);
}

function saveStoredActiveConversationId(workspacePath: string, conversationId: string): void {
  if (!isBrowserStorageAvailable()) {
    return;
  }

  window.localStorage.setItem(getWorkspaceStorageKeys(workspacePath).activeKey, conversationId);
}

function removeStoredActiveConversationId(workspacePath: string): void {
  if (!isBrowserStorageAvailable()) {
    return;
  }

  window.localStorage.removeItem(getWorkspaceStorageKeys(workspacePath).activeKey);
}


function generateConversationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `conv-${crypto.randomUUID()}`;
  }
  return `conv-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

export function generateConversationTitle(messages: ChatMessageRecord[]): string {
  const firstUserMessage = messages.find((message) => message.role === "user");
  if (firstUserMessage && firstUserMessage.content.trim()) {
    const trimmed = firstUserMessage.content.trim();
    const preview = trimmed.slice(0, 30);
    return preview.length < trimmed.length ? `${preview}...` : preview;
  }
  return "新对话";
}

/* -------------------------------------------------------------------------- */
/* Runtime CRUD API                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Load all conversation metadata (without full message history).
 */
export function loadConversationList(workspacePath: string): ConversationMetadata[] {
  if (!isBrowserStorageAvailable()) {
    return [];
  }

  try {
    return loadStoredConversationList(workspacePath);
  } catch {
    return [];
  }
}

/**
 * Load a specific conversation with full message history.
 */
export function loadConversation(
  workspacePath: string,
  conversationId: string,
): Conversation | null {
  if (!isBrowserStorageAvailable()) {
    return null;
  }

  try {
    return loadStoredConversation(workspacePath, conversationId);
  } catch {
    return null;
  }
}

/**
 * Save a conversation (creates or updates).
 */
export function saveConversation(
  workspacePath: string,
  conversation: Conversation,
): void {
  if (!isBrowserStorageAvailable()) {
    return;
  }

  try {
    saveStoredConversation(workspacePath, conversation);

    const list = loadStoredConversationList(workspacePath);
    const metadata = toConversationMetadata(conversation);
    const existingIndex = list.findIndex((entry) => entry.id === conversation.id);

    if (existingIndex >= 0) {
      list[existingIndex] = metadata;
    } else {
      list.push(metadata);
    }

    saveStoredConversationList(workspacePath, list);
  } catch (error) {
    console.error("Failed to save conversation:", error);
  }
}

/**
 * Create a new conversation.
 */
export function createConversation(
  workspacePath: string,
  initialMessages: ChatMessageRecord[] = [],
  agentBinding?: ConversationAgentBinding,
): Conversation {
  const now = new Date().toISOString();
  const conversation: Conversation = {
    id: generateConversationId(),
    title: generateConversationTitle(initialMessages),
    createdAt: now,
    updatedAt: now,
    messages: initialMessages,
    agentBinding,
  };

  saveConversation(workspacePath, conversation);
  setActiveConversationId(workspacePath, conversation.id);

  return conversation;
}

/**
 * Delete a conversation.
 */
export function deleteConversation(
  workspacePath: string,
  conversationId: string,
): void {
  if (!isBrowserStorageAvailable()) {
    return;
  }

  try {
    removeStoredConversation(workspacePath, conversationId);

    const filtered = loadStoredConversationList(workspacePath).filter(
      (entry) => entry.id !== conversationId,
    );
    saveStoredConversationList(workspacePath, filtered);

    if (loadStoredActiveConversationId(workspacePath) === conversationId) {
      removeStoredActiveConversationId(workspacePath);
    }
  } catch (error) {
    console.error("Failed to delete conversation:", error);
  }
}

/**
 * Update conversation title.
 */
export function updateConversationTitle(
  workspacePath: string,
  conversationId: string,
  newTitle: string,
): void {
  const conversation = loadConversation(workspacePath, conversationId);
  if (!conversation) {
    return;
  }

  conversation.title = newTitle;
  conversation.updatedAt = new Date().toISOString();
  saveConversation(workspacePath, conversation);
}

/**
 * Get active conversation ID.
 */
export function getActiveConversationId(workspacePath: string): string | null {
  if (!isBrowserStorageAvailable()) {
    return null;
  }

  try {
    return loadStoredActiveConversationId(workspacePath);
  } catch {
    return null;
  }
}

/**
 * Set active conversation ID.
 */
export function setActiveConversationId(
  workspacePath: string,
  conversationId: string,
): void {
  if (!isBrowserStorageAvailable()) {
    return;
  }

  try {
    saveStoredActiveConversationId(workspacePath, conversationId);
  } catch (error) {
    console.error("Failed to set active conversation:", error);
  }
}


/* -------------------------------------------------------------------------- */
/* Migration helpers                                                           */
/* -------------------------------------------------------------------------- */


/**
 * Migrate old single-conversation data to new multi-conversation format.
 */
export function migrateOldChatHistory(
  workspacePath: string,
  oldMessages: ChatMessageRecord[],
): void {
  if (!isBrowserStorageAvailable() || oldMessages.length === 0) {
    return;
  }

  const existingList = loadConversationList(workspacePath);
  if (existingList.length > 0) {
    return;
  }

  const conversation = createConversation(workspacePath, oldMessages);
  console.log("Migrated old chat history to conversation:", conversation.id);
}

