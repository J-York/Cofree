/**
 * Cofree - AI Programming Cafe
 * File: src/lib/conversationStore.ts
 * Description: Multi-conversation management with localStorage persistence
 *              Conversations are scoped per workspace via key namespacing.
 */

import type { ChatMessageRecord } from "./chatHistoryStore";

export const CONVERSATIONS_STORAGE_KEY = "cofree.conversations.v1";
export const ACTIVE_CONVERSATION_KEY = "cofree.activeConversation.v1";

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessageRecord[];
}

export interface ConversationMetadata {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
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

/**
 * Returns the workspace-namespaced storage key prefix.
 */
function getStorageKeyPrefix(workspacePath: string): string {
  const h = workspaceHash(workspacePath);
  return `${CONVERSATIONS_STORAGE_KEY}.ws.${h}`;
}

/**
 * Returns the workspace-namespaced active conversation key.
 */
function getActiveKey(workspacePath: string): string {
  const h = workspaceHash(workspacePath);
  return `${ACTIVE_CONVERSATION_KEY}.ws.${h}`;
}

function generateConversationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `conv-${crypto.randomUUID()}`;
  }
  return `conv-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function generateConversationTitle(messages: ChatMessageRecord[]): string {
  const firstUserMessage = messages.find((m) => m.role === "user");
  if (firstUserMessage && firstUserMessage.content.trim()) {
    const preview = firstUserMessage.content.trim().slice(0, 30);
    return preview.length < firstUserMessage.content.trim().length ? `${preview}...` : preview;
  }
  return "新对话";
}

/**
 * Load all conversation metadata (without full message history)
 */
export function loadConversationList(workspacePath: string): ConversationMetadata[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const key = getStorageKeyPrefix(workspacePath);
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        id: typeof item.id === "string" ? item.id : "",
        title: typeof item.title === "string" ? item.title : "未命名对话",
        createdAt: typeof item.createdAt === "string" ? item.createdAt : "",
        updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : "",
        messageCount: typeof item.messageCount === "number" ? item.messageCount : 0,
      }))
      .filter((item) => item.id && item.createdAt);
  } catch {
    return [];
  }
}

/**
 * Load a specific conversation with full message history
 */
export function loadConversation(workspacePath: string, conversationId: string): Conversation | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const key = `${getStorageKeyPrefix(workspacePath)}.${conversationId}`;
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    return {
      id: typeof parsed.id === "string" ? parsed.id : conversationId,
      title: typeof parsed.title === "string" ? parsed.title : "未命名对话",
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
    };
  } catch {
    return null;
  }
}

/**
 * Save a conversation (creates or updates)
 */
export function saveConversation(workspacePath: string, conversation: Conversation): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    // Save full conversation data
    const key = `${getStorageKeyPrefix(workspacePath)}.${conversation.id}`;
    window.localStorage.setItem(key, JSON.stringify(conversation));

    // Update metadata list
    const list = loadConversationList(workspacePath);
    const existingIndex = list.findIndex((item) => item.id === conversation.id);

    const metadata: ConversationMetadata = {
      id: conversation.id,
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      messageCount: conversation.messages.length,
    };

    if (existingIndex >= 0) {
      list[existingIndex] = metadata;
    } else {
      list.push(metadata);
    }

    // Sort by updatedAt descending
    list.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    window.localStorage.setItem(getStorageKeyPrefix(workspacePath), JSON.stringify(list));
  } catch (error) {
    console.error("Failed to save conversation:", error);
  }
}

/**
 * Create a new conversation
 */
export function createConversation(workspacePath: string, initialMessages: ChatMessageRecord[] = []): Conversation {
  const now = new Date().toISOString();
  const conversation: Conversation = {
    id: generateConversationId(),
    title: generateConversationTitle(initialMessages),
    createdAt: now,
    updatedAt: now,
    messages: initialMessages,
  };

  saveConversation(workspacePath, conversation);
  setActiveConversationId(workspacePath, conversation.id);

  return conversation;
}

/**
 * Delete a conversation
 */
export function deleteConversation(workspacePath: string, conversationId: string): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    // Remove full conversation data
    const key = `${getStorageKeyPrefix(workspacePath)}.${conversationId}`;
    window.localStorage.removeItem(key);

    // Update metadata list
    const list = loadConversationList(workspacePath);
    const filtered = list.filter((item) => item.id !== conversationId);
    window.localStorage.setItem(getStorageKeyPrefix(workspacePath), JSON.stringify(filtered));

    // If this was the active conversation, clear it
    if (getActiveConversationId(workspacePath) === conversationId) {
      window.localStorage.removeItem(getActiveKey(workspacePath));
    }
  } catch (error) {
    console.error("Failed to delete conversation:", error);
  }
}

/**
 * Update conversation title
 */
export function updateConversationTitle(workspacePath: string, conversationId: string, newTitle: string): void {
  const conversation = loadConversation(workspacePath, conversationId);
  if (!conversation) {
    return;
  }

  conversation.title = newTitle;
  conversation.updatedAt = new Date().toISOString();
  saveConversation(workspacePath, conversation);
}

/**
 * Get active conversation ID
 */
export function getActiveConversationId(workspacePath: string): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage.getItem(getActiveKey(workspacePath));
  } catch {
    return null;
  }
}

/**
 * Set active conversation ID
 */
export function setActiveConversationId(workspacePath: string, conversationId: string): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(getActiveKey(workspacePath), conversationId);
  } catch (error) {
    console.error("Failed to set active conversation:", error);
  }
}

/**
 * Migrate old single-conversation data to new multi-conversation format
 */
export function migrateOldChatHistory(workspacePath: string, oldMessages: ChatMessageRecord[]): void {
  if (typeof window === "undefined" || oldMessages.length === 0) {
    return;
  }

  // Check if migration already happened
  const existingList = loadConversationList(workspacePath);
  if (existingList.length > 0) {
    return; // Already migrated
  }

  // Create a conversation from old messages
  const conversation = createConversation(workspacePath, oldMessages);
  console.log("Migrated old chat history to conversation:", conversation.id);
}

/**
 * Migrate global (un-namespaced) conversations to workspace-scoped keys.
 * Runs only when the global key has data AND the workspace key is empty.
 * After a successful copy, the global keys are removed.
 */
export function migrateGlobalToWorkspace(workspacePath: string): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    const globalListRaw = window.localStorage.getItem(CONVERSATIONS_STORAGE_KEY);
    if (!globalListRaw) {
      return; // Nothing to migrate
    }

    const wsPrefix = getStorageKeyPrefix(workspacePath);
    const existingWsList = window.localStorage.getItem(wsPrefix);
    if (existingWsList) {
      return; // Workspace already has data, skip migration
    }

    const globalList: ConversationMetadata[] = JSON.parse(globalListRaw);
    if (!Array.isArray(globalList) || globalList.length === 0) {
      return;
    }

    // Copy the metadata list
    window.localStorage.setItem(wsPrefix, globalListRaw);

    // Copy each individual conversation
    for (const meta of globalList) {
      if (!meta.id) continue;
      const oldKey = `${CONVERSATIONS_STORAGE_KEY}.${meta.id}`;
      const convData = window.localStorage.getItem(oldKey);
      if (convData) {
        window.localStorage.setItem(`${wsPrefix}.${meta.id}`, convData);
      }
    }

    // Copy active conversation ID
    const globalActive = window.localStorage.getItem(ACTIVE_CONVERSATION_KEY);
    if (globalActive) {
      window.localStorage.setItem(getActiveKey(workspacePath), globalActive);
    }

    // Remove global keys
    for (const meta of globalList) {
      if (!meta.id) continue;
      window.localStorage.removeItem(`${CONVERSATIONS_STORAGE_KEY}.${meta.id}`);
    }
    window.localStorage.removeItem(CONVERSATIONS_STORAGE_KEY);
    window.localStorage.removeItem(ACTIVE_CONVERSATION_KEY);

    console.log(`Migrated ${globalList.length} conversations to workspace: ${workspacePath}`);
  } catch (error) {
    console.error("Failed to migrate global conversations to workspace:", error);
  }
}
