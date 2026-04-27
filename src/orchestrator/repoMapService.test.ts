import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { generateRepoMap, clearRepoMapCaches } from "./repoMapService";

describe("repoMapService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearRepoMapCaches();
  });

  it("prioritizes task-relevant and focused files before generic large files", async () => {
    vi.mocked(invoke).mockResolvedValue({
      files: [
        {
          path: "src/orchestrator/repoMapService.ts",
          language: "typescript",
          symbols: [
            { kind: "function", name: "generateRepoMap", line: 10, signature: "generateRepoMap(workspacePath, ignorePatterns, tokenBudget)" },
            { kind: "function", name: "rankFiles", line: 40, signature: "rankFiles(files, options)" },
          ],
        },
        {
          path: "src/orchestrator/planningService.ts",
          language: "typescript",
          symbols: [
            { kind: "function", name: "runPlanningSession", line: 100, signature: "runPlanningSession(input)" },
          ],
        },
        {
          path: "src/lib/utilityHub.ts",
          language: "typescript",
          symbols: Array.from({ length: 12 }, (_, index) => ({
            kind: "function",
            name: `helper${index}`,
            line: index + 1,
            signature: `helper${index}()`,
          })),
        },
      ],
      scanned_count: 3,
      total_files: 3,
      truncated: false,
    });

    const repoMap = await generateRepoMap("d:/Code/cofree", null, 4000, {
      taskDescription: "Improve repo map injection in planning service",
      prioritizedPaths: ["src/orchestrator/planningService.ts"],
      maxFiles: 2,
    });

    expect(repoMap).toContain("Task keywords: repo, map, injection, planning, service");
    expect(repoMap).toContain("Focused paths: src/orchestrator/planningservice.ts");
    expect(repoMap).toContain("repoMapService.ts");
    expect(repoMap).toContain("planningService.ts");
    expect(repoMap).not.toContain("utilityHub.ts");
    expect(repoMap).toContain("[focus");
    expect(repoMap).toContain("match=repo/map");
  });

  it("renders the new kind labels (M4) with correct single-char prefixes", async () => {
    // M4-1/2/3 emit specific kind labels (class / interface / constant /
    // method / type / enum) instead of the old catch-all "export". Verify
    // formatSymbolCompact maps each to the expected single-char prefix.
    vi.mocked(invoke).mockResolvedValue({
      files: [
        {
          path: "src/sample.ts",
          language: "typescript",
          symbols: [
            { kind: "class", name: "Counter", line: 1, signature: "export class Counter" },
            { kind: "method", name: "increment", line: 3, signature: "increment(): void" },
            { kind: "interface", name: "Options", line: 10, signature: "export interface Options" },
            { kind: "type", name: "Result", line: 15, signature: "export type Result" },
            { kind: "constant", name: "Greet", line: 20, signature: "export const Greet = (name: string) =>" },
            { kind: "function", name: "doWork", line: 30, signature: "export async function doWork()" },
            { kind: "enum", name: "Stage", line: 40, signature: "export enum Stage" },
          ],
        },
      ],
      scanned_count: 1,
      total_files: 1,
      truncated: false,
    });

    const repoMap = await generateRepoMap("d:/Code/cofree", null, 4000, {});

    // The repo-map line lists symbols in `formatSymbolCompact` order,
    // truncated to the first 5; verify the new prefixes are present.
    expect(repoMap).toContain("c:export class Counter");
    expect(repoMap).toContain("m:increment(): void");
    expect(repoMap).toContain("i:export interface Options");
    expect(repoMap).toContain("t:export type Result");
    expect(repoMap).toContain("v:export const Greet");
  });

  it("falls back to symbol density when no task context is provided", async () => {
    vi.mocked(invoke).mockResolvedValue({
      files: [
        {
          path: "src/main.ts",
          language: "typescript",
          symbols: [{ kind: "function", name: "main", line: 1, signature: "main()" }],
        },
        {
          path: "src/bigModule.ts",
          language: "typescript",
          symbols: Array.from({ length: 8 }, (_, index) => ({
            kind: "function",
            name: `feature${index}`,
            line: index + 1,
            signature: `feature${index}(value)`,
          })),
        },
      ],
      scanned_count: 2,
      total_files: 2,
      truncated: false,
    });

    const repoMap = await generateRepoMap("d:/Code/cofree", null, 4000, {
      maxFiles: 1,
    });

    expect(repoMap).toContain("bigModule.ts");
    expect(repoMap).not.toContain("main.ts");
    expect(repoMap).toContain("showing 1/2 prioritized files");
  });
});