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

function formatRepoMap(
  result: WorkspaceStructureResult,
  tokenBudget: number,
): string {
  // Group files by directory
  const dirMap = new Map<string, FileStructure[]>();

  for (const file of result.files) {
    const lastSlash = file.path.lastIndexOf("/");
    const dir = lastSlash > 0 ? file.path.slice(0, lastSlash) : ".";
    const existing = dirMap.get(dir);
    if (existing) {
      existing.push(file);
    } else {
      dirMap.set(dir, [file]);
    }
  }

  // Sort directories alphabetically
  const sortedDirs = [...dirMap.keys()].sort();

  // Build compact text: each file gets one line with symbol names
  const lines: string[] = ["[Repo Map]"];
  if (result.truncated) {
    lines.push(`(scanned ${result.scanned_count}/${result.total_files} files, truncated)`);
  }
  lines.push("");

  for (const dir of sortedDirs) {
    const files = dirMap.get(dir)!;
    lines.push(`📁 ${dir}/`);

    // Sort files within dir by symbol count (more symbols = more important)
    files.sort((a, b) => b.symbols.length - a.symbols.length);

    for (const file of files) {
      const fileName = file.path.slice(file.path.lastIndexOf("/") + 1);
      const symbolNames = file.symbols.map((s) => s.name).join(", ");
      lines.push(`  ${fileName}: ${symbolNames}`);
    }
  }

  let text = lines.join("\n");

  // Trim from files with fewest symbols if over budget
  const currentTokens = estimateTokensFromText(text);
  if (currentTokens <= tokenBudget) {
    return text;
  }

  // Over budget: rebuild with fewer files, starting by removing files with fewest symbols
  const allFiles = [...result.files].sort(
    (a, b) => a.symbols.length - b.symbols.length,
  );

  while (allFiles.length > 0) {
    allFiles.shift(); // Remove file with fewest symbols

    const trimmedResult: WorkspaceStructureResult = {
      ...result,
      files: allFiles,
    };
    text = formatRepoMapCore(trimmedResult);
    if (estimateTokensFromText(text) <= tokenBudget) {
      return text;
    }
  }

  return "";
}

function formatRepoMapCore(result: WorkspaceStructureResult): string {
  const dirMap = new Map<string, FileStructure[]>();

  for (const file of result.files) {
    const lastSlash = file.path.lastIndexOf("/");
    const dir = lastSlash > 0 ? file.path.slice(0, lastSlash) : ".";
    const existing = dirMap.get(dir);
    if (existing) {
      existing.push(file);
    } else {
      dirMap.set(dir, [file]);
    }
  }

  const sortedDirs = [...dirMap.keys()].sort();
  const lines: string[] = ["[Repo Map]"];
  if (result.truncated) {
    lines.push(`(scanned ${result.scanned_count}/${result.total_files} files, truncated)`);
  }
  lines.push("");

  for (const dir of sortedDirs) {
    const files = dirMap.get(dir)!;
    lines.push(`📁 ${dir}/`);
    files.sort((a, b) => b.symbols.length - a.symbols.length);
    for (const file of files) {
      const fileName = file.path.slice(file.path.lastIndexOf("/") + 1);
      const symbolNames = file.symbols.map((s) => s.name).join(", ");
      lines.push(`  ${fileName}: ${symbolNames}`);
    }
  }

  return lines.join("\n");
}
