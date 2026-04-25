/**
 * Cofree - AI Programming Cafe
 * File: src/orchestrator/workingMemory.ts
 * Description: Shared Working Memory for session context persistence.
 *
 * Maintains file knowledge and discovered facts across the main loop
 * within a single session.
 */

import { estimateTokensFromText } from "./contextBudget";
import {
  CHECKPOINT_WM_MAX_FACT_CONTENT_CHARS,
  CHECKPOINT_WM_MAX_FACT_SOURCE_CHARS,
  CHECKPOINT_WM_MAX_FILE_CONTENT_CHARS,
  CHECKPOINT_WM_MAX_FILE_SUMMARY_CHARS,
  CHECKPOINT_WM_MAX_PROJECT_CONTEXT_CHARS,
  FILE_SLOT_MAX_CONTENT_CHARS,
  MAX_DISCOVERED_FACTS,
  MAX_FILE_SUMMARY_CHARS,
  MAX_RETRIEVED_FACTS,
  MAX_RETRIEVED_FILES,
} from "./contextPolicy";

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
  /**
   * M3: cached full file content (or a head slice if huge). When present, the
   * de-duplication pass (`dedupeStaleFileReads`) replaces older read_file tool
   * results in the message stream with stubs pointing here. `contentVersion`
   * bumps each time the cached content actually changes; an `apply_patch`
   * success drops both fields back to undefined to force a re-read.
   */
  content?: string;
  contentVersion?: number;
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
  role: string;
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
  projectContext: string;
  maxTokenBudget: number;
}

// ---------------------------------------------------------------------------
// Serialization for checkpoint persistence
// ---------------------------------------------------------------------------

export interface WorkingMemorySnapshot {
  fileKnowledge: Array<[string, FileKnowledge]>;
  discoveredFacts: DiscoveredFact[];
  subAgentHistory?: SubAgentExecRecord[];
  taskProgress?: TaskProgressEntry[];
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

function evictDiscoveredFactsToCap(memory: WorkingMemory): void {
  while (memory.discoveredFacts.length > MAX_DISCOVERED_FACTS) {
    const lowIdx = memory.discoveredFacts.findIndex((f) => f.confidence === "low");
    if (lowIdx >= 0) {
      memory.discoveredFacts.splice(lowIdx, 1);
      continue;
    }

    const medIdx = memory.discoveredFacts.findIndex((f) => f.confidence === "medium");
    if (medIdx >= 0) {
      memory.discoveredFacts.splice(medIdx, 1);
      continue;
    }

    memory.discoveredFacts.shift();
  }
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
  evictDiscoveredFactsToCap(memory);
}

function cloneFileKnowledge(value: FileKnowledge): FileKnowledge {
  return { ...value };
}

/**
 * M3: replace-or-create cached full content for `path`. Bumps `contentVersion`
 * only when content actually changes (byte-identical re-reads stay version-stable
 * so prompt-cache hits survive). Truncates oversized files at the head with a
 * marker so the cache stays bounded.
 */
export function setFileContent(
  memory: WorkingMemory,
  path: string,
  content: string,
  metadata: {
    totalLines?: number;
    language?: string;
    turnNumber?: number;
    agentId?: string;
    summary?: string;
  } = {},
): void {
  if (!path) return;

  const trimmed =
    content.length > FILE_SLOT_MAX_CONTENT_CHARS
      ? `${content.slice(0, FILE_SLOT_MAX_CONTENT_CHARS)}\n[文件超出 slot 缓存上限 ${FILE_SLOT_MAX_CONTENT_CHARS} 字符，已截断头部]`
      : content;

  const existing = memory.fileKnowledge.get(path);
  const sameContent = existing?.content === trimmed;
  const nextVersion = sameContent
    ? existing!.contentVersion ?? 1
    : (existing?.contentVersion ?? 0) + 1;

  memory.fileKnowledge.set(path, {
    relativePath: path,
    summary: metadata.summary ?? existing?.summary ?? "",
    totalLines: metadata.totalLines ?? existing?.totalLines ?? 0,
    language: metadata.language ?? existing?.language,
    lastReadAt: new Date().toISOString(),
    lastReadTurn: metadata.turnNumber ?? existing?.lastReadTurn ?? 0,
    readByAgent: metadata.agentId ?? existing?.readByAgent ?? "",
    content: trimmed,
    contentVersion: nextVersion,
  });
}

/**
 * M3: drop cached content for `path` (e.g. after a successful apply_patch).
 * Keeps the file's metadata so the LLM still knows we've seen it; only the
 * content body and version are cleared, forcing a re-read.
 */
export function invalidateFileContent(memory: WorkingMemory, path: string): void {
  const existing = memory.fileKnowledge.get(path);
  if (!existing) return;
  memory.fileKnowledge.set(path, {
    ...existing,
    content: undefined,
    contentVersion: undefined,
  });
}

function cloneDiscoveredFact(value: DiscoveredFact): DiscoveredFact {
  return { ...value };
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

function buildFactSection(params: {
  facts: DiscoveredFact[];
  label: string;
  priority: number;
  bonusFor: (f: DiscoveredFact) => number;
  formatLine: (f: DiscoveredFact) => string;
  queryTerms: string[];
  focusedPaths: string[];
}): { priority: number; label: string; content: string } | null {
  if (params.facts.length === 0) return null;
  const ranked = rankByRelevance({
    items: params.facts,
    getTimestamp: (f) => f.createdAt,
    getFocusPath: (f) => f.source,
    getBonusScore: params.bonusFor,
    queryTerms: params.queryTerms,
    focusedPaths: params.focusedPaths,
  });
  return {
    priority: params.priority,
    label: params.label,
    content: ranked.slice(0, MAX_RETRIEVED_FACTS).map(params.formatLine).join("\n"),
  };
}

export function serializeWorkingMemory(
  memory: WorkingMemory,
  tokenBudget: number,
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
  const highSection = buildFactSection({
    facts: memory.discoveredFacts.filter((f) => f.confidence === "high"),
    label: "已确认事实",
    priority: 2,
    bonusFor: () => 4,
    formatLine: (f) => `- [${f.category}] ${f.content}`,
    queryTerms,
    focusedPaths,
  });
  if (highSection) sections.push(highSection);

  // 3. File knowledge (sorted by recency). M3: surface cached-content marker
  // so the LLM knows it can reference the slot instead of re-reading.
  const fileEntries = [...memory.fileKnowledge.values()];
  if (fileEntries.length > 0) {
    const sorted = rankByRelevance({
      items: fileEntries,
      getTimestamp: (f) => f.lastReadAt,
      getFocusPath: (f) => f.relativePath,
      getSearchCorpus: (f) => `${f.relativePath} ${f.summary} ${f.language ?? ""}`,
      getBonusScore: (f) => Math.min(f.lastReadTurn ?? 0, 10),
      queryTerms,
      focusedPaths,
    });
    const fileLines = sorted.slice(0, MAX_RETRIEVED_FILES).map((fk) => {
      const lang = fk.language ? ` (${fk.language})` : "";
      const turnInfo = fk.lastReadTurn > 0 ? `, turn ${fk.lastReadTurn}` : "";
      const cacheMarker = fk.content
        ? ` [✓ 内容已缓存 v${fk.contentVersion ?? 1}，无需重读]`
        : "";
      return `- ${fk.relativePath}${lang}: ${fk.summary} [${fk.totalLines} lines${turnInfo}]${cacheMarker}`;
    });
    sections.push({
      priority: 3,
      label: "已读取文件",
      content: fileLines.join("\n"),
    });
  }

  // 4. Medium/low confidence facts (lowest priority)
  const otherSection = buildFactSection({
    facts: memory.discoveredFacts.filter((f) => f.confidence !== "high"),
    label: "其他发现",
    priority: 4,
    bonusFor: (f) => (f.confidence === "medium" ? 2 : 0),
    formatLine: (f) => `- [${f.category}/${f.confidence}] ${f.content}`,
    queryTerms,
    focusedPaths,
  });
  if (otherSection) sections.push(otherSection);

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
    fileKnowledge: [...memory.fileKnowledge.entries()].map(([path, knowledge]) => [
      path,
      cloneFileKnowledge(knowledge),
    ]),
    discoveredFacts: memory.discoveredFacts.map(cloneDiscoveredFact),
    projectContext: memory.projectContext,
    maxTokenBudget: memory.maxTokenBudget,
  };
}

export function restoreWorkingMemory(snapshot: WorkingMemorySnapshot): WorkingMemory {
  return {
    fileKnowledge: new Map(
      snapshot.fileKnowledge.map(([path, knowledge]) => [path, cloneFileKnowledge(knowledge)]),
    ),
    discoveredFacts: (snapshot.discoveredFacts ?? []).map(cloneDiscoveredFact),
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

  return {
    fileKnowledge: obj.fileKnowledge as Array<[string, FileKnowledge]>,
    discoveredFacts: obj.discoveredFacts as DiscoveredFact[],
    subAgentHistory: Array.isArray(obj.subAgentHistory) ? (obj.subAgentHistory as SubAgentExecRecord[]) : [],
    taskProgress: Array.isArray(obj.taskProgress) ? (obj.taskProgress as TaskProgressEntry[]) : [],
    projectContext: typeof obj.projectContext === "string" ? obj.projectContext : "",
    maxTokenBudget: typeof obj.maxTokenBudget === "number" ? obj.maxTokenBudget : 4000,
  };
}

// --- Checkpoint persistence: truncate + size cap (P3-1) ---

/** Target max JSON size for persisted working memory (soft cap; evict entries if exceeded). */
export const CHECKPOINT_WORKING_MEMORY_MAX_JSON_BYTES = 512 * 1024;

function truncateCheckpointText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}…`;
}

/**
 * Reduces sensitive / oversized fields before writing `workingMemory` to SQLite.
 * Also applies {@link capWorkingMemorySnapshotJsonSize} so payloads stay bounded.
 */
export function sanitizeWorkingMemoryForCheckpoint(
  snapshot: WorkingMemorySnapshot,
): WorkingMemorySnapshot {
  const fileKnowledge: Array<[string, FileKnowledge]> = snapshot.fileKnowledge.map(
    ([path, fk]) => {
      const next: FileKnowledge = {
        ...fk,
        summary: truncateCheckpointText(fk.summary, CHECKPOINT_WM_MAX_FILE_SUMMARY_CHARS),
        relativePath: truncateCheckpointText(fk.relativePath, 1024),
        content: fk.content
          ? truncateCheckpointText(fk.content, CHECKPOINT_WM_MAX_FILE_CONTENT_CHARS)
          : undefined,
      };
      return [path, next];
    },
  );

  const discoveredFacts = snapshot.discoveredFacts.map((f) => ({
    ...f,
    content: truncateCheckpointText(f.content, CHECKPOINT_WM_MAX_FACT_CONTENT_CHARS),
    source: truncateCheckpointText(f.source, CHECKPOINT_WM_MAX_FACT_SOURCE_CHARS),
  }));

  let out: WorkingMemorySnapshot = {
    fileKnowledge,
    discoveredFacts,
    projectContext: truncateCheckpointText(
      snapshot.projectContext,
      CHECKPOINT_WM_MAX_PROJECT_CONTEXT_CHARS,
    ),
    maxTokenBudget: snapshot.maxTokenBudget,
  };

  out = capWorkingMemorySnapshotJsonSize(out, CHECKPOINT_WORKING_MEMORY_MAX_JSON_BYTES);
  return out;
}

/**
 * If JSON serialization still exceeds `maxBytes`, drop lowest-priority chunks iteratively.
 */
export function capWorkingMemorySnapshotJsonSize(
  snapshot: WorkingMemorySnapshot,
  maxBytes: number,
): WorkingMemorySnapshot {
  let s: WorkingMemorySnapshot = {
    fileKnowledge: [...snapshot.fileKnowledge],
    discoveredFacts: [...snapshot.discoveredFacts],
    projectContext: snapshot.projectContext,
    maxTokenBudget: snapshot.maxTokenBudget,
  };

  let guard = 0;
  while (JSON.stringify(s).length > maxBytes && guard < 512) {
    guard += 1;
    // Drop cached file content (heaviest payload) before discarding the
    // metadata-only entries — content can be re-fetched, metadata cannot.
    const idxWithContent = s.fileKnowledge.findIndex(([, fk]) => fk.content);
    if (idxWithContent >= 0) {
      const next = [...s.fileKnowledge];
      next[idxWithContent] = [
        next[idxWithContent][0],
        { ...next[idxWithContent][1], content: undefined, contentVersion: undefined },
      ];
      s = { ...s, fileKnowledge: next };
      continue;
    }
    if (s.fileKnowledge.length > 0) {
      s = { ...s, fileKnowledge: s.fileKnowledge.slice(1) };
      continue;
    }
    if (s.discoveredFacts.length > 0) {
      s = { ...s, discoveredFacts: s.discoveredFacts.slice(1) };
      continue;
    }
    const half = Math.max(0, Math.floor(s.projectContext.length / 2));
    s = {
      ...s,
      projectContext: truncateCheckpointText(s.projectContext, half || 1),
    };
    if (s.projectContext.length <= 1) {
      break;
    }
  }

  return s;
}