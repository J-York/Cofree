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
  lastReadTurn: number;
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

export interface TaskProgressEntry {
  id: string;
  description: string;
  toolName: string;
  targetFile?: string;
  status: "completed" | "failed" | "pending";
  turnNumber: number;
  timestamp: string;
  errorHint?: string;
}

export interface WorkingMemory {
  fileKnowledge: Map<string, FileKnowledge>;
  discoveredFacts: DiscoveredFact[];
  subAgentHistory: SubAgentExecRecord[];
  taskProgress: TaskProgressEntry[];
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
  taskProgress: TaskProgressEntry[];
  projectContext: string;
  maxTokenBudget: number;
}

export interface WorkingMemoryQueryOptions {
  query?: string;
  focusedPaths?: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_DISCOVERED_FACTS = 50;
const MAX_FILE_SUMMARY_CHARS = 200;
const MAX_SUBAGENT_HISTORY = 20;
const MAX_TASK_PROGRESS_ENTRIES = 40;
const MAX_RETRIEVED_FILES = 12;
const MAX_RETRIEVED_FACTS = 10;
const MAX_RETRIEVED_HISTORY = 8;
const MAX_RETRIEVED_FAILURES = 5;
const QUERY_TERM_LIMIT = 10;
const QUERY_STOPWORDS = new Set([
  "add", "and", "bug", "build", "change", "code", "create", "current",
  "debug", "feature", "file", "files", "fix", "for", "from", "help",
  "implement", "improve", "issue", "make", "project", "refactor", "review",
  "run", "test", "tests", "the", "this", "update", "with", "开始", "实现",
  "修改", "优化", "当前", "代码", "文件", "项目", "问题", "测试", "检查",
  "功能", "需要", "这个", "那个", "一下", "进行", "继续",
]);

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
    taskProgress: [],
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
// Task progress tracking
// ---------------------------------------------------------------------------

let progressIdCounter = 0;

function generateProgressId(): string {
  progressIdCounter += 1;
  return `prog-${Date.now()}-${progressIdCounter}`;
}

export function recordTaskProgress(
  memory: WorkingMemory,
  entry: Omit<TaskProgressEntry, "id" | "timestamp">,
): void {
  memory.taskProgress.push({
    ...entry,
    id: generateProgressId(),
    timestamp: new Date().toISOString(),
  });

  // Evict oldest completed entries when over limit
  while (memory.taskProgress.length > MAX_TASK_PROGRESS_ENTRIES) {
    const completedIdx = memory.taskProgress.findIndex(
      (e) => e.status === "completed",
    );
    if (completedIdx >= 0) {
      memory.taskProgress.splice(completedIdx, 1);
    } else {
      memory.taskProgress.shift();
    }
  }
}

export function formatTaskProgressBlock(memory: WorkingMemory): string {
  if (memory.taskProgress.length === 0) return "";

  const completed = memory.taskProgress.filter((e) => e.status === "completed");
  const failed = memory.taskProgress.filter((e) => e.status === "failed");
  const pending = memory.taskProgress.filter((e) => e.status === "pending");

  const lines: string[] = ["[Task Progress]"];

  if (completed.length > 0) {
    lines.push(`\nCompleted (${completed.length}):`);
    for (const e of completed.slice(-10)) {
      lines.push(`  ✓ [turn ${e.turnNumber}] ${e.toolName}: ${e.description}${e.targetFile ? ` → ${e.targetFile}` : ""}`);
    }
  }

  if (failed.length > 0) {
    lines.push(`\nFailed (${failed.length}):`);
    for (const e of failed.slice(-5)) {
      lines.push(`  ✗ [turn ${e.turnNumber}] ${e.toolName}: ${e.description}${e.errorHint ? ` — ${e.errorHint}` : ""}`);
    }
  }

  if (pending.length > 0) {
    lines.push(`\nPending (${pending.length}):`);
    for (const e of pending.slice(-5)) {
      lines.push(`  ○ ${e.description}`);
    }
  }

  return lines.join("\n");
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

/**
 * Strip line number prefixes (e.g. "1│", "123│") from read_file content_preview.
 */
function stripLineNumbers(content: string): string {
  return content
    .split("\n")
    .map((line) => line.replace(/^\d+│/, ""))
    .join("\n");
}

export function extractFileKnowledge(
  toolName: string,
  toolArgs: Record<string, unknown>,
  toolResult: string,
  agentId: string,
  turnNumber?: number,
): FileKnowledge | null {
  if (toolName === "read_file") {
    const relativePath = String(toolArgs.relative_path ?? toolArgs.path ?? "").trim();
    if (!relativePath) return null;

    // toolResult is a JSON string from executeToolCall.
    // Parse it to extract accurate total_lines and content_preview.
    try {
      const parsed = JSON.parse(toolResult);

      // Skip cached/dedup results — don't overwrite existing knowledge
      if (parsed.status === "cached") return null;

      const totalLines = typeof parsed.total_lines === "number"
        ? parsed.total_lines
        : (toolResult.match(/\n/g) || []).length + 1;

      // Build summary from actual source code, not from the JSON envelope
      const contentForSummary = typeof parsed.content_preview === "string"
        ? stripLineNumbers(parsed.content_preview)
        : toolResult;

      return {
        relativePath,
        summary: buildFileSummaryFromContent(contentForSummary, relativePath),
        totalLines,
        language: inferLanguage(relativePath),
        lastReadAt: new Date().toISOString(),
        lastReadTurn: turnNumber ?? 0,
        readByAgent: agentId,
      };
    } catch {
      // Fallback for non-JSON results
      const totalLines = (toolResult.match(/\n/g) || []).length + 1;
      return {
        relativePath,
        summary: buildFileSummaryFromContent(toolResult, relativePath),
        totalLines,
        language: inferLanguage(relativePath),
        lastReadAt: new Date().toISOString(),
        lastReadTurn: turnNumber ?? 0,
        readByAgent: agentId,
      };
    }
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
        lastReadTurn: turnNumber ?? 0,
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
  queryOptions?: WorkingMemoryQueryOptions,
): string {
  if (tokenBudget <= 0) return "";

  const sections: Array<{ priority: number; label: string; content: string }> = [];
  const queryTerms = extractQueryTerms(queryOptions?.query);
  const focusedPaths = normalizeFocusedPaths(queryOptions?.focusedPaths);

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
    const ranked = rankByRelevance({
      items: highFacts,
      getTimestamp: (f) => f.createdAt,
      getFocusPath: (f) => f.source,
      getBonusScore: (f) => f.confidence === "high" ? 4 : 2,
      queryTerms,
      focusedPaths,
    });
    sections.push({
      priority: 2,
      label: "已确认事实",
      content: ranked
        .slice(0, MAX_RETRIEVED_FACTS)
        .map((f) => `- [${f.category}] ${f.content}`)
        .join("\n"),
    });
  }

  // 3. File knowledge (sorted by recency, with role-based bonus)
  const fileEntries = [...memory.fileKnowledge.values()];
  if (fileEntries.length > 0) {
    const sorted = rankByRelevance({
      items: fileEntries,
      getTimestamp: (f) => f.lastReadAt,
      getFocusPath: (f) => f.relativePath,
      getSearchCorpus: (f) => `${f.relativePath} ${f.summary} ${f.language ?? ""}`,
      getBonusScore: (f) => {
        let bonus = Math.min(f.lastReadTurn ?? 0, 10);
        if (forRole === "coder" && (f.readByAgent === "main" || f.readByAgent === "planner")) bonus += 20;
        if (forRole === "coder" && f.readByAgent === "coder") bonus -= 4;
        if (forRole === "tester" && f.readByAgent !== "tester") bonus += 2;
        return bonus;
      },
      queryTerms,
      focusedPaths,
    });
    const fileLines = sorted.slice(0, MAX_RETRIEVED_FILES).map((fk) => {
      const lang = fk.language ? ` (${fk.language})` : "";
      const turnInfo = fk.lastReadTurn > 0 ? `, turn ${fk.lastReadTurn}` : "";
      return `- ${fk.relativePath}${lang}: ${fk.summary} [${fk.totalLines} lines${turnInfo}]`;
    });
    sections.push({
      priority: 3,
      label: "已读取文件",
      content: fileLines.join("\n"),
    });
  }

  // 3.5. Failed operations context (helps LLM avoid repeating mistakes)
  const recentFailures = memory.taskProgress.filter((e) => e.status === "failed");
  if (recentFailures.length > 0) {
    const ranked = rankByRelevance({
      items: recentFailures,
      getTimestamp: (e) => e.timestamp,
      getFocusPath: (e) => e.targetFile,
      getBonusScore: (e) => e.status === "failed" ? 4 : 0,
      queryTerms,
      focusedPaths,
    });
    const failureLines = ranked.slice(0, MAX_RETRIEVED_FAILURES).map((e) => {
      const target = e.targetFile ? ` on ${e.targetFile}` : "";
      const hint = e.errorHint ? ` — ${e.errorHint}` : "";
      return `- ${e.toolName}${target}: ${e.description}${hint}`;
    });
    sections.push({
      priority: 3,
      label: "最近失败操作（避免重复）",
      content: failureLines.join("\n"),
    });
  }

  // 4. Sub-agent execution history
  if (memory.subAgentHistory.length > 0) {
    const ranked = rankByRelevance({
      items: memory.subAgentHistory,
      getTimestamp: (h) => h.completedAt,
      getSearchCorpus: (h) => `${h.role} ${h.taskDescription} ${h.keyFindings.join(" ")}`,
      queryTerms,
      focusedPaths,
    });
    const historyLines = ranked.slice(0, MAX_RETRIEVED_HISTORY).map((h) => {
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
    const ranked = rankByRelevance({
      items: otherFacts,
      getTimestamp: (f) => f.createdAt,
      getFocusPath: (f) => f.source,
      getBonusScore: (f) => f.confidence === "medium" ? 2 : 0,
      queryTerms,
      focusedPaths,
    });
    sections.push({
      priority: 5,
      label: "其他发现",
      content: ranked
        .slice(0, MAX_RETRIEVED_FACTS)
        .map((f) => `- [${f.category}/${f.confidence}] ${f.content}`)
        .join("\n"),
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

export function collectRelevantFilePaths(
  memory: WorkingMemory,
  query: string,
  limit = 8,
  forRole?: SubAgentRole,
): string[] {
  if (limit <= 0 || memory.fileKnowledge.size === 0) {
    return [];
  }

  const queryTerms = extractQueryTerms(query);
  const ranked = rankByRelevance({
    items: [...memory.fileKnowledge.values()],
    getTimestamp: (f) => f.lastReadAt,
    getFocusPath: (f) => f.relativePath,
    getSearchCorpus: (f) => `${f.relativePath} ${f.summary}`,
    getBonusScore: (f) => {
      let bonus = Math.min(f.lastReadTurn ?? 0, 10);
      if (forRole === "coder" && (f.readByAgent === "main" || f.readByAgent === "planner")) bonus += 20;
      return bonus;
    },
    queryTerms,
    focusedPaths: [],
  });

  return ranked
    .slice(0, limit)
    .map((entry) => entry.relativePath)
    .filter(Boolean);
}

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
}

function normalizeFocusedPaths(paths: string[] | undefined): string[] {
  return (paths ?? []).map(normalizePath).filter(Boolean).slice(0, 20);
}

function extractQueryTerms(query: string | undefined): string[] {
  if (!query) {
    return [];
  }

  const tokens = query.toLowerCase().match(/[a-z][a-z0-9._-]{2,}|[\u4e00-\u9fff]{2,}/g) ?? [];
  const seen = new Set<string>();
  const result: string[] = [];

  for (const token of tokens) {
    if (QUERY_STOPWORDS.has(token) || seen.has(token)) {
      continue;
    }
    seen.add(token);
    result.push(token);
    if (result.length >= QUERY_TERM_LIMIT) {
      break;
    }
  }

  return result;
}

function computeKeywordScore(text: string, queryTerms: string[]): number {
  if (!text || queryTerms.length === 0) {
    return 0;
  }

  const lower = text.toLowerCase();
  let score = 0;
  for (const term of queryTerms) {
    if (lower.includes(term)) {
      score += 5;
    }
  }
  return score;
}

function computeFocusScore(path: string | undefined, focusedPaths: string[]): number {
  if (!path || focusedPaths.length === 0) {
    return 0;
  }

  const normalizedPath = normalizePath(path);
  let score = 0;
  for (const focusPath of focusedPaths) {
    if (normalizedPath === focusPath) {
      score = Math.max(score, 25);
      continue;
    }
    if (normalizedPath.startsWith(`${focusPath}/`) || focusPath.startsWith(`${normalizedPath}/`)) {
      score = Math.max(score, 15);
      continue;
    }
    if (normalizedPath.includes(focusPath) || focusPath.includes(normalizedPath)) {
      score = Math.max(score, 10);
    }
  }
  return score;
}

/**
 * Generic recency-primary ranking. Sorts items by focus score (if any),
 * then by recency timestamp (descending). Keyword matching is kept as a
 * lightweight tiebreaker only — this avoids the O(terms × items × textLen)
 * cost of the previous per-item keyword scan on every serialization call.
 */
function rankByRelevance<T>(params: {
  items: T[];
  getTimestamp: (item: T) => string;
  getSearchCorpus?: (item: T) => string;
  getFocusPath?: (item: T) => string | undefined;
  getBonusScore?: (item: T) => number;
  queryTerms: string[];
  focusedPaths: string[];
}): T[] {
  const { items, getTimestamp, getSearchCorpus, getFocusPath, getBonusScore, queryTerms, focusedPaths } = params;
  return [...items].sort((left, right) => {
    const leftFocus = getFocusPath ? computeFocusScore(getFocusPath(left), focusedPaths) : 0;
    const rightFocus = getFocusPath ? computeFocusScore(getFocusPath(right), focusedPaths) : 0;
    if (leftFocus !== rightFocus) return rightFocus - leftFocus;

    const leftBonus = getBonusScore ? getBonusScore(left) : 0;
    const rightBonus = getBonusScore ? getBonusScore(right) : 0;
    if (leftBonus !== rightBonus) return rightBonus - leftBonus;

    // Recency as primary sort for items with equal focus/bonus
    const timeDiff = getTimestamp(right).localeCompare(getTimestamp(left));
    if (timeDiff !== 0) return timeDiff;

    // Keyword match as final tiebreaker only
    if (queryTerms.length > 0 && getSearchCorpus) {
      const leftKw = computeKeywordScore(getSearchCorpus(left), queryTerms);
      const rightKw = computeKeywordScore(getSearchCorpus(right), queryTerms);
      return rightKw - leftKw;
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
    taskProgress: [...memory.taskProgress],
    projectContext: memory.projectContext,
    maxTokenBudget: memory.maxTokenBudget,
  };
}

export function restoreWorkingMemory(snapshot: WorkingMemorySnapshot): WorkingMemory {
  return {
    fileKnowledge: new Map(snapshot.fileKnowledge),
    discoveredFacts: snapshot.discoveredFacts ?? [],
    subAgentHistory: snapshot.subAgentHistory ?? [],
    taskProgress: snapshot.taskProgress ?? [],
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
    taskProgress: Array.isArray(obj.taskProgress) ? (obj.taskProgress as TaskProgressEntry[]) : [],
    projectContext: typeof obj.projectContext === "string" ? obj.projectContext : "",
    maxTokenBudget: typeof obj.maxTokenBudget === "number" ? obj.maxTokenBudget : 4000,
  };
}
