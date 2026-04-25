import { describe, expect, it } from "vitest";
import {
  createWorkingMemory,
  addDiscoveredFact,
  extractFileKnowledge,
  serializeWorkingMemory,
  snapshotWorkingMemory,
  restoreWorkingMemory,
  normalizeWorkingMemorySnapshot,
  sanitizeWorkingMemoryForCheckpoint,
  capWorkingMemorySnapshotJsonSize,
  setFileContent,
  invalidateFileContent,
  CHECKPOINT_WORKING_MEMORY_MAX_JSON_BYTES,
  type WorkingMemory,
  type FileKnowledge,
  type WorkingMemorySnapshot,
} from "../src/orchestrator/workingMemory";

function makeMemory(overrides?: Partial<Parameters<typeof createWorkingMemory>[0]>): WorkingMemory {
  return createWorkingMemory({
    maxTokenBudget: 4000,
    projectContext: "Test project using TypeScript + React",
    ...overrides,
  });
}

describe("createWorkingMemory", () => {
  it("creates an empty working memory with given budget", () => {
    const mem = makeMemory();
    expect(mem.fileKnowledge.size).toBe(0);
    expect(mem.discoveredFacts.length).toBe(0);
    expect(mem.projectContext).toBe("Test project using TypeScript + React");
    expect(mem.maxTokenBudget).toBe(4000);
  });

  it("defaults projectContext to empty string", () => {
    const mem = createWorkingMemory({ maxTokenBudget: 1000 });
    expect(mem.projectContext).toBe("");
  });
});

describe("addDiscoveredFact", () => {
  it("adds a fact with auto-generated id and timestamp", () => {
    const mem = makeMemory();
    addDiscoveredFact(mem, {
      category: "architecture",
      content: "Uses MVC pattern",
      source: "planner:analysis",
      confidence: "high",
    });
    expect(mem.discoveredFacts.length).toBe(1);
    expect(mem.discoveredFacts[0].category).toBe("architecture");
    expect(mem.discoveredFacts[0].id).toMatch(/^fact-/);
    expect(mem.discoveredFacts[0].createdAt).toBeTruthy();
  });

  it("deduplicates facts with same content and category", () => {
    const mem = makeMemory();
    addDiscoveredFact(mem, { category: "api", content: "REST API", source: "a", confidence: "high" });
    addDiscoveredFact(mem, { category: "api", content: "REST API", source: "b", confidence: "high" });
    expect(mem.discoveredFacts.length).toBe(1);
  });

  it("allows same content in different categories", () => {
    const mem = makeMemory();
    addDiscoveredFact(mem, { category: "api", content: "REST API", source: "a", confidence: "high" });
    addDiscoveredFact(mem, { category: "convention", content: "REST API", source: "b", confidence: "high" });
    expect(mem.discoveredFacts.length).toBe(2);
  });

  it("evicts low-confidence facts when over limit", () => {
    const mem = makeMemory();
    // Add 50 high-confidence facts
    for (let i = 0; i < 50; i++) {
      addDiscoveredFact(mem, {
        category: "api",
        content: `Fact ${i}`,
        source: "test",
        confidence: i < 5 ? "low" : "high",
      });
    }
    expect(mem.discoveredFacts.length).toBe(50);

    // Adding one more should evict a low-confidence one
    addDiscoveredFact(mem, {
      category: "api",
      content: "New fact",
      source: "test",
      confidence: "high",
    });
    expect(mem.discoveredFacts.length).toBe(50);
    // Low-confidence facts should have been evicted first
    const lowCount = mem.discoveredFacts.filter((f) => f.confidence === "low").length;
    expect(lowCount).toBeLessThan(5);
  });
});


describe("extractFileKnowledge", () => {
  it("extracts from read_file results", () => {
    const result = extractFileKnowledge(
      "read_file",
      { relative_path: "src/app.ts" },
      'import React from "react";\n\nexport function App() {\n  return <div />;\n}\n',
      "main",
    );
    expect(result).not.toBeNull();
    expect(result!.relativePath).toBe("src/app.ts");
    expect(result!.totalLines).toBe(6);
    expect(result!.language).toBe("typescript");
    expect(result!.readByAgent).toBe("main");
    expect(result!.summary.length).toBeGreaterThan(0);
    expect(result!.summary.length).toBeLessThanOrEqual(200);
  });

  it("extracts from read_file with path arg", () => {
    const result = extractFileKnowledge(
      "read_file",
      { path: "README.md" },
      "# Hello\nThis is a readme.\n",
      "planner",
    );
    expect(result).not.toBeNull();
    expect(result!.relativePath).toBe("README.md");
    expect(result!.language).toBe("markdown");
  });

  it("returns null for read_file without path", () => {
    const result = extractFileKnowledge("read_file", {}, "content", "main");
    expect(result).toBeNull();
  });

  it("extracts from grep results", () => {
    const result = extractFileKnowledge(
      "grep",
      { pattern: "import" },
      "src/app.ts:1:import React from 'react'\nsrc/main.ts:3:import { App } from './app'\n",
      "main",
    );
    expect(result).not.toBeNull();
    expect(result!.relativePath).toBe("src/app.ts");
  });

  it("returns null for unknown tool", () => {
    const result = extractFileKnowledge("propose_shell", {}, "output", "main");
    expect(result).toBeNull();
  });

  it("returns null for grep with no file matches", () => {
    const result = extractFileKnowledge("grep", {}, "no matches found", "main");
    expect(result).toBeNull();
  });
});

describe("serializeWorkingMemory", () => {
  it("returns empty string when budget is zero", () => {
    const mem = makeMemory();
    expect(serializeWorkingMemory(mem, 0)).toBe("");
  });

  it("includes project context in output", () => {
    const mem = makeMemory();
    const output = serializeWorkingMemory(mem, 1000);
    expect(output).toContain("项目上下文");
    expect(output).toContain("TypeScript + React");
  });

  it("includes file knowledge", () => {
    const mem = makeMemory();
    mem.fileKnowledge.set("src/app.ts", {
      relativePath: "src/app.ts",
      summary: "Main app component",
      totalLines: 50,
      language: "typescript",
      lastReadAt: new Date().toISOString(),
      readByAgent: "main",
    });
    const output = serializeWorkingMemory(mem, 2000);
    expect(output).toContain("src/app.ts");
    expect(output).toContain("已读取文件");
  });

  it("includes high-confidence facts", () => {
    const mem = makeMemory();
    addDiscoveredFact(mem, {
      category: "architecture",
      content: "Uses microservices",
      source: "test",
      confidence: "high",
    });
    const output = serializeWorkingMemory(mem, 2000);
    expect(output).toContain("Uses microservices");
    expect(output).toContain("已确认事实");
  });


  it("truncates when budget is small", () => {
    const mem = makeMemory({ projectContext: "A".repeat(500) });
    for (let i = 0; i < 10; i++) {
      addDiscoveredFact(mem, {
        category: "api",
        content: `API endpoint ${i}: /api/v1/resource${i}`,
        source: "test",
        confidence: "high",
      });
    }
    // Use a budget large enough to fit the first section header but not all content
    const fullOutput = serializeWorkingMemory(mem, 10000);
    const smallOutput = serializeWorkingMemory(mem, 200);
    expect(smallOutput.length).toBeGreaterThan(0);
    expect(smallOutput.length).toBeLessThan(fullOutput.length);
  });

  it("prioritizes query-matching and focused files in retrieved memory context", () => {
    const mem = makeMemory();
    mem.fileKnowledge.set("src/shared/logger.ts", {
      relativePath: "src/shared/logger.ts",
      summary: "Generic logging helpers",
      totalLines: 60,
      language: "typescript",
      lastReadAt: "2026-03-09T00:00:00.000Z",
      lastReadTurn: 8,
      readByAgent: "main",
    });
    mem.fileKnowledge.set("src/auth/login.ts", {
      relativePath: "src/auth/login.ts",
      summary: "Handles login validation and auth tokens",
      totalLines: 80,
      language: "typescript",
      lastReadAt: "2026-03-08T00:00:00.000Z",
      lastReadTurn: 2,
      readByAgent: "planner",
    });

    const output = serializeWorkingMemory(mem, 2000, {
      query: "fix login token bug",
      focusedPaths: ["src/auth/login.ts"],
    });

    const loginIndex = output.indexOf("src/auth/login.ts");
    const loggerIndex = output.indexOf("src/shared/logger.ts");
    expect(loginIndex).toBeGreaterThan(-1);
    expect(loggerIndex).toBeGreaterThan(-1);
    expect(loginIndex).toBeLessThan(loggerIndex);
  });
});

describe("snapshot and restore", () => {
  it("round-trips through snapshot and restore", () => {
    const mem = makeMemory();
    mem.fileKnowledge.set("src/app.ts", {
      relativePath: "src/app.ts",
      summary: "App component",
      totalLines: 50,
      language: "typescript",
      lastReadAt: "2026-01-01T00:00:00Z",
      readByAgent: "main",
    });
    addDiscoveredFact(mem, {
      category: "architecture",
      content: "Modular design",
      source: "test",
      confidence: "high",
    });

    const snapshot = snapshotWorkingMemory(mem);
    const restored = restoreWorkingMemory(snapshot);

    expect(restored.fileKnowledge.size).toBe(1);
    expect(restored.fileKnowledge.get("src/app.ts")?.summary).toBe("App component");
    expect(restored.discoveredFacts.length).toBe(1);
    expect(restored.discoveredFacts[0].content).toBe("Modular design");
    expect(restored.projectContext).toBe("Test project using TypeScript + React");
    expect(restored.maxTokenBudget).toBe(4000);
  });

  it("snapshot serializes to JSON and back", () => {
    const mem = makeMemory();
    mem.fileKnowledge.set("test.ts", {
      relativePath: "test.ts",
      summary: "test",
      totalLines: 10,
      lastReadAt: "2026-01-01T00:00:00Z",
      readByAgent: "main",
    });
    const snapshot = snapshotWorkingMemory(mem);
    const json = JSON.stringify(snapshot);
    const parsed = JSON.parse(json);
    const normalized = normalizeWorkingMemorySnapshot(parsed);

    expect(normalized).not.toBeNull();
    const restored = restoreWorkingMemory(normalized!);
    expect(restored.fileKnowledge.size).toBe(1);
    expect(restored.fileKnowledge.get("test.ts")?.summary).toBe("test");
  });
});

describe("normalizeWorkingMemorySnapshot", () => {
  it("returns null for null input", () => {
    expect(normalizeWorkingMemorySnapshot(null)).toBeNull();
  });

  it("returns null for non-object input", () => {
    expect(normalizeWorkingMemorySnapshot("string")).toBeNull();
  });

  it("returns null for missing required arrays", () => {
    expect(normalizeWorkingMemorySnapshot({ fileKnowledge: [] })).toBeNull();
  });

  it("normalizes valid snapshot", () => {
    const result = normalizeWorkingMemorySnapshot({
      fileKnowledge: [],
      discoveredFacts: [],
      projectContext: "test",
      maxTokenBudget: 2000,
    });
    expect(result).not.toBeNull();
    expect(result!.maxTokenBudget).toBe(2000);
  });

  it("provides defaults for missing optional fields", () => {
    const result = normalizeWorkingMemorySnapshot({
      fileKnowledge: [],
      discoveredFacts: [],
    });
    expect(result).not.toBeNull();
    expect(result!.projectContext).toBe("");
    expect(result!.maxTokenBudget).toBe(4000);
  });
});

// --- P3-1/P3-2: Snapshot → Restore round-trip ---
describe("P3-1/P3-2: WorkingMemory checkpoint round-trip", () => {
  it("preserves file knowledge through snapshot/restore cycle", () => {
    const mem = makeMemory();
    const knowledge = extractFileKnowledge(
      "read_file",
      { relative_path: "src/index.ts" },
      JSON.stringify({ total_lines: 100, content_preview: "export function main() {}" }),
      "main",
      5,
    );
    if (knowledge) {
      mem.fileKnowledge.set(knowledge.relativePath, knowledge);
    }
    addDiscoveredFact(mem, {
      category: "architecture",
      content: "Uses React + TypeScript",
      source: "index.ts",
      confidence: "high",
    });

    const snapshot = snapshotWorkingMemory(mem);
    const restored = restoreWorkingMemory(snapshot);

    expect(restored.fileKnowledge.size).toBe(mem.fileKnowledge.size);
    expect(restored.fileKnowledge.get("src/index.ts")?.relativePath).toBe("src/index.ts");
    expect(restored.discoveredFacts).toHaveLength(1);
    expect(restored.discoveredFacts[0].content).toBe("Uses React + TypeScript");
    expect(restored.projectContext).toBe(mem.projectContext);
    expect(restored.maxTokenBudget).toBe(mem.maxTokenBudget);
  });
});

describe("sanitizeWorkingMemoryForCheckpoint / capWorkingMemorySnapshotJsonSize", () => {
  it("truncates oversized file summaries for checkpoint persistence", () => {
    const mem = makeMemory();
    const longSummary = "x".repeat(5000);
    mem.fileKnowledge.set("a.ts", {
      relativePath: "a.ts",
      summary: longSummary,
      totalLines: 1,
      lastReadAt: "2026-01-01T00:00:00Z",
      lastReadTurn: 0,
      readByAgent: "test",
    });
    const snap = snapshotWorkingMemory(mem);
    const sanitized = sanitizeWorkingMemoryForCheckpoint(snap);
    expect(sanitized.fileKnowledge[0][1].summary.length).toBeLessThanOrEqual(2002);
    const normalized = normalizeWorkingMemorySnapshot(sanitized);
    expect(normalized).not.toBeNull();
    const restored = restoreWorkingMemory(normalized!);
    expect(restored.fileKnowledge.get("a.ts")?.summary.startsWith("x")).toBe(true);
  });

  it("evicts fileKnowledge until JSON is under maxBytes", () => {
    const entries: Array<[string, FileKnowledge]> = [];
    for (let i = 0; i < 80; i++) {
      entries.push([
        `f${i}.ts`,
        {
          relativePath: `f${i}.ts`,
          summary: "y".repeat(4000),
          totalLines: 1,
          lastReadAt: "2026-01-01T00:00:00Z",
          lastReadTurn: 0,
          readByAgent: "test",
        },
      ]);
    }
    const snap: WorkingMemorySnapshot = {
      fileKnowledge: entries,
      discoveredFacts: [],
      projectContext: "",
      maxTokenBudget: 4000,
    };
    const capped = capWorkingMemorySnapshotJsonSize(snap, 80_000);
    expect(JSON.stringify(capped).length).toBeLessThanOrEqual(80_000);
    expect(capped.fileKnowledge.length).toBeLessThan(entries.length);
  });

  it("sanitizeWorkingMemoryForCheckpoint respects CHECKPOINT_WORKING_MEMORY_MAX_JSON_BYTES", () => {
    const entries: Array<[string, FileKnowledge]> = [];
    for (let i = 0; i < 120; i++) {
      entries.push([
        `f${i}.ts`,
        {
          relativePath: `f${i}.ts`,
          summary: "z".repeat(3000),
          totalLines: 1,
          lastReadAt: "2026-01-01T00:00:00Z",
          lastReadTurn: 0,
          readByAgent: "test",
        },
      ]);
    }
    const snap: WorkingMemorySnapshot = {
      fileKnowledge: entries,
      discoveredFacts: [],
      projectContext: "p".repeat(100_000),
      maxTokenBudget: 4000,
    };
    const sanitized = sanitizeWorkingMemoryForCheckpoint(snap);
    expect(JSON.stringify(sanitized).length).toBeLessThanOrEqual(
      CHECKPOINT_WORKING_MEMORY_MAX_JSON_BYTES,
    );
  });
});

describe("setFileContent / invalidateFileContent (M3)", () => {
  it("creates a new fileKnowledge entry with content + version on first call", () => {
    const mem = makeMemory();
    setFileContent(mem, "src/a.ts", "export const x = 1;\n", {
      totalLines: 1,
      language: "typescript",
      turnNumber: 3,
      agentId: "main",
    });

    const fk = mem.fileKnowledge.get("src/a.ts");
    expect(fk?.content).toBe("export const x = 1;\n");
    expect(fk?.contentVersion).toBe(1);
    expect(fk?.totalLines).toBe(1);
    expect(fk?.language).toBe("typescript");
    expect(fk?.lastReadTurn).toBe(3);
    expect(fk?.readByAgent).toBe("main");
  });

  it("does NOT bump version when content is byte-identical (cache stability)", () => {
    const mem = makeMemory();
    setFileContent(mem, "src/a.ts", "stable body");
    setFileContent(mem, "src/a.ts", "stable body");
    expect(mem.fileKnowledge.get("src/a.ts")?.contentVersion).toBe(1);
  });

  it("bumps version when content changes", () => {
    const mem = makeMemory();
    setFileContent(mem, "src/a.ts", "v1");
    setFileContent(mem, "src/a.ts", "v2");
    expect(mem.fileKnowledge.get("src/a.ts")?.contentVersion).toBe(2);
    expect(mem.fileKnowledge.get("src/a.ts")?.content).toBe("v2");
  });

  it("invalidateFileContent clears content + version but preserves metadata", () => {
    const mem = makeMemory();
    setFileContent(mem, "src/a.ts", "body", {
      totalLines: 10,
      language: "typescript",
    });
    invalidateFileContent(mem, "src/a.ts");

    const fk = mem.fileKnowledge.get("src/a.ts");
    expect(fk?.content).toBeUndefined();
    expect(fk?.contentVersion).toBeUndefined();
    expect(fk?.totalLines).toBe(10);
    expect(fk?.language).toBe("typescript");
  });

  it("snapshot/restore round-trip preserves content + version", () => {
    const mem = makeMemory();
    setFileContent(mem, "src/a.ts", "round-trip body");
    setFileContent(mem, "src/a.ts", "round-trip body v2");

    const snap = snapshotWorkingMemory(mem);
    const restored = restoreWorkingMemory(snap);

    expect(restored.fileKnowledge.get("src/a.ts")?.content).toBe("round-trip body v2");
    expect(restored.fileKnowledge.get("src/a.ts")?.contentVersion).toBe(2);
  });
});
