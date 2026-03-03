/**
 * Cofree - AI Programming Cafe
 * File: src/lib/cofreerc.ts
 * Milestone: 5
 * Task: 5.5
 * Description: Project-level .cofreerc configuration loader.
 *
 * Supports a `.cofreerc` (JSON) file in the workspace root.
 * Fields:
 *   - systemPrompt: string — additional instructions appended to the system prompt
 *   - ignorePatterns: string[] — glob patterns for files the LLM should ignore
 *   - toolPermissions: Record<string, "ask" | "auto"> — default tool permission overrides
 *   - contextFiles: string[] — files to always include in context at session start
 *   - language: string — preferred response language (e.g. "zh-CN", "en")
 */

import { invoke } from "@tauri-apps/api/core";

export interface CofreeRcConfig {
  /** Additional system prompt instructions appended to the base prompt */
  systemPrompt?: string;
  /** Glob patterns for files/directories the LLM should skip */
  ignorePatterns?: string[];
  /** Per-tool permission overrides: "ask" (require approval) or "auto" (auto-execute) */
  toolPermissions?: Record<string, "ask" | "auto">;
  /** Files to always load into context at session start */
  contextFiles?: string[];
  /** Preferred response language hint */
  language?: string;
}

const COFREERC_FILENAMES = [".cofreerc", ".cofreerc.json"];

const configCache = new Map<string, { config: CofreeRcConfig; loadedAt: number }>();
const CACHE_TTL_MS = 30_000; // 30 seconds

/**
 * Load and parse .cofreerc from the workspace root.
 * Returns an empty config if the file doesn't exist or is invalid.
 * Results are cached for 30s to avoid repeated disk reads.
 */
export async function loadCofreeRc(workspacePath: string): Promise<CofreeRcConfig> {
  const normalizedPath = workspacePath.trim();
  if (!normalizedPath) {
    return {};
  }

  // Check cache
  const cached = configCache.get(normalizedPath);
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
    return cached.config;
  }

  for (const filename of COFREERC_FILENAMES) {
    try {
      const result = await invoke<{
        content: string;
        total_lines: number;
        start_line: number;
        end_line: number;
      }>("read_workspace_file", {
        workspacePath: normalizedPath,
        relativePath: filename,
        startLine: null,
        endLine: null
      });

      if (result.content && result.content.trim()) {
        const config = parseCofreeRc(result.content);
        configCache.set(normalizedPath, { config, loadedAt: Date.now() });
        return config;
      }
    } catch {
      // File doesn't exist or can't be read — try next filename
      continue;
    }
  }

  // No config file found — cache empty result
  const empty: CofreeRcConfig = {};
  configCache.set(normalizedPath, { config: empty, loadedAt: Date.now() });
  return empty;
}

/**
 * Invalidate the cached config for a workspace, forcing a re-read on next load.
 */
export function invalidateCofreeRcCache(workspacePath: string): void {
  configCache.delete(workspacePath.trim());
}

/**
 * Parse raw JSON content into a validated CofreeRcConfig.
 */
function parseCofreeRc(raw: string): CofreeRcConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Try stripping comments (single-line // comments)
    const stripped = raw.replace(/^\s*\/\/.*$/gm, "").trim();
    try {
      parsed = JSON.parse(stripped);
    } catch {
      console.warn("[cofreerc] Failed to parse .cofreerc as JSON");
      return {};
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }

  const obj = parsed as Record<string, unknown>;
  const config: CofreeRcConfig = {};

  // systemPrompt
  if (typeof obj.systemPrompt === "string" && obj.systemPrompt.trim()) {
    config.systemPrompt = obj.systemPrompt.trim().slice(0, 4000);
  }

  // ignorePatterns
  if (Array.isArray(obj.ignorePatterns)) {
    config.ignorePatterns = obj.ignorePatterns
      .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
      .map((p) => p.trim().slice(0, 200))
      .slice(0, 50);
  }

  // toolPermissions
  if (obj.toolPermissions && typeof obj.toolPermissions === "object" && !Array.isArray(obj.toolPermissions)) {
    const perms: Record<string, "ask" | "auto"> = {};
    for (const [key, value] of Object.entries(obj.toolPermissions as Record<string, unknown>)) {
      if (typeof value === "string" && (value === "ask" || value === "auto")) {
        perms[key.trim()] = value;
      }
    }
    if (Object.keys(perms).length > 0) {
      config.toolPermissions = perms;
    }
  }

  // contextFiles
  if (Array.isArray(obj.contextFiles)) {
    config.contextFiles = obj.contextFiles
      .filter((f): f is string => typeof f === "string" && f.trim().length > 0)
      .map((f) => f.trim().slice(0, 300))
      .slice(0, 20);
  }

  // language
  if (typeof obj.language === "string" && obj.language.trim()) {
    config.language = obj.language.trim().slice(0, 20);
  }

  return config;
}

/**
 * Build a system prompt fragment from .cofreerc config.
 * Returns empty string if no relevant config is present.
 */
export function buildCofreeRcPromptFragment(config: CofreeRcConfig): string {
  const parts: string[] = [];

  if (config.ignorePatterns && config.ignorePatterns.length > 0) {
    parts.push(
      `[项目配置] 以下文件/目录模式应被忽略，不要读取或修改：${config.ignorePatterns.join(", ")}`
    );
  }

  if (config.language) {
    parts.push(`[项目配置] 用户偏好的回复语言：${config.language}`);
  }

  if (config.systemPrompt) {
    parts.push(`[项目自定义指令]\n${config.systemPrompt}`);
  }

  return parts.join("\n\n");
}
