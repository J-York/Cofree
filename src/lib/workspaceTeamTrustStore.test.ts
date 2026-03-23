import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearWorkspaceTeamTrustMode,
  getWorkspaceTeamTrustStorageKey,
  loadWorkspaceTeamTrustMode,
  loadWorkspaceTeamTrustRecord,
  saveWorkspaceTeamTrustMode,
} from "./workspaceTeamTrustStore";

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

describe("workspaceTeamTrustStore", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { localStorage: new MemoryStorage() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null when a workspace has no saved trust mode", () => {
    expect(loadWorkspaceTeamTrustMode("/repo/a")).toBeNull();
    expect(loadWorkspaceTeamTrustRecord("/repo/a")).toBeNull();
  });

  it("persists team_yolo with a decidedAt timestamp", () => {
    const saved = saveWorkspaceTeamTrustMode("/repo/a", "team_yolo");

    expect(saved).toMatchObject({
      workspaceHash: expect.any(String),
      mode: "team_yolo",
      decidedAt: expect.any(String),
    });
    expect(loadWorkspaceTeamTrustMode("/repo/a")).toBe("team_yolo");
    expect(loadWorkspaceTeamTrustRecord("/repo/a")).toMatchObject({
      mode: "team_yolo",
      decidedAt: saved?.decidedAt,
    });
    expect(window.localStorage.getItem(getWorkspaceTeamTrustStorageKey("/repo/a"))).toContain(
      "\"team_yolo\"",
    );
  });

  it("persists team_manual independently from team_yolo workspaces", () => {
    saveWorkspaceTeamTrustMode("/repo/a", "team_yolo");
    saveWorkspaceTeamTrustMode("/repo/b", "team_manual");

    expect(loadWorkspaceTeamTrustMode("/repo/a")).toBe("team_yolo");
    expect(loadWorkspaceTeamTrustMode("/repo/b")).toBe("team_manual");
  });

  it("clears a saved workspace decision back to unset", () => {
    saveWorkspaceTeamTrustMode("/repo/a", "team_manual");

    clearWorkspaceTeamTrustMode("/repo/a");

    expect(loadWorkspaceTeamTrustMode("/repo/a")).toBeNull();
    expect(loadWorkspaceTeamTrustRecord("/repo/a")).toBeNull();
  });
});
