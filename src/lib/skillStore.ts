/**
 * Cofree - AI Programming Cafe
 * File: src/lib/skillStore.ts
 * Description: Skill system — type definitions, file-system loader, registry,
 *              and context-aware matching engine.
 *
 * A Skill is a reusable, declarative capability extension defined as a Markdown
 * file. Skills are loaded from:
 *   1. Global directory: ~/.cofree/skills/{skill-name}/SKILL.md
 *   2. Workspace directory: {workspace}/.cofree/skills/{skill-name}/SKILL.md
 *   3. Inline definitions in .cofreerc → skills[]
 *
 * Each skill declares a name, description, and either a file path to its
 * Markdown content or inline instructions. The matching engine selects relevant
 * skills based on the user's message and injects their instructions into the
 * system prompt.
 */

import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// Types — unified SkillEntry used for both discovery and persistence
// ---------------------------------------------------------------------------

export type SkillSource = "global" | "workspace" | "cofreerc" | "custom";

/**
 * Unified skill entry used for both discovery results and settings persistence.
 */
export interface SkillEntry {
  /** Unique identifier scoped by source (e.g. "global:odps", "custom:abc123") */
  id: string;
  /** Human-readable display name */
  name: string;
  /** When to activate this skill — used for keyword/intent matching */
  description: string;
  /** Absolute path to the SKILL.md file (for file-based skills) */
  filePath?: string;
  /** Inline instructions (for cofreerc / custom skills without a file) */
  instructions?: string;
  /** Where this skill was loaded from */
  source: SkillSource;
  /** Whether this skill is enabled */
  enabled: boolean;
  /** Optional glob patterns — auto-activate when editing matching files */
  filePatterns?: string[];
  /** Optional keyword triggers for automatic matching */
  keywords?: string[];
  /** When this skill was registered */
  createdAt: string;
}

export interface ResolvedSkill {
  id: string;
  name: string;
  description: string;
  instructions: string;
  source: SkillSource;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SKILL_FILENAME = "SKILL.md";
const GLOBAL_SKILLS_DIR = "skills";
const MAX_SKILL_INSTRUCTIONS_LENGTH = 16_000;
const MAX_SKILLS_PER_REQUEST = 5;

// ---------------------------------------------------------------------------
// In-memory caches
// ---------------------------------------------------------------------------

/** Cache for loaded skill instruction content (per file path). */
const skillContentCache = new Map<string, { content: string; loadedAt: number }>();
const SKILL_CACHE_TTL_MS = 60_000;

/**
 * Session-level cache for discovered skills (issue #4).
 * Avoids re-scanning the file system on every user message.
 * Keyed by discovery source key (e.g. "global" or workspace path).
 */
const skillDiscoveryCache = new Map<
  string,
  { skills: SkillEntry[]; loadedAt: number }
>();
const SKILL_DISCOVERY_CACHE_TTL_MS = 5 * 60_000; // 5 minutes

// ---------------------------------------------------------------------------
// Skill ID generation
// ---------------------------------------------------------------------------

export function generateSkillId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `skill-${crypto.randomUUID().slice(0, 8)}`;
  }
  return `skill-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function toSourceScopedId(source: SkillSource, rawId: string): string {
  const baseId = rawId.trim();
  if (!baseId) {
    return `${source}:unknown`;
  }
  return baseId.startsWith(`${source}:`) ? baseId : `${source}:${baseId}`;
}

// ---------------------------------------------------------------------------
// File-system skill discovery
// ---------------------------------------------------------------------------

/**
 * Discover skills from a directory that follows the convention:
 *   {baseDir}/skills/{skill-name}/SKILL.md
 *
 * Each subdirectory with a SKILL.md file becomes a skill. The first line
 * of the file (if it starts with `# `) is used as the display name;
 * the second non-empty line is used as the description.
 */
export async function discoverSkillsFromDirectory(
  baseDir: string,
  source: SkillSource,
): Promise<SkillEntry[]> {
  if (!baseDir.trim()) {
    return [];
  }

  const skillsDir = `${baseDir.replace(/\/+$/, "")}/${GLOBAL_SKILLS_DIR}`;
  const discovered: SkillEntry[] = [];
  try {
    const entries = await invoke<Array<{ name: string; is_dir: boolean }>>(
      "list_workspace_files",
      { workspacePath: baseDir, relativePath: GLOBAL_SKILLS_DIR },
    );

    for (const entry of entries) {
      if (!entry.is_dir) {
        continue;
      }

      const skillDir = `${skillsDir}/${entry.name}`;
      const skillFilePath = `${skillDir}/${SKILL_FILENAME}`;

      try {
        const result = await invoke<{
          content: string;
          total_lines: number;
        }>("read_workspace_file", {
          workspacePath: baseDir,
          relativePath: `${GLOBAL_SKILLS_DIR}/${entry.name}/${SKILL_FILENAME}`,
          startLine: null,
          endLine: null,
        });

        if (!result.content?.trim()) {
          continue;
        }

        const parsed = parseSkillMarkdown(result.content);
        discovered.push({
          id: toSourceScopedId(source, entry.name),
          name: parsed.name || entry.name,
          description: parsed.description || `Skill: ${entry.name}`,
          filePath: skillFilePath,
          source,
          enabled: true,
          keywords: parsed.keywords,
          filePatterns: parsed.filePatterns,
          createdAt: new Date().toISOString(),
        });
      } catch {
        // SKILL.md doesn't exist or can't be read — skip
        continue;
      }
    }
  } catch (error) {
    console.debug("[skills] Skill discovery skipped", {
      source,
      skillsDir,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return discovered;
}

/**
 * Discover skills from the global ~/.cofree/ directory.
 * Results are cached for 5 minutes to avoid repeated file-system scans (issue #4).
 */
export async function discoverGlobalSkills(): Promise<SkillEntry[]> {
  const cacheKey = "global";
  const cached = skillDiscoveryCache.get(cacheKey);
  if (cached && Date.now() - cached.loadedAt < SKILL_DISCOVERY_CACHE_TTL_MS) {
    return cached.skills;
  }

  try {
    const homeDir = await invoke<string>("get_home_dir");
    const cofreeDir = `${homeDir}/.cofree`;
    const skills = await discoverSkillsFromDirectory(cofreeDir, "global");
    skillDiscoveryCache.set(cacheKey, { skills, loadedAt: Date.now() });
    return skills;
  } catch (error) {
    console.debug("[skills] Failed to discover global skills", error);
    return [];
  }
}

/**
 * Discover skills from the workspace .cofree/ directory.
 * Results are cached per workspace path for 5 minutes (issue #4).
 */
export async function discoverWorkspaceSkills(
  workspacePath: string,
): Promise<SkillEntry[]> {
  if (!workspacePath.trim()) {
    return [];
  }

  const cacheKey = `workspace:${workspacePath}`;
  const cached = skillDiscoveryCache.get(cacheKey);
  if (cached && Date.now() - cached.loadedAt < SKILL_DISCOVERY_CACHE_TTL_MS) {
    return cached.skills;
  }

  try {
    const baseDir = `${workspacePath.replace(/\/+$/, "")}/.cofree`;
    const skills = await discoverSkillsFromDirectory(baseDir, "workspace");
    skillDiscoveryCache.set(cacheKey, { skills, loadedAt: Date.now() });
    return skills;
  } catch (error) {
    console.debug("[skills] Failed to discover workspace skills", {
      workspacePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

// ---------------------------------------------------------------------------
// SKILL.md parsing
// ---------------------------------------------------------------------------

interface ParsedSkillMarkdown {
  name: string;
  description: string;
  keywords?: string[];
  filePatterns?: string[];
}

/**
 * Parse a SKILL.md file to extract metadata.
 *
 * Expected format:
 * ```markdown
 * # Skill Name
 *
 * Description of when and how to use this skill.
 *
 * ## Keywords
 * keyword1, keyword2, keyword3
 *
 * ## File Patterns
 * *.sql, *.py
 *
 * ## Instructions
 * ... (the actual skill instructions)
 * ```
 */
export function parseSkillMarkdown(content: string): ParsedSkillMarkdown {
  const lines = content.split("\n");
  let name = "";
  let description = "";
  const keywords: string[] = [];
  const filePatterns: string[] = [];

  let currentSection = "header";

  for (const line of lines) {
    const trimmed = line.trim();

    // Parse H1 as name
    if (trimmed.startsWith("# ") && !name) {
      name = trimmed.slice(2).trim();
      currentSection = "description";
      continue;
    }

    // Parse H2 sections
    if (trimmed.startsWith("## ")) {
      const sectionName = trimmed.slice(3).trim().toLowerCase();
      if (sectionName === "keywords" || sectionName === "关键词") {
        currentSection = "keywords";
      } else if (
        sectionName === "file patterns" ||
        sectionName === "文件模式"
      ) {
        currentSection = "filePatterns";
      } else if (
        sectionName === "instructions" ||
        sectionName === "指令" ||
        sectionName === "说明"
      ) {
        currentSection = "instructions";
        break; // Stop parsing metadata, rest is instructions
      } else {
        currentSection = "other";
      }
      continue;
    }

    if (!trimmed) {
      continue;
    }

    switch (currentSection) {
      case "description":
        if (!description) {
          description = trimmed;
        }
        break;
      case "keywords":
        keywords.push(
          ...trimmed
            .split(",")
            .map((keyword) => keyword.trim().toLowerCase())
            .filter(Boolean),
        );
        break;
      case "filePatterns":
        filePatterns.push(
          ...trimmed
            .split(",")
            .map((pattern) => pattern.trim())
            .filter(Boolean),
        );
        break;
    }
  }

  return {
    name,
    description,
    keywords: keywords.length > 0 ? keywords : undefined,
    filePatterns: filePatterns.length > 0 ? filePatterns : undefined,
  };
}

// ---------------------------------------------------------------------------
// Skill content loading
// ---------------------------------------------------------------------------

/**
 * Load the full instructions content of a skill.
 * For file-based skills, reads the SKILL.md and extracts the Instructions section.
 * For inline skills, returns the instructions field directly.
 */
export async function loadSkillInstructions(
  skill: SkillEntry,
): Promise<string> {
  // Inline instructions take priority
  if (skill.instructions?.trim()) {
    return skill.instructions.trim().slice(0, MAX_SKILL_INSTRUCTIONS_LENGTH);
  }

  if (!skill.filePath) {
    return "";
  }

  // Check cache
  const cached = skillContentCache.get(skill.filePath);
  if (cached && Date.now() - cached.loadedAt < SKILL_CACHE_TTL_MS) {
    return cached.content;
  }

  try {
    const content = await readSkillFile(skill.filePath);
    if (!content.trim()) {
      return "";
    }

    const instructions = extractInstructionsSection(content);
    const truncated = instructions.slice(0, MAX_SKILL_INSTRUCTIONS_LENGTH);

    skillContentCache.set(skill.filePath, {
      content: truncated,
      loadedAt: Date.now(),
    });

    return truncated;
  } catch {
    return "";
  }
}

async function readSkillFile(absolutePath: string): Promise<string> {
  // Use Tauri's read_absolute_file command for absolute paths
  try {
    const result = await invoke<string>("read_absolute_file", {
      path: absolutePath,
    });
    return result;
  } catch {
    // Fallback: try to parse as workspace-relative
    return "";
  }
}

/**
 * Extract the Instructions section from a SKILL.md file.
 * If no explicit ## Instructions header is found, returns the entire content
 * after the metadata sections.
 */
function extractInstructionsSection(content: string): string {
  const lines = content.split("\n");
  let instructionsStart = -1;
  let metadataSectionCount = 0;

  for (let index = 0; index < lines.length; index++) {
    const trimmed = lines[index].trim();

    if (trimmed.startsWith("## ")) {
      const sectionName = trimmed.slice(3).trim().toLowerCase();
      if (
        sectionName === "instructions" ||
        sectionName === "指令" ||
        sectionName === "说明"
      ) {
        instructionsStart = index + 1;
        break;
      }
      metadataSectionCount++;
    }
  }

  // If we found an explicit Instructions section, return everything after it
  if (instructionsStart >= 0) {
    return lines.slice(instructionsStart).join("\n").trim();
  }

  // Otherwise return the full content (it's all instructions)
  return content.trim();
}

// ---------------------------------------------------------------------------
// Skill matching engine
// ---------------------------------------------------------------------------

const CJK_SEQUENCE_REGEX = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu;

function extractDescriptionMatchTokens(description: string): string[] {
  const normalized = description.toLowerCase().trim();
  if (!normalized) {
    return [];
  }

  const tokens = new Set<string>();
  for (const word of normalized.split(/\s+/).filter((part) => part.length > 3)) {
    tokens.add(word);
  }

  const cjkSequences = normalized.match(CJK_SEQUENCE_REGEX) ?? [];
  for (const sequence of cjkSequences) {
    if (sequence.length === 1) {
      tokens.add(sequence);
      continue;
    }
    for (let index = 0; index < sequence.length - 1; index++) {
      tokens.add(sequence.slice(index, index + 2));
    }
  }

  return [...tokens];
}

/**
 * Match skills against a user message and optional file context.
 * Returns skills sorted by relevance score (highest first).
 */
export function matchSkills(
  skills: ReadonlyArray<SkillEntry>,
  userMessage: string,
  activeFilePaths?: string[],
): SkillEntry[] {
  const enabledSkills = skills.filter((skill) => skill.enabled);
  if (enabledSkills.length === 0) {
    return [];
  }

  const messageLower = userMessage.toLowerCase();
  const scored: Array<{
    skill: SkillEntry;
    score: number;
  }> = [];

  for (const skill of enabledSkills) {
    let score = 0;

    // 1. Keyword matching (highest weight)
    if (skill.keywords?.length) {
      for (const keyword of skill.keywords) {
        if (messageLower.includes(keyword)) {
          score += 10;
        }
      }
    }

    // 2. Name matching
    if (messageLower.includes(skill.name.toLowerCase())) {
      score += 8;
    }

    // 3. Description token matching (supports CJK bigrams for Chinese/Japanese)
    const descriptionTokens = extractDescriptionMatchTokens(skill.description);
    let descriptionTokenMatches = 0;
    for (const token of descriptionTokens) {
      if (messageLower.includes(token)) {
        descriptionTokenMatches += 1;
      }
    }
    score += Math.min(descriptionTokenMatches, 5) * 2;

    // 4. File pattern matching
    if (skill.filePatterns?.length && activeFilePaths?.length) {
      for (const pattern of skill.filePatterns) {
        for (const filePath of activeFilePaths) {
          if (fileMatchesPattern(filePath, pattern)) {
            score += 6;
          }
        }
      }
    }

    if (score > 0) {
      scored.push({ skill, score });
    }
  }

  return scored
    .sort((first, second) => second.score - first.score)
    .slice(0, MAX_SKILLS_PER_REQUEST)
    .map((entry) => entry.skill);
}

function normalizePatternPath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function globPatternToRegExp(pattern: string): RegExp {
  let regex = "^";

  for (let index = 0; index < pattern.length; ) {
    const char = pattern[index];
    const next = pattern[index + 1];
    const nextNext = pattern[index + 2];

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

function fileMatchesPattern(filePath: string, pattern: string): boolean {
  const normalizedPath = normalizePatternPath(filePath);
  const normalizedPattern = normalizePatternPath(pattern);

  if (!normalizedPattern || !normalizedPath) {
    return false;
  }

  const hasDirectoryScope = normalizedPattern.includes("/");
  const targetPath = hasDirectoryScope
    ? normalizedPath
    : (normalizedPath.split("/").pop() ?? normalizedPath);

  if (!normalizedPattern.includes("*")) {
    if (!hasDirectoryScope) {
      return targetPath === normalizedPattern;
    }

    return targetPath === normalizedPattern
      || targetPath.startsWith(`${normalizedPattern}/`)
      || normalizedPattern.startsWith(`${targetPath}/`);
  }

  return globPatternToRegExp(normalizedPattern).test(targetPath);
}

// ---------------------------------------------------------------------------
// Skill resolution (load matched skills with their instructions)
// ---------------------------------------------------------------------------

/**
 * Resolve matched skills into fully-loaded ResolvedSkill objects
 * with their instructions content.
 */
export async function resolveSkills(
  skills: ReadonlyArray<SkillEntry>,
): Promise<ResolvedSkill[]> {
  const resolved: ResolvedSkill[] = [];

  for (const skill of skills) {
    const instructions = await loadSkillInstructions(skill);
    if (!instructions) {
      continue;
    }

    resolved.push({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      instructions,
      source: skill.source,
    });
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// Prompt fragment builder
// ---------------------------------------------------------------------------

/**
 * Build a system prompt fragment from resolved skills.
 */
export function buildSkillPromptFragment(
  resolvedSkills: ResolvedSkill[],
): string {
  if (resolvedSkills.length === 0) {
    return "";
  }

  const parts = resolvedSkills.map((skill) =>
    [
      `### Skill: ${skill.name}`,
      `${skill.description}`,
      "",
      skill.instructions,
    ].join("\n"),
  );

  return [
    "## 已激活的 Skills",
    "以下 Skills 与当前任务相关，请严格按照其指令执行：",
    "",
    ...parts,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Registry operations (for settings persistence)
// ---------------------------------------------------------------------------

/**
 * Create a new custom skill entry for persistence in settings.
 */
export function createSkillEntry(params: {
  name: string;
  description: string;
  filePath?: string;
  instructions?: string;
  filePatterns?: string[];
  keywords?: string[];
}): SkillEntry {
  return {
    id: toSourceScopedId("custom", generateSkillId()),
    name: params.name.trim(),
    description: params.description.trim(),
    filePath: params.filePath?.trim(),
    instructions: params.instructions?.trim(),
    source: "custom",
    enabled: true,
    filePatterns: params.filePatterns?.filter(Boolean),
    keywords: params.keywords?.filter(Boolean),
    createdAt: new Date().toISOString(),
  };
}

/**
 * Merge discovered skills with existing registry entries.
 * Discovered skills are added if not already present; existing entries
 * preserve their enabled state.
 *
 * Returns a new array — never mutates the input arrays (issue #3).
 */
export function mergeDiscoveredSkills(
  existing: ReadonlyArray<SkillEntry>,
  discovered: ReadonlyArray<SkillEntry>,
): SkillEntry[] {
  const discoveredById = new Map(discovered.map((skill) => [skill.id, skill]));
  const seenIds = new Set<string>();

  // First pass: existing entries, updated with discovered metadata if matched
  const merged: SkillEntry[] = existing.map((entry) => {
    seenIds.add(entry.id);
    const discoveredMatch = discoveredById.get(entry.id);
    if (!discoveredMatch) {
      return { ...entry };
    }
    // Create new object: preserve enabled state from existing, update metadata from discovered
    return {
      ...entry,
      name: discoveredMatch.name,
      description: discoveredMatch.description,
      filePath: discoveredMatch.filePath,
      source: discoveredMatch.source,
      filePatterns: discoveredMatch.filePatterns,
      keywords: discoveredMatch.keywords,
    };
  });

  // Second pass: add newly discovered skills not in existing
  for (const skill of discovered) {
    if (!seenIds.has(skill.id)) {
      merged.push({ ...skill });
    }
  }

  return merged;
}

/**
 * Invalidate skill caches.
 * - If a filePath is given, only that content cache entry is cleared.
 * - If no argument, both content and discovery caches are fully cleared.
 */
export function invalidateSkillCache(filePath?: string): void {
  if (filePath) {
    skillContentCache.delete(filePath);
  } else {
    skillContentCache.clear();
    skillDiscoveryCache.clear();
  }
}
