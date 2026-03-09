import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  addModelsToVendor,
  createManagedModel,
  syncRuntimeSettings,
  updateWorkspacePath,
} from "../src/lib/settingsStore";

describe("settingsStore managed model ids", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("generates unique ids when adding several models in one batch", () => {
    vi.stubGlobal("crypto", undefined);
    vi.spyOn(Date, "now").mockReturnValue(1_710_000_000_000);
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0.11111111)
      .mockReturnValueOnce(0.22222222)
      .mockReturnValueOnce(0.33333333)
      .mockReturnValueOnce(0.44444444);

    const { added } = addModelsToVendor(
      DEFAULT_SETTINGS,
      DEFAULT_SETTINGS.activeVendorId!,
      ["alpha", "beta", "gamma", "delta"],
      "fetched",
    );

    expect(added).toHaveLength(4);
    expect(new Set(added.map((model) => model.id)).size).toBe(4);
  });

  it("repairs duplicated managed model ids so only one model stays active", () => {
    const duplicateId = "model-duplicate";
    const vendorId = DEFAULT_SETTINGS.activeVendorId!;
    const duplicateModels = ["alpha", "beta", "gamma", "delta"].map((name) => ({
      ...createManagedModel(vendorId, name, "fetched"),
      id: duplicateId,
    }));

    vi.stubGlobal("crypto", {
      randomUUID: vi
        .fn()
        .mockReturnValueOnce("repair-1")
        .mockReturnValueOnce("repair-2")
        .mockReturnValueOnce("repair-3"),
    });

    const repaired = syncRuntimeSettings({
      ...DEFAULT_SETTINGS,
      activeVendorId: vendorId,
      activeModelId: duplicateId,
      managedModels: [...DEFAULT_SETTINGS.managedModels, ...duplicateModels],
    });

    expect(new Set(repaired.managedModels.map((model) => model.id)).size).toBe(
      repaired.managedModels.length,
    );
    expect(repaired.activeModelId).toBe(duplicateId);
    expect(repaired.model).toBe("alpha");
    expect(repaired.managedModels.filter((model) => model.id === repaired.activeModelId)).toHaveLength(1);
  });

  it("pins the current workspace to the front of recent workspaces and caps the list", () => {
    const normalized = syncRuntimeSettings({
      ...DEFAULT_SETTINGS,
      workspacePath: "/repo/current",
      recentWorkspaces: [
        "/repo/older",
        "/repo/current",
        "   ",
        "/repo/older-2",
        "/repo/older-3",
        "/repo/older-4",
        "/repo/older-5",
      ],
    });

    expect(normalized.recentWorkspaces).toEqual([
      "/repo/current",
      "/repo/older",
      "/repo/older-2",
      "/repo/older-3",
      "/repo/older-4",
    ]);
  });

  it("moves a switched workspace to the front without duplicating history", () => {
    const seeded = syncRuntimeSettings({
      ...DEFAULT_SETTINGS,
      workspacePath: "/repo/a",
      recentWorkspaces: ["/repo/a", "/repo/b", "/repo/c"],
    });

    const switched = updateWorkspacePath(seeded, "/repo/b");

    expect(switched.workspacePath).toBe("/repo/b");
    expect(switched.recentWorkspaces).toEqual(["/repo/b", "/repo/a", "/repo/c"]);
  });
});
