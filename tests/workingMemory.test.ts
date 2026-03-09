import { describe, expect, it } from "vitest";
import {
  createWorkingMemory,
  addDiscoveredFact,
  recordSubAgentExecution,
  extractFileKnowledge,
  serializeWorkingMemory,
  snapshotWorkingMemory,
  restoreWorkingMemory,
  normalizeWorkingMemorySnapshot,
  type WorkingMemory,
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
    expect(mem.subAgentHistory.length).toBe(0);
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

describe("recordSubAgentExecution", () => {
  it("records execution with auto-generated timestamp", () => {
    const mem = makeMemory();
    recordSubAgentExecution(mem, {
      role: "planner",
      taskDescription: "Analyze the project structure",
      replySummary: "The project uses a modular architecture...",
      proposedActionCount: 0,
      keyFindings: ["modular architecture", "TypeScript"],
    });
    expect(mem.subAgentHistory.length).toBe(1);
    expect(mem.subAgentHistory[0].role).toBe("planner");
    expect(mem.subAgentHistory[0].completedAt).toBeTruthy();
  });

  it("limits history to 20 entries", () => {
    const mem = makeMemory();
    for (let i = 0; i < 25; i++) {
      recordSubAgentExecution(mem, {
        role: "coder",
        taskDescription: `Task ${i}`,
        replySummary: `Done ${i}`,
        proposedActionCount: i,
        keyFindings: [],
      });
    }
    expect(mem.subAgentHistory.length).toBe(20);
    // Oldest entries should be evicted
    expect(mem.subAgentHistory[0].taskDescription).toBe("Task 5");
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

  it("includes sub-agent history", () => {
    const mem = makeMemory();
    recordSubAgentExecution(mem, {
      role: "planner",
      taskDescription: "Analyze project",
      replySummary: "Done",
      proposedActionCount: 3,
      keyFindings: ["finding1"],
    });
    const output = serializeWorkingMemory(mem, 2000);
    expect(output).toContain("Sub-Agent 执行历史");
    expect(output).toContain("planner");
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

  it("respects role-based sorting for coder", () => {
    const mem = makeMemory();
    mem.fileKnowledge.set("src/a.ts", {
      relativePath: "src/a.ts",
      summary: "File A",
      totalLines: 10,
      language: "typescript",
      lastReadAt: new Date().toISOString(),
      readByAgent: "coder",
    });
    mem.fileKnowledge.set("src/b.ts", {
      relativePath: "src/b.ts",
      summary: "File B",
      totalLines: 20,
      language: "typescript",
      lastReadAt: new Date().toISOString(),
      readByAgent: "main",
    });
    const output = serializeWorkingMemory(mem, 2000, "coder");
    // Files read by "main" should appear before files read by "coder"
    const indexA = output.indexOf("src/a.ts");
    const indexB = output.indexOf("src/b.ts");
    expect(indexB).toBeLessThan(indexA);
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

    const output = serializeWorkingMemory(mem, 2000, undefined, {
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
    recordSubAgentExecution(mem, {
      role: "planner",
      taskDescription: "Analyze",
      replySummary: "Done",
      proposedActionCount: 1,
      keyFindings: ["f1"],
    });

    const snapshot = snapshotWorkingMemory(mem);
    const restored = restoreWorkingMemory(snapshot);

    expect(restored.fileKnowledge.size).toBe(1);
    expect(restored.fileKnowledge.get("src/app.ts")?.summary).toBe("App component");
    expect(restored.discoveredFacts.length).toBe(1);
    expect(restored.discoveredFacts[0].content).toBe("Modular design");
    expect(restored.subAgentHistory.length).toBe(1);
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
      subAgentHistory: [],
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
      subAgentHistory: [],
    });
    expect(result).not.toBeNull();
    expect(result!.projectContext).toBe("");
    expect(result!.maxTokenBudget).toBe(4000);
  });
});
