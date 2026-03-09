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

// ---------------------------------------------------------------------------
// Cache: reuse repo-map across turns within same workspace, 10-minute TTL
// ---------------------------------------------------------------------------

const repoMapCache = new SummaryCache({ ttlMs: 10 * 60 * 1000, maxEntries: 20 });

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
): Promise<string> {
  if (!workspacePath.trim() || tokenBudget <= 0) return "";

  const cacheKey = `repomap:${workspacePath}:${tokenBudget}`;
  const cached = repoMapCache.get(cacheKey);
  if (cached !== null) return cached;

  try {
    const result = await invoke<WorkspaceStructureResult>(
      "scan_workspace_structure",
      {
        workspacePath,
        ignorePatterns: ignorePatterns ?? null,
      },
    );

    if (!result.files || result.files.length === 0) {
      repoMapCache.set(cacheKey, "");
      return "";
    }

    const formatted = formatRepoMap(result, tokenBudget);
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
  return `${prefix}:${symbol.name}`;
}

/**
 * Group files by directory for tree-like display.
 */
function groupFilesByDirectory(files: FileStructure[]): Map<string, FileStructure[]> {
  const dirMap = new Map<string, FileStructure[]>();
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
  files: FileStructure[],
  truncated: boolean,
  scannedCount: number,
  totalFiles: number,
): string {
  const dirMap = groupFilesByDirectory(files);
  const sortedDirs = [...dirMap.keys()].sort();

  const lines: string[] = ["[Repo Map]"];
  if (truncated) {
    lines.push(`(scanned ${scannedCount}/${totalFiles} files, truncated)`);
  }
  lines.push("Symbol key: f=function, c=class, i=interface, t=type, v=variable, e=enum, m=method");
  lines.push("");

  for (const dir of sortedDirs) {
    const dirFiles = dirMap.get(dir)!;
    lines.push(`📁 ${dir}/`);

    // Sort files within dir by symbol count (more symbols = more important)
    dirFiles.sort((a, b) => b.symbols.length - a.symbols.length);

    for (const file of dirFiles) {
      const fileName = file.path.slice(file.path.lastIndexOf("/") + 1);
      if (file.symbols.length === 0) {
        lines.push(`  ${fileName}`);
      } else {
        const symbolList = file.symbols.map(formatSymbolCompact).join(", ");
        lines.push(`  ${fileName}: ${symbolList}`);
      }
    }
  }

  return lines.join("\n");
}

function formatRepoMap(
  result: WorkspaceStructureResult,
  tokenBudget: number,
): string {
  let text = buildRepoMapText(
    result.files,
    result.truncated,
    result.scanned_count,
    result.total_files,
  );

  // Check if within budget
  const currentTokens = estimateTokensFromText(text);
  if (currentTokens <= tokenBudget) {
    return text;
  }

  // Over budget: rebuild with fewer files, removing files with fewest symbols first
  const allFiles = [...result.files].sort(
    (a, b) => a.symbols.length - b.symbols.length,
  );

  while (allFiles.length > 0) {
    allFiles.shift(); // Remove file with fewest symbols

    text = buildRepoMapText(
      allFiles,
      result.truncated,
      result.scanned_count,
      result.total_files,
    );
    if (estimateTokensFromText(text) <= tokenBudget) {
      return text;
    }
  }

  return "";
}
