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

export interface OverviewBudgetConfig {
  maxDirectories?: number;
  maxFiles?: number;
  maxRootPreview?: number;
  maxChars?: number;
}

export interface RepoMapConfig {
  enabled?: boolean;
  maxFiles?: number;
  tokenBudget?: number;
}

export interface ContextRuleConfig {
  id?: string;
  paths?: string[];
  instructions?: string;
  contextFiles?: string[];
}

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
  /** Budget controls for initial workspace overview injection */
  overviewBudget?: OverviewBudgetConfig;
  /** Repo-map configuration for project structure awareness */
  repoMap?: RepoMapConfig;
  /** Path-scoped or global context rules for lazy project guidance */
  contextRules?: ContextRuleConfig[];
}

const COFREERC_FILENAMES = [".cofreerc", ".cofreerc.json"];

const configCache = new Map<
  string,
  { config: CofreeRcConfig; loadedAt: number }
>();
const CACHE_TTL_MS = 30_000; // 30 seconds

/**
 * Load and parse .cofreerc from the workspace root.
 * Returns an empty config if the file doesn't exist or is invalid.
 * Results are cached for 30s to avoid repeated disk reads.
 */
export async function loadCofreeRc(
  workspacePath: string
): Promise<CofreeRcConfig> {
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
        endLine: null,
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
export function parseCofreeRc(raw: string): CofreeRcConfig {
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

  const clampInt = (
    value: unknown,
    min: number,
    max: number
  ): number | undefined => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return undefined;
    }
    const n = Math.floor(value);
    if (n < min) return min;
    if (n > max) return max;
    return n;
  };

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
  if (
    obj.toolPermissions &&
    typeof obj.toolPermissions === "object" &&
    !Array.isArray(obj.toolPermissions)
  ) {
    const perms: Record<string, "ask" | "auto"> = {};
    for (const [key, value] of Object.entries(
      obj.toolPermissions as Record<string, unknown>
    )) {
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

  // overviewBudget
  if (
    obj.overviewBudget &&
    typeof obj.overviewBudget === "object" &&
    !Array.isArray(obj.overviewBudget)
  ) {
    const budgetObj = obj.overviewBudget as Record<string, unknown>;
    const budget: OverviewBudgetConfig = {};

    // Hard upper bounds to prevent pathological configs.
    const maxDirectories = clampInt(budgetObj.maxDirectories, 1, 2000);
    const maxFiles = clampInt(budgetObj.maxFiles, 1, 20000);
    const maxRootPreview = clampInt(budgetObj.maxRootPreview, 1, 200);
    const maxChars = clampInt(budgetObj.maxChars, 200, 200000);

    if (typeof maxDirectories === "number")
      budget.maxDirectories = maxDirectories;
    if (typeof maxFiles === "number") budget.maxFiles = maxFiles;
    if (typeof maxRootPreview === "number")
      budget.maxRootPreview = maxRootPreview;
    if (typeof maxChars === "number") budget.maxChars = maxChars;

    if (Object.keys(budget).length > 0) {
      config.overviewBudget = budget;
    }
  }

  // repoMap
  if (
    obj.repoMap &&
    typeof obj.repoMap === "object" &&
    !Array.isArray(obj.repoMap)
  ) {
    const repoObj = obj.repoMap as Record<string, unknown>;
    const repoMap: RepoMapConfig = {};

    if (typeof repoObj.enabled === "boolean") {
      repoMap.enabled = repoObj.enabled;
    }
    const maxFiles = clampInt(repoObj.maxFiles, 1, 500);
    if (typeof maxFiles === "number") repoMap.maxFiles = maxFiles;
    const tokenBudget = clampInt(repoObj.tokenBudget, 100, 8000);
    if (typeof tokenBudget === "number") repoMap.tokenBudget = tokenBudget;

    if (Object.keys(repoMap).length > 0) {
      config.repoMap = repoMap;
    }
  }

  // contextRules
  if (Array.isArray(obj.contextRules)) {
    const rules: ContextRuleConfig[] = [];
    for (const [index, entry] of obj.contextRules.entries()) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const rule: ContextRuleConfig = {};

      if (typeof record.id === "string" && record.id.trim()) {
        rule.id = record.id.trim().slice(0, 80);
      } else {
        rule.id = `rule-${index + 1}`;
      }

      if (typeof record.instructions === "string" && record.instructions.trim()) {
        rule.instructions = record.instructions.trim().slice(0, 4000);
      }

      if (Array.isArray(record.paths)) {
        const paths = record.paths
          .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          .map((item) => item.trim().replace(/\\/g, "/").replace(/^\/+/, "").slice(0, 200))
          .slice(0, 12);
        if (paths.length > 0) {
          rule.paths = paths;
        }
      }

      if (Array.isArray(record.contextFiles)) {
        const contextFiles = record.contextFiles
          .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          .map((item) => item.trim().replace(/\\/g, "/").replace(/^\/+/, "").slice(0, 300))
          .slice(0, 12);
        if (contextFiles.length > 0) {
          rule.contextFiles = contextFiles;
        }
      }

      if (rule.instructions || rule.contextFiles?.length || rule.paths?.length) {
        rules.push(rule);
      }
      if (rules.length >= 20) {
        break;
      }
    }
    if (rules.length > 0) {
      config.contextRules = rules;
    }
  }

  return config;
}

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "").toLowerCase();
}

function globPatternToRegExp(pattern: string): RegExp {
  const normalized = normalizePath(pattern);
  let regex = "^";

  for (let index = 0; index < normalized.length; ) {
    const char = normalized[index];
    const next = normalized[index + 1];
    const nextNext = normalized[index + 2];

    if (char === "*" && next === "*" && nextNext === "/") {
      regex += "(?:.*/)?";
      index += 3;
      continue;
    }
    if (char === "*" && next === "*") {
      regex += ".*";
      index += 2;
      continue;
    }
    if (char === "*") {
      regex += "[^/]*";
      index += 1;
      continue;
    }
    if (/[.+^${}()|[\]\\]/.test(char)) {
      regex += `\\${char}`;
    } else {
      regex += char;
    }
    index += 1;
  }

  regex += "$";
  return new RegExp(regex, "i");
}

function patternMatchesPath(pattern: string, candidatePath: string): boolean {
  const normalizedPattern = normalizePath(pattern);
  const normalizedCandidate = normalizePath(candidatePath);
  if (!normalizedPattern || !normalizedCandidate) {
    return false;
  }

  if (!normalizedPattern.includes("*")) {
    return normalizedCandidate === normalizedPattern
      || normalizedCandidate.startsWith(`${normalizedPattern}/`)
      || normalizedPattern.startsWith(`${normalizedCandidate}/`);
  }

  return globPatternToRegExp(normalizedPattern).test(normalizedCandidate);
}

function isPathScopedRule(rule: ContextRuleConfig): boolean {
  return !!rule.paths && rule.paths.length > 0;
}

export function resolveMatchingContextRules(
  config: CofreeRcConfig,
  targetPaths: string[],
): ContextRuleConfig[] {
  const normalizedTargets = targetPaths.map(normalizePath).filter(Boolean);
  if (normalizedTargets.length === 0 || !config.contextRules?.length) {
    return [];
  }

  const matched: ContextRuleConfig[] = [];
  for (const rule of config.contextRules) {
    if (!isPathScopedRule(rule)) {
      continue;
    }
    if (rule.paths!.some((pattern) => normalizedTargets.some((path) => patternMatchesPath(pattern, path)))) {
      matched.push(rule);
    }
  }

  return matched;
}

/**
 * Build a system prompt fragment from .cofreerc config.
 * Returns empty string if no relevant config is present.
 */
export function buildCofreeRcPromptFragment(config: CofreeRcConfig): string {
  const parts: string[] = [];

  if (config.ignorePatterns && config.ignorePatterns.length > 0) {
    parts.push(
      `[项目配置] 以下文件/目录模式应被忽略，不要读取或修改：${config.ignorePatterns.join(
        ", "
      )}`
    );
  }

  if (config.language) {
    parts.push(`[项目配置] 用户偏好的回复语言：${config.language}`);
  }

  if (config.systemPrompt) {
    parts.push(`[项目自定义指令]\n${config.systemPrompt}`);
  }

  const globalRules = (config.contextRules ?? []).filter(
    (rule) => !isPathScopedRule(rule) && rule.instructions,
  );
  if (globalRules.length > 0) {
    parts.push(
      [
        "[项目规则]",
        ...globalRules.map((rule) =>
          rule.id
            ? `- ${rule.id}: ${rule.instructions}`
            : `- ${rule.instructions}`,
        ),
      ].join("\n"),
    );
  }

  return parts.join("\n\n");
}
