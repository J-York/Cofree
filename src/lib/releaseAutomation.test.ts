import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function readRepoFile(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

function readJson<T>(path: string): T {
  return JSON.parse(readRepoFile(path)) as T;
}

function readCargoVersion(): string {
  const cargoToml = readRepoFile("src-tauri/Cargo.toml");
  const match = cargoToml.match(/^version\s*=\s*"([^"]+)"/m);

  if (!match) {
    throw new Error("Unable to locate package version in src-tauri/Cargo.toml");
  }

  return match[1];
}

describe("release automation invariants", () => {
  it("keeps desktop versions aligned across package sources", () => {
    const packageVersion = readJson<{ version: string }>("package.json").version;
    const cargoVersion = readCargoVersion();
    const tauriVersion = readJson<{ version: string }>("src-tauri/tauri.conf.json").version;

    expect({ packageVersion, cargoVersion, tauriVersion }).toEqual({
      packageVersion,
      cargoVersion: packageVersion,
      tauriVersion: packageVersion,
    });
  });

  it("keeps updater artifacts enabled in the checked-in Tauri config", () => {
    const tauriConfig = readJson<{
      bundle: { createUpdaterArtifacts: boolean };
      plugins: { updater: { endpoints: string[]; pubkey: string } };
    }>("src-tauri/tauri.conf.json");

    expect(tauriConfig.bundle.createUpdaterArtifacts).toBe(true);
    expect(tauriConfig.plugins.updater.endpoints).toContain(
      "https://github.com/J-York/Cofree/releases/latest/download/latest.json",
    );
    expect(tauriConfig.plugins.updater.pubkey.trim().length).toBeGreaterThan(0);
  });

  it("keeps the release workflow capable of both signed and unsigned releases", () => {
    const workflow = readRepoFile(".github/workflows/release.yml");

    expect(workflow).toContain("id: signing_modes");
    expect(workflow).toContain("TAURI_SIGNING_PRIVATE_KEY is not configured");
    expect(workflow).toContain("Build Tauri app with updater artifacts");
    expect(workflow).toContain("Build Tauri app without updater artifacts");
    expect(workflow).toContain("uploadUpdaterJson: true");
    expect(workflow).toContain("uploadUpdaterJson: false");
    expect(workflow).toContain("Import Apple Developer Certificate");
    expect(workflow).toContain("Import Windows certificate");
    expect(workflow).toContain("src-tauri/tauri.release.conf.json");
  });
});
