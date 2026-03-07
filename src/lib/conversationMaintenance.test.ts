import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAllConversations,
  clearWorkspaceConversations,
  migrateGlobalToWorkspace,
  migrateLegacyConversationBindings,
} from "./conversationMaintenance";
import {
  ACTIVE_CONVERSATION_KEY,
  CONVERSATIONS_STORAGE_KEY,
  workspaceHash,
} from "./conversationStore";

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

class TestCustomEvent<T> {
  type: string;
  detail: T;

  constructor(type: string, init: { detail: T }) {
    this.type = type;
    this.detail = init.detail;
  }
}

function getWorkspaceKeys(workspacePath: string) {
  const workspacePrefix = `${CONVERSATIONS_STORAGE_KEY}.ws.${workspaceHash(workspacePath)}`;
  return {
    workspacePrefix,
    listKey: workspacePrefix,
    activeKey: `${ACTIVE_CONVERSATION_KEY}.ws.${workspaceHash(workspacePath)}`,
    conversationKey: (conversationId: string) => `${workspacePrefix}.${conversationId}`,
  };
}

describe("conversationMaintenance", () => {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

  beforeEach(() => {
    const localStorage = new MemoryStorage();
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { localStorage, dispatchEvent });
    vi.stubGlobal("CustomEvent", TestCustomEvent);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    logSpy.mockClear();
    errorSpy.mockClear();
  });

  it("clears only the targeted workspace conversation keys", () => {
    const workspaceA = getWorkspaceKeys("/repo/a");
    const workspaceB = getWorkspaceKeys("/repo/b");

    window.localStorage.setItem(workspaceA.listKey, "list-a");
    window.localStorage.setItem(workspaceA.activeKey, "conv-a");
    window.localStorage.setItem(workspaceA.conversationKey("conv-a"), "payload-a");
    window.localStorage.setItem(workspaceB.listKey, "list-b");
    window.localStorage.setItem(workspaceB.activeKey, "conv-b");
    window.localStorage.setItem(workspaceB.conversationKey("conv-b"), "payload-b");
    window.localStorage.setItem("unrelated", "keep");

    clearWorkspaceConversations("/repo/a");

    expect(window.localStorage.getItem(workspaceA.listKey)).toBeNull();
    expect(window.localStorage.getItem(workspaceA.activeKey)).toBeNull();
    expect(window.localStorage.getItem(workspaceA.conversationKey("conv-a"))).toBeNull();
    expect(window.localStorage.getItem(workspaceB.listKey)).toBe("list-b");
    expect(window.localStorage.getItem(workspaceB.conversationKey("conv-b"))).toBe("payload-b");
    expect(window.localStorage.getItem("unrelated")).toBe("keep");

    const dispatchEvent = vi.mocked(window.dispatchEvent);
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect(dispatchEvent.mock.calls[0][0]).toMatchObject({
      detail: { type: "workspace-cleared", workspacePath: "/repo/a" },
    });
  });

  it("clears all conversation keys across workspaces", () => {
    const workspaceA = getWorkspaceKeys("/repo/a");
    const workspaceB = getWorkspaceKeys("/repo/b");

    window.localStorage.setItem(workspaceA.listKey, "list-a");
    window.localStorage.setItem(workspaceA.conversationKey("conv-a"), "payload-a");
    window.localStorage.setItem(workspaceB.activeKey, "conv-b");
    window.localStorage.setItem(`${CONVERSATIONS_STORAGE_KEY}.legacy`, "legacy");
    window.localStorage.setItem("unrelated", "keep");

    clearAllConversations();

    expect(window.localStorage.getItem(workspaceA.listKey)).toBeNull();
    expect(window.localStorage.getItem(workspaceA.conversationKey("conv-a"))).toBeNull();
    expect(window.localStorage.getItem(workspaceB.activeKey)).toBeNull();
    expect(window.localStorage.getItem(`${CONVERSATIONS_STORAGE_KEY}.legacy`)).toBeNull();
    expect(window.localStorage.getItem("unrelated")).toBe("keep");

    const dispatchEvent = vi.mocked(window.dispatchEvent);
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect(dispatchEvent.mock.calls[0][0]).toMatchObject({
      detail: { type: "all-cleared" },
    });
  });

  it("migrates legacy profile-based bindings to vendor/model bindings", () => {
    const workspace = getWorkspaceKeys("/repo/a");
    window.localStorage.setItem(
      workspace.conversationKey("conv-1"),
      JSON.stringify({
        id: "conv-1",
        title: "Legacy",
        createdAt: "1",
        updatedAt: "1",
        messages: [],
        agentBinding: {
          agentId: "agent-1",
          profileId: "profile-1",
          bindingSource: "default",
        },
      }),
    );

    migrateLegacyConversationBindings({
      "profile-1": {
        vendorId: "vendor-1",
        modelId: "model-1",
        vendorName: "Vendor One",
        modelName: "Model One",
      },
    });

    const migrated = JSON.parse(
      window.localStorage.getItem(workspace.conversationKey("conv-1")) ?? "{}",
    ) as Record<string, unknown>;
    expect(migrated.agentBinding).toMatchObject({
      agentId: "agent-1",
      vendorId: "vendor-1",
      modelId: "model-1",
      vendorNameSnapshot: "Vendor One",
      modelNameSnapshot: "Model One",
    });
    expect((migrated.agentBinding as Record<string, unknown>).profileId).toBeUndefined();
  });

  it("migrates global conversations into the workspace namespace", () => {
    const workspace = getWorkspaceKeys("/repo/a");
    const globalList = [
      { id: "conv-1", title: "A", createdAt: "1", updatedAt: "1", messageCount: 1 },
      { id: "conv-2", title: "B", createdAt: "2", updatedAt: "2", messageCount: 0 },
    ];

    window.localStorage.setItem(CONVERSATIONS_STORAGE_KEY, JSON.stringify(globalList));
    window.localStorage.setItem(
      `${CONVERSATIONS_STORAGE_KEY}.conv-1`,
      JSON.stringify({ id: "conv-1", messages: ["hello"] }),
    );
    window.localStorage.setItem(
      `${CONVERSATIONS_STORAGE_KEY}.conv-2`,
      JSON.stringify({ id: "conv-2", messages: [] }),
    );
    window.localStorage.setItem(ACTIVE_CONVERSATION_KEY, "conv-1");

    migrateGlobalToWorkspace("/repo/a");

    expect(window.localStorage.getItem(workspace.listKey)).toBe(JSON.stringify(globalList));
    expect(window.localStorage.getItem(workspace.conversationKey("conv-1"))).toBe(
      JSON.stringify({ id: "conv-1", messages: ["hello"] }),
    );
    expect(window.localStorage.getItem(workspace.conversationKey("conv-2"))).toBe(
      JSON.stringify({ id: "conv-2", messages: [] }),
    );
    expect(window.localStorage.getItem(workspace.activeKey)).toBe("conv-1");
    expect(window.localStorage.getItem(CONVERSATIONS_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(`${CONVERSATIONS_STORAGE_KEY}.conv-1`)).toBeNull();
    expect(window.localStorage.getItem(`${CONVERSATIONS_STORAGE_KEY}.conv-2`)).toBeNull();
    expect(window.localStorage.getItem(ACTIVE_CONVERSATION_KEY)).toBeNull();
  });
});
