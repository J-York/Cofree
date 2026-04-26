import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearChatHistory,
  loadChatHistory,
  saveChatHistory,
  truncateMessagesFrom,
  type ChatMessageRecord,
} from "./chatHistoryStore";

class MemoryStorage implements Storage {
  private data = new Map<string, string>();

  get length(): number {
    return this.data.size;
  }

  clear(): void {
    this.data.clear();
  }

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.data.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

describe("chatHistoryStore context attachments", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { localStorage: new MemoryStorage() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("persists and reloads message context attachments", () => {
    const messages: ChatMessageRecord[] = [
      {
        id: "user-1",
        role: "user",
        content: "请分析",
        createdAt: "2026-03-09T00:00:00.000Z",
        plan: null,
        contextAttachments: [
          {
            id: "ctx-1",
            kind: "file",
            source: "mention",
            relativePath: "src/App.tsx",
            displayName: "App.tsx",
            addedAt: "2026-03-09T00:00:00.000Z",
          },
        ],
      },
    ];

    saveChatHistory(messages);

    expect(loadChatHistory()).toEqual([
      expect.objectContaining({
        id: "user-1",
        role: "user",
        content: "请分析",
        createdAt: "2026-03-09T00:00:00.000Z",
        plan: null,
        contextAttachments: [
          expect.objectContaining({
            relativePath: "src/App.tsx",
            displayName: "App.tsx",
            kind: "file",
            source: "mention",
          }),
        ],
      }),
    ]);
  });

  it("clears stored history", () => {
    saveChatHistory([
      {
        id: "user-1",
        role: "user",
        content: "hello",
        createdAt: "2026-03-09T00:00:00.000Z",
        plan: null,
      },
    ]);

    clearChatHistory();

    expect(loadChatHistory()).toEqual([]);
  });

  it("persists and normalizes explicitSkillIds round-trip", () => {
    const messages: ChatMessageRecord[] = [
      {
        id: "asst-1",
        role: "assistant",
        content: "doing work",
        createdAt: "2026-04-01T00:00:00.000Z",
        plan: null,
        explicitSkillIds: ["global:odps", "workspace:resume-screener"],
      },
      {
        id: "asst-2",
        role: "assistant",
        content: "no skills",
        createdAt: "2026-04-01T00:00:01.000Z",
        plan: null,
      },
    ];

    saveChatHistory(messages);

    const loaded = loadChatHistory();
    expect(loaded).toHaveLength(2);
    expect(loaded[0]!.explicitSkillIds).toEqual(["global:odps", "workspace:resume-screener"]);
    expect(loaded[1]!.explicitSkillIds).toBeUndefined();
  });

  it("strips non-string entries from explicitSkillIds during normalization", () => {
    const raw = [
      {
        id: "asst-3",
        role: "assistant",
        content: "mixed",
        createdAt: "2026-04-01T00:00:02.000Z",
        explicitSkillIds: ["global:odps", 42, null],
      },
    ];

    saveChatHistory(raw as any);

    // The invalid entries cause the entire explicitSkillIds to be stripped
    const loaded = loadChatHistory();
    expect(loaded[0]!.explicitSkillIds).toBeUndefined();
  });
  });

describe("truncateMessagesFrom", () => {
  function msg(id: string, role: ChatMessageRecord["role"] = "user"): ChatMessageRecord {
    return {
      id,
      role,
      content: id,
      createdAt: "2026-04-26T00:00:00Z",
      plan: null,
    };
  }

  it("drops the target message and everything after it", () => {
    const messages = [msg("u1"), msg("a1", "assistant"), msg("u2"), msg("a2", "assistant")];
    const result = truncateMessagesFrom(messages, "u2");
    expect(result.map((m) => m.id)).toEqual(["u1", "a1"]);
  });

  it("returns the original reference when id is not found (no-op marker)", () => {
    const messages = [msg("u1"), msg("a1", "assistant")];
    const result = truncateMessagesFrom(messages, "missing");
    expect(result).toBe(messages);
  });

  it("returns empty when truncating from the very first message", () => {
    const messages = [msg("u1"), msg("a1", "assistant")];
    const result = truncateMessagesFrom(messages, "u1");
    expect(result).toEqual([]);
  });

  it("returns the input unchanged for an empty array", () => {
    const messages: ChatMessageRecord[] = [];
    expect(truncateMessagesFrom(messages, "anything")).toBe(messages);
  });
});
