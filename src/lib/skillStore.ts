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
  /** Workspace root under which this skill was discovered (enables read_workspace_file) */
  workspaceRoot?: string;
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
  /**
   * Absolute path to the skill's directory (the folder containing SKILL.md).
   * Used so the LLM can invoke scripts packaged alongside the skill (e.g.
   * `./run.sh`, `query.py`) from the right working directory instead of
   * searching for them inside the user's current workspace.
   */
  directoryPath?: string;
}

/**
 * Brief metadata about an enabled skill — used to make the LLM aware that a
 * skill exists without injecting its full instructions. Full instructions are
 * only injected for skills that match the request or were selected explicitly.
 */
export interface SkillManifestEntry {
  id: string;
  name: string;
  description: string;
  source: SkillSource;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SKILL_FILENAME = "SKILL.md";
const GLOBAL_SKILLS_DIR = "skills";
const MAX_SKILL_INSTRUCTIONS_LENGTH = 16_000;
export const MAX_SKILLS_PER_REQUEST = 5;

/**
 * Regex used to detect generic skill-invocation intents in user messages
 * (e.g. "请使用 skill 帮我…", "能不能用技能做…"). When matched and no
 * specific skill scored, the resolver falls back to all enabled skills so
 * the LLM actually has instructions to follow instead of denying the
 * skill's existence.
 */
const GENERIC_SKILL_INTENT_PATTERN = /\bskills?\b|技能/i;

export function mentionsGenericSkillIntent(message: string): boolean {
  return GENERIC_SKILL_INTENT_PATTERN.test(message);
}

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
          workspaceRoot: baseDir,
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

const FRONTMATTER_KEYWORDS_KEYS = new Set(["keywords", "tags", "关键词"]);
const FRONTMATTER_FILE_PATTERN_KEYS = new Set([
  "file-patterns",
  "filepatterns",
  "file_patterns",
  "globs",
  "文件模式",
]);

/**
 * Extract a leading YAML frontmatter block (between `---` fences) if present.
 * Returns the parsed key/value map plus the body (content after the closing
 * fence). When no frontmatter is present, returns an empty map and the
 * original content.
 *
 * This is intentionally a minimal parser: it handles `key: value` pairs,
 * quoted strings, inline arrays (`[a, b]`), and YAML block lists (`- item`).
 * Nested structures are not supported — they're not needed for SKILL.md.
 */
function extractFrontmatter(content: string): {
  frontmatter: Map<string, string | string[]>;
  body: string;
} {
  const frontmatter = new Map<string, string | string[]>();
  const lines = content.split("\n");

  // Frontmatter must start on line 1 with a `---` fence.
  if (lines.length === 0 || lines[0].trim() !== "---") {
    return { frontmatter, body: content };
  }

  let closingIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === "---") {
      closingIndex = index;
      break;
    }
  }
  if (closingIndex === -1) {
    return { frontmatter, body: content };
  }

  let currentKey: string | null = null;
  let currentList: string[] | null = null;
  for (let index = 1; index < closingIndex; index += 1) {
    const raw = lines[index];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    // Continuation of a block list under the current key.
    if (currentList && trimmed.startsWith("-")) {
      const item = stripQuotes(trimmed.slice(1).trim());
      if (item) {
        currentList.push(item);
      }
      continue;
    }

    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) {
      continue;
    }

    // Finalize the previous block list, if any.
    if (currentList && currentKey) {
      frontmatter.set(currentKey, currentList);
      currentKey = null;
      currentList = null;
    }

    const key = trimmed.slice(0, colonIndex).trim().toLowerCase();
    const rawValue = trimmed.slice(colonIndex + 1).trim();
    if (!key) {
      continue;
    }

    if (!rawValue) {
      // Value continues on subsequent lines as a block list.
      currentKey = key;
      currentList = [];
      continue;
    }

    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      const items = rawValue
        .slice(1, -1)
        .split(",")
        .map((item) => stripQuotes(item.trim()))
        .filter(Boolean);
      frontmatter.set(key, items);
      continue;
    }

    frontmatter.set(key, stripQuotes(rawValue));
  }

  if (currentList && currentKey) {
    frontmatter.set(currentKey, currentList);
  }

  const body = lines.slice(closingIndex + 1).join("\n");
  return { frontmatter, body };
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function coerceStringList(value: string | string[] | undefined): string[] {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map((item) => item.trim()).filter(Boolean);
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Parse a SKILL.md file to extract metadata.
 *
 * Supports two metadata sources, in this priority order:
 *
 * 1. YAML frontmatter (preferred, matches the Claude Code / Anthropic Skills
 *    convention):
 *
 *    ```markdown
 *    ---
 *    name: odps
 *    description: When to use this skill
 *    keywords: [sql, odps]
 *    file-patterns: ["*.sql"]
 *    ---
 *    ```
 *
 * 2. Markdown headings (legacy fallback):
 *
 *    ```markdown
 *    # Skill Name
 *    Description line.
 *
 *    ## Keywords
 *    keyword1, keyword2
 *
 *    ## File Patterns
 *    *.sql
 *
 *    ## Instructions
 *    ...
 *    ```
 *
 * Frontmatter values win when both are present; remaining fields fall back to
 * the heading-based form.
 */
export function parseSkillMarkdown(content: string): ParsedSkillMarkdown {
  const { frontmatter, body } = extractFrontmatter(content);

  const frontmatterName =
    typeof frontmatter.get("name") === "string" ? (frontmatter.get("name") as string) : "";
  const frontmatterDescription =
    typeof frontmatter.get("description") === "string"
      ? (frontmatter.get("description") as string)
      : "";

  const frontmatterKeywords = (() => {
    for (const key of FRONTMATTER_KEYWORDS_KEYS) {
      if (frontmatter.has(key)) {
        return coerceStringList(frontmatter.get(key)).map((keyword) =>
          keyword.toLowerCase(),
        );
      }
    }
    return [];
  })();

  const frontmatterFilePatterns = (() => {
    for (const key of FRONTMATTER_FILE_PATTERN_KEYS) {
      if (frontmatter.has(key)) {
        return coerceStringList(frontmatter.get(key));
      }
    }
    return [];
  })();

  const lines = body.split("\n");
  let name = frontmatterName.trim();
  let description = frontmatterDescription.trim();
  const keywords: string[] = [...frontmatterKeywords];
  const filePatterns: string[] = [...frontmatterFilePatterns];

  let currentSection = "header";

  for (const line of lines) {
    const trimmed = line.trim();

    // Parse H1 as name (fallback — frontmatter wins)
    if (trimmed.startsWith("# ") && !name) {
      name = trimmed.slice(2).trim();
      currentSection = "description";
      continue;
    }

    // After the H1, treat any non-heading content as description fallback.
    if (trimmed.startsWith("# ") && name) {
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
        if (keywords.length === 0) {
          keywords.push(
            ...trimmed
              .split(",")
              .map((keyword) => keyword.trim().toLowerCase())
              .filter(Boolean),
          );
        }
        break;
      case "filePatterns":
        if (filePatterns.length === 0) {
          filePatterns.push(
            ...trimmed
              .split(",")
              .map((pattern) => pattern.trim())
              .filter(Boolean),
          );
        }
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
    const content = await readSkillFile(skill.filePath, skill.workspaceRoot);
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
  } catch (error) {
    console.warn(
      "[skills] Failed to load skill instructions",
      { id: skill.id, name: skill.name, filePath: skill.filePath },
      error,
    );
    return "";
  }
}

/**
 * Read a skill file using read_workspace_file (preferred, no home-dir restriction)
 * with fallback to read_absolute_file (for backward-compat / custom skills).
 */
async function readSkillFile(
  absolutePath: string,
  workspaceRoot?: string,
): Promise<string> {
  // Prefer read_workspace_file when we have a workspace root — it works for
  // paths outside $HOME and is consistent with the discovery path.
  if (workspaceRoot) {
    const normalizedRoot = workspaceRoot.replace(/\/+$/, "");
    const normalizedPath = absolutePath.replace(/\/+$/, "");
    if (normalizedPath.startsWith(normalizedRoot + "/")) {
      const relativePath = normalizedPath.slice(normalizedRoot.length + 1);
      try {
        const result = await invoke<{
          content: string;
          total_lines: number;
        }>("read_workspace_file", {
          workspacePath: normalizedRoot,
          relativePath,
          startLine: null,
          endLine: null,
        });
        return result.content ?? "";
      } catch {
        // Fall through to read_absolute_file
      }
    }
  }

  // Fallback for custom skills / backward-compat / non-standard paths
  try {
    const result = await invoke<string>("read_absolute_file", {
      path: absolutePath,
    });
    return result;
  } catch {
    return "";
  }
}

/**
 * Extract the Instructions section from a SKILL.md file.
 * If no explicit ## Instructions header is found, returns the entire content
 * after the YAML frontmatter (if any).
 */
function extractInstructionsSection(content: string): string {
  const { body } = extractFrontmatter(content);
  const lines = body.split("\n");
  let instructionsStart = -1;

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
    }
  }

  // If we found an explicit Instructions section, return everything after it
  if (instructionsStart >= 0) {
    return lines.slice(instructionsStart).join("\n").trim();
  }

  // Otherwise return the body (content after frontmatter) — it's all instructions
  return body.trim();
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
      console.warn("[skills] Skipping skill with empty instructions", {
        id: skill.id,
        name: skill.name,
        filePath: skill.filePath,
        source: skill.source,
      });
      continue;
    }

    resolved.push({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      instructions,
      source: skill.source,
      directoryPath: deriveSkillDirectoryPath(skill),
    });
  }

  return resolved;
}

/**
 * Derive the absolute directory path of a skill from its file-based metadata.
 * Returns undefined for inline (cofreerc) or custom skills without a disk path.
 */
function deriveSkillDirectoryPath(skill: SkillEntry): string | undefined {
  if (!skill.filePath) {
    return undefined;
  }
  const normalized = skill.filePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const slashIndex = normalized.lastIndexOf("/");
  if (slashIndex <= 0) {
    return undefined;
  }
  return normalized.slice(0, slashIndex);
}

// ---------------------------------------------------------------------------
// Prompt fragment builder
// ---------------------------------------------------------------------------

/**
 * Build a system prompt fragment describing skills.
 *
 * - `resolvedSkills` — skills that matched this request (or were selected
 *   explicitly by the user via @-mention); their full instructions are
 *   injected.
 * - `manifest` — all enabled skills in the registry, rendered as a compact
 *   catalog so the LLM is always aware of what exists even when nothing
 *   matched. Entries already present in `resolvedSkills` are deduplicated.
 */
export function buildSkillPromptFragment(
  resolvedSkills: ReadonlyArray<ResolvedSkill>,
  manifest: ReadonlyArray<SkillManifestEntry> = [],
): string {
  const resolvedIds = new Set(resolvedSkills.map((skill) => skill.id));
  const remainingManifest = manifest.filter((entry) => !resolvedIds.has(entry.id));

  const sections: string[] = [];

  if (resolvedSkills.length > 0) {
    const parts = resolvedSkills.map((skill) => {
      const header = [`### Skill: ${skill.name}`, skill.description];
      if (skill.directoryPath) {
        header.push(
          "",
          `Skill 根目录（绝对路径）：${skill.directoryPath}`,
          "调用方式：执行该 skill 的脚本（如 `./run.sh`、`query.py`）时，请**以该目录为工作目录**。例如：",
          `\`cd ${skill.directoryPath} && ./run.sh query.py --sql "..."\``,
          `或直接用绝对路径 \`${skill.directoryPath}/run.sh\`。`,
        );

        if (skill.source === "global") {
          header.push("该目录不在当前工作区内；不要在当前工作区里搜寻 `./run.sh` 等文件。");
        }
      }
      return [...header, "", skill.instructions].join("\n");
    });
    sections.push(
      [
        "## 已激活的 Skills",
        "以下 Skills 与当前任务相关，请严格按照其指令执行：",
        "",
        ...parts,
      ].join("\n"),
    );
  }

  if (remainingManifest.length > 0) {
    const lines = remainingManifest.map(
      (entry) => `- **${entry.name}** — ${entry.description}`,
    );
    sections.push(
      [
        "## 可用 Skills（尚未激活）",
        "以下 Skills 已在本环境注册。若用户的需求匹配其中某个 skill 的场景，请直接告知用户并建议他们在输入框用 `@<skill 名>` 选中以加载完整指令；不要声称 skill 不存在。",
        "",
        ...lines,
      ].join("\n"),
    );
  }

  return sections.join("\n\n");
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
 * - `custom` entries are user-managed and always preserved.
 * - File-based discovered entries (`global` / `workspace` / `cofreerc`) are kept
 *   only when present in the current discovery result, eliminating stale skills.
 * - Existing enabled state is preserved whenever a discovered entry is refreshed.
 *
 * Returns a new array — never mutates the input arrays.
 */
export function mergeDiscoveredSkills(
  existing: ReadonlyArray<SkillEntry>,
  discovered: ReadonlyArray<SkillEntry>,
): SkillEntry[] {
  const discoveredById = new Map(discovered.map((skill) => [skill.id, skill]));
  const seenIds = new Set<string>();
  const merged: SkillEntry[] = [];

  for (const entry of existing) {
    seenIds.add(entry.id);
    const discoveredMatch = discoveredById.get(entry.id);

    if (discoveredMatch) {
      merged.push({
        ...entry,
        name: discoveredMatch.name,
        description: discoveredMatch.description,
        filePath: discoveredMatch.filePath,
        workspaceRoot: discoveredMatch.workspaceRoot,
        source: discoveredMatch.source,
        instructions: discoveredMatch.instructions,
        filePatterns: discoveredMatch.filePatterns,
        keywords: discoveredMatch.keywords,
      });
      continue;
    }

    if (entry.source === "custom") {
      merged.push({ ...entry });
    }
  }

  for (const skill of discovered) {
    if (!seenIds.has(skill.id)) {
      merged.push({ ...skill });
    }
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Cache invalidation + subscription
// ---------------------------------------------------------------------------

const skillCacheListeners = new Set<() => void>();

/**
 * Subscribe to skill cache invalidations. Returns an unsubscribe function.
 * Listeners fire only when the discovery cache is fully cleared (i.e. when
 * `invalidateSkillCache()` is called with no argument — typically after a
 * skill is installed, deleted, or otherwise changed on disk).
 */
export function subscribeToSkillCacheInvalidation(listener: () => void): () => void {
  skillCacheListeners.add(listener);
  return () => {
    skillCacheListeners.delete(listener);
  };
}

/**
 * Invalidate skill caches.
 * - If a filePath is given, only that content cache entry is cleared.
 * - If no argument, both content and discovery caches are fully cleared and
 *   subscribers are notified.
 */
export function invalidateSkillCache(filePath?: string): void {
  if (filePath) {
    skillContentCache.delete(filePath);
    return;
  }
  skillContentCache.clear();
  skillDiscoveryCache.clear();
  for (const listener of skillCacheListeners) {
    try {
      listener();
    } catch (error) {
      console.warn("[skills] cache invalidation listener threw", error);
    }
  }
}
