/**
 * Cofree - AI Programming Cafe
 * File: src/lib/conversationStore.ts
 * Description: Multi-conversation management with localStorage persistence
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
export function loadConversationList(): ConversationMetadata[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(CONVERSATIONS_STORAGE_KEY);
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
export function loadConversation(conversationId: string): Conversation | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const key = `${CONVERSATIONS_STORAGE_KEY}.${conversationId}`;
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
export function saveConversation(conversation: Conversation): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    // Save full conversation data
    const key = `${CONVERSATIONS_STORAGE_KEY}.${conversation.id}`;
    window.localStorage.setItem(key, JSON.stringify(conversation));

    // Update metadata list
    const list = loadConversationList();
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

    window.localStorage.setItem(CONVERSATIONS_STORAGE_KEY, JSON.stringify(list));
  } catch (error) {
    console.error("Failed to save conversation:", error);
  }
}

/**
 * Create a new conversation
 */
export function createConversation(initialMessages: ChatMessageRecord[] = []): Conversation {
  const now = new Date().toISOString();
  const conversation: Conversation = {
    id: generateConversationId(),
    title: generateConversationTitle(initialMessages),
    createdAt: now,
    updatedAt: now,
    messages: initialMessages,
  };

  saveConversation(conversation);
  setActiveConversationId(conversation.id);
  
  return conversation;
}

/**
 * Delete a conversation
 */
export function deleteConversation(conversationId: string): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    // Remove full conversation data
    const key = `${CONVERSATIONS_STORAGE_KEY}.${conversationId}`;
    window.localStorage.removeItem(key);

    // Update metadata list
    const list = loadConversationList();
    const filtered = list.filter((item) => item.id !== conversationId);
    window.localStorage.setItem(CONVERSATIONS_STORAGE_KEY, JSON.stringify(filtered));

    // If this was the active conversation, clear it
    if (getActiveConversationId() === conversationId) {
      window.localStorage.removeItem(ACTIVE_CONVERSATION_KEY);
    }
  } catch (error) {
    console.error("Failed to delete conversation:", error);
  }
}

/**
 * Update conversation title
 */
export function updateConversationTitle(conversationId: string, newTitle: string): void {
  const conversation = loadConversation(conversationId);
  if (!conversation) {
    return;
  }

  conversation.title = newTitle;
  conversation.updatedAt = new Date().toISOString();
  saveConversation(conversation);
}

/**
 * Get active conversation ID
 */
export function getActiveConversationId(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage.getItem(ACTIVE_CONVERSATION_KEY);
  } catch {
    return null;
  }
}

/**
 * Set active conversation ID
 */
export function setActiveConversationId(conversationId: string): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(ACTIVE_CONVERSATION_KEY, conversationId);
  } catch (error) {
    console.error("Failed to set active conversation:", error);
  }
}

/**
 * Migrate old single-conversation data to new multi-conversation format
 */
export function migrateOldChatHistory(oldMessages: ChatMessageRecord[]): void {
  if (typeof window === "undefined" || oldMessages.length === 0) {
    return;
  }

  // Check if migration already happened
  const existingList = loadConversationList();
  if (existingList.length > 0) {
    return; // Already migrated
  }

  // Create a conversation from old messages
  const conversation = createConversation(oldMessages);
  console.log("Migrated old chat history to conversation:", conversation.id);
}
