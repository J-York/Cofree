/**
 * Cofree - AI Programming Cafe
 * File: src/orchestrator/repoMapService.ts
 * Description: Generates a lightweight repo-map (project structure summary)
 * by invoking the Rust backend's scan_workspace_structure command and
 * formatting the results into a compact text block for LLM context injection.
 */

import { invoke } from "@tauri-apps/api/core";
import { estimateTokensFromText } from "./contextBudget";
import { SummaryCache } from "../lib/summaryCache";

export interface RepoMapGenerationOptions {
  taskDescription?: string;
  prioritizedPaths?: string[];
  maxFiles?: number;
}

// ---------------------------------------------------------------------------
// Types matching Rust DTOs
// ---------------------------------------------------------------------------

interface SymbolInfo {
  kind: string;
  name: string;
  line: number;
  signature: string;
}

interface FileStructure {
  path: string;
  language: string;
  symbols: SymbolInfo[];
}

interface WorkspaceStructureResult {
  files: FileStructure[];
  scanned_count: number;
  total_files: number;
  truncated: boolean;
}

interface RankedFileStructure extends FileStructure {
  score: number;
  keywordHits: string[];
  focusMatch: boolean;
}

// ---------------------------------------------------------------------------
// Cache: reuse repo-map across turns within same workspace, 10-minute TTL
// ---------------------------------------------------------------------------

let repoMapCache = new SummaryCache({ ttlMs: 10 * 60 * 1000, maxEntries: 20 });

// Layer-1 cache: raw Rust scan results keyed by workspacePath (expensive I/O)
const scanResultCache = new Map<string, { result: WorkspaceStructureResult; cachedAt: number }>();
const SCAN_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Clear all repo-map caches. Exported for test isolation.
 */
export function clearRepoMapCaches(): void {
  repoMapCache = new SummaryCache({ ttlMs: 10 * 60 * 1000, maxEntries: 20 });
  scanResultCache.clear();
}

const TASK_KEYWORD_LIMIT = 10;
const DEFAULT_MAX_FILES = 80;
const ENTRY_FILE_NAMES = new Set([
  "index",
  "main",
  "app",
  "server",
  "cli",
  "api",
  "router",
  "routes",
  "layout",
  "root",
]);
const CONFIG_FILE_NAMES = new Set([
  "package.json",
  "tsconfig.json",
  "vite.config.ts",
  "vite.config.js",
  "cargo.toml",
  "pyproject.toml",
  "requirements.txt",
  "readme.md",
]);
const LOW_SIGNAL_DIRECTORIES = ["docs/", "test/", "tests/", "fixtures/", "examples/"];
const HIGH_SIGNAL_DIRECTORIES = ["src/", "app/", "lib/", "packages/", "server/", "client/"];
const ENGLISH_STOPWORDS = new Set([
  "add", "build", "change", "check", "code", "create", "current", "debug",
  "feature", "file", "files", "fix", "improve", "issue", "make", "project",
  "refactor", "review", "run", "start", "task", "test", "tests", "update", "work",
]);
const CJK_STOPWORDS = new Set([
  "开始", "实现", "修改", "优化", "当前", "代码", "文件", "项目", "问题",
  "测试", "检查", "功能", "现在", "需要", "一个", "这个", "那个", "对齐",
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a compact repo-map string for the given workspace.
 *
 * @param workspacePath  Absolute path to workspace root
 * @param ignorePatterns Optional patterns to exclude (from .cofreerc)
 * @param tokenBudget   Max tokens to allocate for the repo-map text
 * @returns Formatted repo-map text, or empty string if scan fails / yields nothing
 */
export async function generateRepoMap(
  workspacePath: string,
  ignorePatterns: string[] | null,
  tokenBudget: number,
  options?: RepoMapGenerationOptions,
): Promise<string> {
  if (!workspacePath.trim() || tokenBudget <= 0) return "";

  const normalizedOptions = normalizeRepoMapOptions(options);
  // Layer-2 cache key: formatted output (includes task-specific params)
  const cacheKey = [
    "repomap",
    workspacePath,
    String(tokenBudget),
    String(normalizedOptions.maxFiles ?? "all"),
    normalizedOptions.taskKeywords.join(","),
    normalizedOptions.prioritizedPaths.join(","),
  ].join(":");
  const cached = repoMapCache.get(cacheKey);
  if (cached !== null) return cached;

  try {
    // Layer-1: reuse expensive Rust scan across different queries
    const scanKey = workspacePath;
    const now = Date.now();
    let result: WorkspaceStructureResult;
    const cachedScan = scanResultCache.get(scanKey);
    if (cachedScan && now - cachedScan.cachedAt < SCAN_CACHE_TTL_MS) {
      result = cachedScan.result;
    } else {
      result = await invoke<WorkspaceStructureResult>(
        "scan_workspace_structure",
        {
          workspacePath,
          ignorePatterns: ignorePatterns ?? null,
        },
      );
      scanResultCache.set(scanKey, { result, cachedAt: now });
    }

    if (!result.files || result.files.length === 0) {
      repoMapCache.set(cacheKey, "");
      return "";
    }

    const formatted = formatRepoMap(result, tokenBudget, normalizedOptions);
    repoMapCache.set(cacheKey, formatted);
    return formatted;
  } catch (e) {
    console.warn("[RepoMap] scan_workspace_structure failed:", e);
    return "";
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format a symbol with its kind prefix for compact display.
 * Uses single-char prefixes: f=function, c=class, i=interface, t=type, v=variable, e=enum, m=method
 */
function formatSymbolCompact(symbol: SymbolInfo): string {
  const kindPrefixMap: Record<string, string> = {
    function: "f",
    class: "c",
    interface: "i",
    type: "t",
    variable: "v",
    constant: "v",
    enum: "e",
    method: "m",
    property: "p",
    struct: "c",
    trait: "i",
    impl: "m",
    module: "mod",
  };
  const prefix = kindPrefixMap[symbol.kind.toLowerCase()] ?? symbol.kind.charAt(0).toLowerCase();
  const signature = compactSignature(symbol);
  return `${prefix}:${signature || symbol.name}`;
}

function compactSignature(symbol: SymbolInfo): string {
  const raw = symbol.signature.trim();
  if (!raw) {
    return symbol.name;
  }

  const flattened = raw.replace(/\s+/g, " ").trim();
  const signatureOnly = flattened.includes(symbol.name)
    ? flattened
    : `${symbol.name}${flattened.startsWith("(") ? "" : " "}${flattened}`;

  return signatureOnly.slice(0, 72);
}

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
}

function basename(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

function extractTaskKeywords(text: string | undefined): string[] {
  if (!text) {
    return [];
  }

  const tokens = text.toLowerCase().match(/[a-z][a-z0-9._-]{2,}|[\u4e00-\u9fff]{2,}/g) ?? [];
  const seen = new Set<string>();
  const keywords: string[] = [];

  for (const token of tokens) {
    if (
      ENGLISH_STOPWORDS.has(token) ||
      CJK_STOPWORDS.has(token) ||
      seen.has(token)
    ) {
      continue;
    }
    seen.add(token);
    keywords.push(token);
    if (keywords.length >= TASK_KEYWORD_LIMIT) {
      break;
    }
  }

  return keywords;
}

function normalizeRepoMapOptions(options: RepoMapGenerationOptions | undefined): {
  taskKeywords: string[];
  prioritizedPaths: string[];
  maxFiles?: number;
} {
  const prioritizedPaths = (options?.prioritizedPaths ?? [])
    .map(normalizePath)
    .filter(Boolean)
    .slice(0, 20);
  const maxFiles =
    typeof options?.maxFiles === "number" && Number.isFinite(options.maxFiles)
      ? Math.max(1, Math.floor(options.maxFiles))
      : undefined;

  return {
    taskKeywords: extractTaskKeywords(options?.taskDescription),
    prioritizedPaths,
    maxFiles,
  };
}

function computeDirectoryWeight(path: string): number {
  if (HIGH_SIGNAL_DIRECTORIES.some((dir) => path.includes(dir))) {
    return 4;
  }
  if (LOW_SIGNAL_DIRECTORIES.some((dir) => path.includes(dir))) {
    return -2;
  }
  return 0;
}

function computeFocusWeight(path: string, prioritizedPaths: string[]): number {
  if (prioritizedPaths.length === 0) {
    return 0;
  }

  let weight = 0;
  for (const focusPath of prioritizedPaths) {
    if (path === focusPath) {
      weight = Math.max(weight, 30);
      continue;
    }
    if (path.startsWith(`${focusPath}/`) || focusPath.startsWith(`${path}/`)) {
      weight = Math.max(weight, 18);
      continue;
    }
    if (path.includes(focusPath) || focusPath.includes(path)) {
      weight = Math.max(weight, 12);
    }
  }
  return weight;
}

function computeKeywordHits(file: FileStructure, taskKeywords: string[]): string[] {
  if (taskKeywords.length === 0) {
    return [];
  }

  const searchCorpus = [
    normalizePath(file.path),
    ...file.symbols.flatMap((symbol) => [symbol.name.toLowerCase(), symbol.signature.toLowerCase()]),
  ];

  const hits: string[] = [];
  for (const keyword of taskKeywords) {
    if (searchCorpus.some((entry) => entry.includes(keyword))) {
      hits.push(keyword);
    }
  }
  return hits;
}

function rankFiles(
  files: FileStructure[],
  options: ReturnType<typeof normalizeRepoMapOptions>,
): RankedFileStructure[] {
  const ranked = files.map((file) => {
    const normalizedPath = normalizePath(file.path);
    const fileName = basename(normalizedPath);
    const baseNameWithoutExt = fileName.includes(".")
      ? fileName.slice(0, fileName.indexOf("."))
      : fileName;
    const keywordHits = computeKeywordHits(file, options.taskKeywords);
    const focusWeight = computeFocusWeight(normalizedPath, options.prioritizedPaths);
    const symbolWeight = Math.min(file.symbols.length, 12);
    const entryWeight = ENTRY_FILE_NAMES.has(baseNameWithoutExt) ? 4 : 0;
    const configWeight = CONFIG_FILE_NAMES.has(fileName) ? 6 : 0;
    const keywordWeight = keywordHits.length * 7;
    const score =
      symbolWeight +
      computeDirectoryWeight(normalizedPath) +
      entryWeight +
      configWeight +
      keywordWeight +
      focusWeight;

    return {
      ...file,
      score,
      keywordHits,
      focusMatch: focusWeight >= 18,
    } satisfies RankedFileStructure;
  });

  ranked.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    if (right.symbols.length !== left.symbols.length) {
      return right.symbols.length - left.symbols.length;
    }
    return left.path.localeCompare(right.path);
  });

  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  return ranked.slice(0, Math.max(1, maxFiles));
}

/**
 * Group files by directory for tree-like display.
 */
function groupFilesByDirectory<T extends FileStructure>(files: T[]): Map<string, T[]> {
  const dirMap = new Map<string, T[]>();
  for (const file of files) {
    const lastSlash = file.path.lastIndexOf("/");
    const dir = lastSlash > 0 ? file.path.slice(0, lastSlash) : ".";
    const existing = dirMap.get(dir);
    if (existing) {
      existing.push(file);
    } else {
      dirMap.set(dir, [file]);
    }
  }
  return dirMap;
}

/**
 * Build the repo map text from a list of files.
 * Each file shows its name followed by typed symbol names.
 */
function buildRepoMapText(
  files: RankedFileStructure[],
  truncated: boolean,
  scannedCount: number,
  totalFiles: number,
  options: ReturnType<typeof normalizeRepoMapOptions>,
): string {
  const dirMap = groupFilesByDirectory(files);
  const sortedDirs = [...dirMap.keys()].sort();

  const lines: string[] = ["[Repo Map]"];
  if (truncated) {
    lines.push(`(scanned ${scannedCount}/${totalFiles} files, truncated)`);
  }
  lines.push(`(showing ${files.length}/${totalFiles} prioritized files)`);
  if (options.taskKeywords.length > 0) {
    lines.push(`Task keywords: ${options.taskKeywords.join(", ")}`);
  }
  if (options.prioritizedPaths.length > 0) {
    lines.push(`Focused paths: ${options.prioritizedPaths.join(", ")}`);
  }
  lines.push("Symbol key: f=function, c=class, i=interface, t=type, v=variable, e=enum, m=method");
  lines.push("");

  for (const dir of sortedDirs) {
    const dirFiles = dirMap.get(dir)!;
    lines.push(`📁 ${dir}/`);

    dirFiles.sort((a, b) => b.score - a.score || b.symbols.length - a.symbols.length);

    for (const file of dirFiles) {
      const fileName = file.path.slice(file.path.lastIndexOf("/") + 1);
      if (file.symbols.length === 0) {
        lines.push(`  ${fileName}`);
      } else {
        const symbolList = file.symbols.slice(0, 5).map(formatSymbolCompact).join(", ");
        const hints: string[] = [];
        if (file.focusMatch) {
          hints.push("focus");
        }
        if (file.keywordHits.length > 0) {
          hints.push(`match=${file.keywordHits.join("/")}`);
        }
        const hintSuffix = hints.length > 0 ? ` [${hints.join(", ")}]` : "";
        lines.push(`  ${fileName}: ${symbolList}${hintSuffix}`);
      }
    }
  }

  return lines.join("\n");
}

function formatRepoMap(
  result: WorkspaceStructureResult,
  tokenBudget: number,
  options: ReturnType<typeof normalizeRepoMapOptions>,
): string {
  let rankedFiles = rankFiles(result.files, options);
  let text = buildRepoMapText(
    rankedFiles,
    result.truncated,
    result.scanned_count,
    result.total_files,
    options,
  );

  // Check if within budget
  if (estimateTokensFromText(text) <= tokenBudget) {
    return text;
  }

  // Binary search for the maximum number of files that fits within budget
  let lo = 1;
  let hi = rankedFiles.length - 1;
  let bestText = "";

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = buildRepoMapText(
      rankedFiles.slice(0, mid),
      result.truncated,
      result.scanned_count,
      result.total_files,
      options,
    );
    if (estimateTokensFromText(candidate) <= tokenBudget) {
      bestText = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return bestText;
}
