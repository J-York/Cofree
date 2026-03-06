/**
 * Cofree - AI Programming Cafe
 * File: src/orchestrator/workingMemory.ts
 * Description: Shared Working Memory for multi-agent collaboration.
 *
 * Maintains file knowledge, discovered facts, and sub-agent execution history
 * across the main loop and all sub-agents within a single session.
 */

import type { SubAgentRole } from "../agents/types";
import { estimateTokensFromText } from "./contextBudget";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileKnowledge {
  relativePath: string;
  summary: string;
  totalLines: number;
  language?: string;
  lastReadAt: string;
  readByAgent: string;
}

export interface DiscoveredFact {
  id: string;
  category: "architecture" | "dependency" | "api" | "config" | "convention" | "issue";
  content: string;
  source: string;
  confidence: "high" | "medium" | "low";
  createdAt: string;
}

export interface SubAgentExecRecord {
  role: SubAgentRole;
  taskDescription: string;
  replySummary: string;
  proposedActionCount: number;
  keyFindings: string[];
  completedAt: string;
}

export interface WorkingMemory {
  fileKnowledge: Map<string, FileKnowledge>;
  discoveredFacts: DiscoveredFact[];
  subAgentHistory: SubAgentExecRecord[];
  projectContext: string;
  maxTokenBudget: number;
}

// ---------------------------------------------------------------------------
// Serialization for checkpoint persistence
// ---------------------------------------------------------------------------

export interface WorkingMemorySnapshot {
  fileKnowledge: Array<[string, FileKnowledge]>;
  discoveredFacts: DiscoveredFact[];
  subAgentHistory: SubAgentExecRecord[];
  projectContext: string;
  maxTokenBudget: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_DISCOVERED_FACTS = 50;
const MAX_FILE_SUMMARY_CHARS = 200;
const MAX_SUBAGENT_HISTORY = 20;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWorkingMemory(opts: {
  maxTokenBudget: number;
  projectContext?: string;
}): WorkingMemory {
  return {
    fileKnowledge: new Map(),
    discoveredFacts: [],
    subAgentHistory: [],
    projectContext: opts.projectContext ?? "",
    maxTokenBudget: opts.maxTokenBudget,
  };
}

// ---------------------------------------------------------------------------
// Core mutation functions
// ---------------------------------------------------------------------------

let factIdCounter = 0;

function generateFactId(): string {
  factIdCounter += 1;
  return `fact-${Date.now()}-${factIdCounter}`;
}

export function addDiscoveredFact(
  memory: WorkingMemory,
  fact: Omit<DiscoveredFact, "id" | "createdAt">,
): void {
  const isDuplicate = memory.discoveredFacts.some(
    (f) => f.content === fact.content && f.category === fact.category,
  );
  if (isDuplicate) return;

  const newFact: DiscoveredFact = {
    ...fact,
    id: generateFactId(),
    createdAt: new Date().toISOString(),
  };
  memory.discoveredFacts.push(newFact);

  // LRU eviction: when over limit, remove oldest low-confidence facts first
  while (memory.discoveredFacts.length > MAX_DISCOVERED_FACTS) {
    const lowIdx = memory.discoveredFacts.findIndex((f) => f.confidence === "low");
    if (lowIdx >= 0) {
      memory.discoveredFacts.splice(lowIdx, 1);
    } else {
      const medIdx = memory.discoveredFacts.findIndex((f) => f.confidence === "medium");
      if (medIdx >= 0) {
        memory.discoveredFacts.splice(medIdx, 1);
      } else {
        memory.discoveredFacts.shift();
      }
    }
  }
}

export function recordSubAgentExecution(
  memory: WorkingMemory,
  record: Omit<SubAgentExecRecord, "completedAt">,
): void {
  memory.subAgentHistory.push({
    ...record,
    completedAt: new Date().toISOString(),
  });
  if (memory.subAgentHistory.length > MAX_SUBAGENT_HISTORY) {
    memory.subAgentHistory.shift();
  }
}

// ---------------------------------------------------------------------------
// File knowledge extraction from tool results
// ---------------------------------------------------------------------------

function inferLanguage(filePath: string): string | undefined {
  const ext = filePath.split(".").pop()?.toLowerCase();
  const langMap: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    py: "python", rs: "rust", go: "go", java: "java", kt: "kotlin",
    rb: "ruby", c: "c", cpp: "cpp", h: "c", hpp: "cpp",
    css: "css", scss: "scss", html: "html", vue: "vue", svelte: "svelte",
    json: "json", yaml: "yaml", yml: "yaml", toml: "toml", md: "markdown",
    sql: "sql", sh: "shell", bash: "shell", dockerfile: "dockerfile",
  };
  return ext ? langMap[ext] : undefined;
}

function truncateSummary(text: string): string {
  if (text.length <= MAX_FILE_SUMMARY_CHARS) return text;
  return text.slice(0, MAX_FILE_SUMMARY_CHARS - 3) + "...";
}

function buildFileSummaryFromContent(content: string, filePath: string): string {
  const lines = content.split("\n");
  const nonEmpty = lines.filter((l) => l.trim().length > 0);

  const hints: string[] = [];
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";

  if (["ts", "tsx", "js", "jsx"].includes(ext)) {
    const exports = nonEmpty.filter((l) => /^export\s/.test(l));
    if (exports.length > 0) {
      hints.push(`exports: ${exports.slice(0, 3).map((l) => l.trim().slice(0, 60)).join("; ")}`);
    }
    const imports = nonEmpty.filter((l) => /^import\s/.test(l));
    if (imports.length > 0) {
      hints.push(`${imports.length} imports`);
    }
  } else if (["py"].includes(ext)) {
    const defs = nonEmpty.filter((l) => /^(def |class |async def )/.test(l));
    if (defs.length > 0) {
      hints.push(`defines: ${defs.slice(0, 3).map((l) => l.trim().slice(0, 60)).join("; ")}`);
    }
  }

  if (hints.length > 0) {
    return truncateSummary(hints.join(" | "));
  }
  const preview = nonEmpty.slice(0, 3).join(" ").trim();
  return truncateSummary(preview || `(${lines.length} lines)`);
}

export function extractFileKnowledge(
  toolName: string,
  toolArgs: Record<string, unknown>,
  toolResult: string,
  agentId: string,
): FileKnowledge | null {
  if (toolName === "read_file") {
    const relativePath = String(toolArgs.relative_path ?? toolArgs.path ?? "").trim();
    if (!relativePath) return null;

    const totalLines = (toolResult.match(/\n/g) || []).length + 1;
    return {
      relativePath,
      summary: buildFileSummaryFromContent(toolResult, relativePath),
      totalLines,
      language: inferLanguage(relativePath),
      lastReadAt: new Date().toISOString(),
      readByAgent: agentId,
    };
  }

  if (toolName === "grep" || toolName === "glob") {
    // grep/glob results give us file-level awareness but not deep content
    const lines = toolResult.split("\n").filter((l) => l.trim());
    const filePaths = new Set<string>();
    for (const line of lines) {
      const match = line.match(/^([^\s:]+\.[a-zA-Z0-9]+)/);
      if (match) filePaths.add(match[1]);
    }
    // Return knowledge for the first mentioned file as a lightweight signal
    if (filePaths.size > 0) {
      const firstPath = [...filePaths][0];
      return {
        relativePath: firstPath,
        summary: truncateSummary(`Found in ${toolName} results (${filePaths.size} files matched)`),
        totalLines: 0,
        language: inferLanguage(firstPath),
        lastReadAt: new Date().toISOString(),
        readByAgent: agentId,
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Serialization: WorkingMemory → LLM-consumable context string
// ---------------------------------------------------------------------------

export function serializeWorkingMemory(
  memory: WorkingMemory,
  tokenBudget: number,
  forRole?: SubAgentRole,
): string {
  if (tokenBudget <= 0) return "";

  const sections: Array<{ priority: number; label: string; content: string }> = [];

  // 1. Project context (highest priority)
  if (memory.projectContext) {
    sections.push({
      priority: 1,
      label: "项目上下文",
      content: memory.projectContext.slice(0, 500),
    });
  }

  // 2. High-confidence facts
  const highFacts = memory.discoveredFacts.filter((f) => f.confidence === "high");
  if (highFacts.length > 0) {
    sections.push({
      priority: 2,
      label: "已确认事实",
      content: highFacts.map((f) => `- [${f.category}] ${f.content}`).join("\n"),
    });
  }

  // 3. File knowledge (sorted by relevance to role)
  const fileEntries = [...memory.fileKnowledge.values()];
  if (fileEntries.length > 0) {
    const sorted = sortFilesByRole(fileEntries, forRole);
    const fileLines = sorted.slice(0, 15).map((fk) => {
      const lang = fk.language ? ` (${fk.language})` : "";
      return `- ${fk.relativePath}${lang}: ${fk.summary} [${fk.totalLines} lines, read by ${fk.readByAgent}]`;
    });
    sections.push({
      priority: 3,
      label: "已读取文件",
      content: fileLines.join("\n"),
    });
  }

  // 4. Sub-agent execution history
  if (memory.subAgentHistory.length > 0) {
    const historyLines = memory.subAgentHistory.map((h) => {
      const findings = h.keyFindings.length > 0 ? ` | findings: ${h.keyFindings.join(", ")}` : "";
      return `- [${h.role}] ${h.taskDescription.slice(0, 80)}${findings} → ${h.proposedActionCount} actions`;
    });
    sections.push({
      priority: 4,
      label: "Sub-Agent 执行历史",
      content: historyLines.join("\n"),
    });
  }

  // 5. Medium/low confidence facts (lowest priority)
  const otherFacts = memory.discoveredFacts.filter((f) => f.confidence !== "high");
  if (otherFacts.length > 0) {
    sections.push({
      priority: 5,
      label: "其他发现",
      content: otherFacts.map((f) => `- [${f.category}/${f.confidence}] ${f.content}`).join("\n"),
    });
  }

  // Build output, respecting token budget (truncate from lowest priority)
  sections.sort((a, b) => a.priority - b.priority);

  const parts: string[] = [];
  let usedTokens = 0;

  for (const section of sections) {
    const sectionText = `### ${section.label}\n${section.content}`;
    const sectionTokens = estimateTokensFromText(sectionText);

    if (usedTokens + sectionTokens > tokenBudget) {
      // Try to fit a truncated version
      const remainingBudget = tokenBudget - usedTokens;
      if (remainingBudget > 20) {
        const truncatedContent = truncateToTokenBudget(section.content, remainingBudget - 10);
        if (truncatedContent) {
          parts.push(`### ${section.label}\n${truncatedContent}`);
        }
      }
      break;
    }

    parts.push(sectionText);
    usedTokens += sectionTokens;
  }

  return parts.join("\n\n");
}

function sortFilesByRole(files: FileKnowledge[], role?: SubAgentRole): FileKnowledge[] {
  if (!role) return files;

  return [...files].sort((a, b) => {
    // Coder: prioritize files read by main or planner (already analyzed)
    if (role === "coder") {
      const aScore = a.readByAgent === "main" || a.readByAgent === "planner" ? 0 : 1;
      const bScore = b.readByAgent === "main" || b.readByAgent === "planner" ? 0 : 1;
      return aScore - bScore;
    }
    // Tester: prioritize recently read files
    if (role === "tester") {
      return b.lastReadAt.localeCompare(a.lastReadAt);
    }
    return 0;
  });
}

function truncateToTokenBudget(text: string, budget: number): string | null {
  const lines = text.split("\n");
  const result: string[] = [];
  let tokens = 0;

  for (const line of lines) {
    const lineTokens = estimateTokensFromText(line);
    if (tokens + lineTokens > budget) break;
    result.push(line);
    tokens += lineTokens;
  }

  return result.length > 0 ? result.join("\n") : null;
}

// ---------------------------------------------------------------------------
// Snapshot / restore for checkpoint persistence
// ---------------------------------------------------------------------------

export function snapshotWorkingMemory(memory: WorkingMemory): WorkingMemorySnapshot {
  return {
    fileKnowledge: [...memory.fileKnowledge.entries()],
    discoveredFacts: [...memory.discoveredFacts],
    subAgentHistory: [...memory.subAgentHistory],
    projectContext: memory.projectContext,
    maxTokenBudget: memory.maxTokenBudget,
  };
}

export function restoreWorkingMemory(snapshot: WorkingMemorySnapshot): WorkingMemory {
  return {
    fileKnowledge: new Map(snapshot.fileKnowledge),
    discoveredFacts: snapshot.discoveredFacts ?? [],
    subAgentHistory: snapshot.subAgentHistory ?? [],
    projectContext: snapshot.projectContext ?? "",
    maxTokenBudget: snapshot.maxTokenBudget ?? 4000,
  };
}

/**
 * Validate and normalize a snapshot loaded from persistence.
 * Returns null if the snapshot is invalid.
 */
export function normalizeWorkingMemorySnapshot(
  value: unknown,
): WorkingMemorySnapshot | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;

  if (!Array.isArray(obj.fileKnowledge)) return null;
  if (!Array.isArray(obj.discoveredFacts)) return null;
  if (!Array.isArray(obj.subAgentHistory)) return null;

  return {
    fileKnowledge: obj.fileKnowledge as Array<[string, FileKnowledge]>,
    discoveredFacts: obj.discoveredFacts as DiscoveredFact[],
    subAgentHistory: obj.subAgentHistory as SubAgentExecRecord[],
    projectContext: typeof obj.projectContext === "string" ? obj.projectContext : "",
    maxTokenBudget: typeof obj.maxTokenBudget === "number" ? obj.maxTokenBudget : 4000,
  };
}
