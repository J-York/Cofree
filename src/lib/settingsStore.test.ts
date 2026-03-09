import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY_V3,
  createManagedModel,
  loadSettings,
  resolveManagedModelSelection,
  saveSettings,
  updateManagedModel,
  type AppSettings,
} from "./settingsStore";

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

describe("settingsStore managed model thinking", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { localStorage: new MemoryStorage() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("defaults new managed models to thinking disabled with medium effort", () => {
    const model = createManagedModel("vendor-test", "gpt-5");

    expect(model.supportsThinking).toBe(false);
    expect(model.thinkingLevel).toBe("medium");
  });

  it("loads legacy persisted models without thinking metadata as disabled medium", () => {
    const legacyManagedModels = DEFAULT_SETTINGS.managedModels.map((model) => ({
      id: model.id,
      vendorId: model.vendorId,
      name: model.name,
      source: model.source,
      createdAt: model.createdAt,
      updatedAt: model.updatedAt,
    }));

    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY_V3,
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        apiKey: "",
        managedModels: legacyManagedModels,
      }),
    );

    const loaded = loadSettings();

    expect(loaded.managedModels[0]).toMatchObject({
      supportsThinking: false,
      thinkingLevel: "medium",
    });
  });

  it("persists explicit thinking settings when saved and reloaded", () => {
    const modelId = DEFAULT_SETTINGS.managedModels[0].id;
    const customized = updateManagedModel(DEFAULT_SETTINGS, modelId, {
      supportsThinking: true,
      thinkingLevel: "high",
    });

    saveSettings(customized);
    const loaded = loadSettings();

    expect(loaded.managedModels[0]).toMatchObject({
      supportsThinking: true,
      thinkingLevel: "high",
    });
  });

  it("loads recent workspaces with the active workspace pinned first", () => {
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY_V3,
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        apiKey: "",
        workspacePath: "/repo/current",
        recentWorkspaces: [
          "/repo/older",
          "/repo/current",
          42,
          "   ",
          "/repo/older-2",
          "/repo/older-3",
          "/repo/older-4",
        ],
      }),
    );

    const loaded = loadSettings();

    expect(loaded.recentWorkspaces).toEqual([
      "/repo/current",
      "/repo/older",
      "/repo/older-2",
      "/repo/older-3",
      "/repo/older-4",
    ]);
  });

  it("returns null for mismatched vendor/model selections instead of cross-vendor fallback", () => {
    const settings: AppSettings = {
      ...DEFAULT_SETTINGS,
      vendors: [
        {
          ...DEFAULT_SETTINGS.vendors[0],
          id: "vendor-claude",
          name: "Claude Vendor",
          protocol: "anthropic-messages",
        },
        {
          ...DEFAULT_SETTINGS.vendors[0],
          id: "vendor-modelscope",
          name: "ModelScope Vendor",
          protocol: "openai-chat-completions",
        },
      ],
      managedModels: [
        {
          ...DEFAULT_SETTINGS.managedModels[0],
          id: "model-claude",
          vendorId: "vendor-claude",
          name: "claude-sonnet-4-5",
        },
        {
          ...DEFAULT_SETTINGS.managedModels[0],
          id: "model-modelscope",
          vendorId: "vendor-modelscope",
          name: "qwen-max",
        },
      ],
    };

    expect(
      resolveManagedModelSelection(settings, {
        vendorId: "vendor-modelscope",
        modelId: "model-claude",
      }),
    ).toBeNull();
  });
});
