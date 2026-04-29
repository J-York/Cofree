/**
 * Cofree - AI Programming Cafe
 * File: src/lib/snippetStore.ts
 * Description: Snippet system — pre-defined knowledge fragments that are
 * injected into the system prompt **only** when explicitly selected by the
 * user via @-mention. Unlike Skills, snippets never auto-match against
 * message content or file paths.
 *
 * Snippets are loaded from:
 *   1. Global directory: ~/.cofree/snippets/{name}.md (single .md file per snippet)
 *   2. Custom inline entries in settings (no file backing)
 *
 * Each snippet declares a name and description in YAML frontmatter; the
 * remaining body is the literal text injected into the prompt.
 */
import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SnippetSource = "global-file" | "custom";

export interface SnippetEntry {
  /** Unique identifier scoped by source (e.g. "global-file:hdy", "custom:abc12345"). */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Short description shown in @-mention picker and SnippetTab. */
  description: string;
  /** Body text that will be injected verbatim into the system prompt. */
  body: string;
  /** Where this snippet was loaded from. */
  source: SnippetSource;
  /** Whether this snippet is enabled. */
  enabled: boolean;
  /** Absolute path to the .md file (only for global-file). */
  filePath?: string;
  /** When this snippet was registered. */
  createdAt: string;
}

export interface ResolvedSnippet {
  id: string;
  name: string;
  description: string;
  body: string;
  source: SnippetSource;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GLOBAL_SNIPPETS_DIR = "snippets";
const MAX_SNIPPET_BODY_LENGTH = 16_000;

// ---------------------------------------------------------------------------
// In-memory caches
// ---------------------------------------------------------------------------

const snippetDiscoveryCache = new Map<
  string,
  { entries: SnippetEntry[]; loadedAt: number }
>();
const SNIPPET_DISCOVERY_CACHE_TTL_MS = 5 * 60_000;

const snippetCacheListeners = new Set<() => void>();

// ---------------------------------------------------------------------------
// ID utilities
// ---------------------------------------------------------------------------

export function generateCustomSnippetId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `custom:${crypto.randomUUID().slice(0, 8)}`;
  }
  return `custom:${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function toGlobalFileId(stem: string): string {
  return `global-file:${stem}`;
}

/**
 * Convert a user-entered display name into a filesystem-safe filename stem.
 * Conservative — only ascii letters, digits, dashes, underscores. CJK chars
 * are stripped, so users picking pure-CJK names should get a fallback.
 */
export function slugifySnippetName(name: string): string {
  const ascii = name
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9_-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  if (ascii) {
    return ascii.slice(0, 64);
  }
  // Fallback for pure-CJK or otherwise unrepresentable names.
  return `snippet-${Date.now().toString(36)}`;
}

// ---------------------------------------------------------------------------
// Markdown (de)serialization
// ---------------------------------------------------------------------------

interface ParsedSnippetMarkdown {
  name: string;
  description: string;
  body: string;
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

/**
 * Parse a snippet .md file: minimal YAML frontmatter (`name`, `description`)
 * followed by a freeform body. The body becomes the prompt-injection text.
 */
export function parseSnippetMarkdown(content: string): ParsedSnippetMarkdown {
  const lines = content.split("\n");
  let body = content;
  let name = "";
  let description = "";

  if (lines.length > 0 && lines[0].trim() === "---") {
    let closingIndex = -1;
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i].trim() === "---") {
        closingIndex = i;
        break;
      }
    }
    if (closingIndex !== -1) {
      for (let i = 1; i < closingIndex; i += 1) {
        const trimmed = lines[i].trim();
        if (!trimmed || trimmed.startsWith("#")) {
          continue;
        }
        const colonIndex = trimmed.indexOf(":");
        if (colonIndex === -1) {
          continue;
        }
        const key = trimmed.slice(0, colonIndex).trim().toLowerCase();
        const value = stripQuotes(trimmed.slice(colonIndex + 1).trim());
        if (key === "name") {
          name = value;
        } else if (key === "description") {
          description = value;
        }
      }
      body = lines.slice(closingIndex + 1).join("\n");
    }
  }

  return {
    name: name.trim(),
    description: description.trim(),
    body: body.trim(),
  };
}

/**
 * Serialize a snippet entry to a frontmatter-prefixed markdown document
 * suitable for writing to ~/.cofree/snippets/<name>.md.
 */
export function serializeSnippetMarkdown(entry: {
  name: string;
  description: string;
  body: string;
}): string {
  const escape = (value: string): string => {
    if (value.includes('"') || value.includes("\n")) {
      return JSON.stringify(value);
    }
    return `"${value}"`;
  };
  const frontmatter = [
    "---",
    `name: ${escape(entry.name)}`,
    `description: ${escape(entry.description)}`,
    "---",
    "",
  ].join("\n");
  return `${frontmatter}${entry.body.trimEnd()}\n`;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Discover snippets under ~/.cofree/snippets/. Cached for 5 minutes.
 */
export async function discoverGlobalSnippets(): Promise<SnippetEntry[]> {
  const cacheKey = "global";
  const cached = snippetDiscoveryCache.get(cacheKey);
  if (cached && Date.now() - cached.loadedAt < SNIPPET_DISCOVERY_CACHE_TTL_MS) {
    return cached.entries;
  }

  try {
    const homeDir = await invoke<string>("get_home_dir");
    const cofreeDir = `${homeDir}/.cofree`;
    const entries = await invoke<Array<{ name: string; is_dir: boolean }>>(
      "list_workspace_files",
      { workspacePath: cofreeDir, relativePath: GLOBAL_SNIPPETS_DIR },
    ).catch(() => []);

    const discovered: SnippetEntry[] = [];
    for (const entry of entries) {
      if (entry.is_dir) {
        continue;
      }
      if (!entry.name.toLowerCase().endsWith(".md")) {
        continue;
      }
      const stem = entry.name.replace(/\.md$/i, "");
      try {
        const result = await invoke<{ content: string; total_lines: number }>(
          "read_workspace_file",
          {
            workspacePath: cofreeDir,
            relativePath: `${GLOBAL_SNIPPETS_DIR}/${entry.name}`,
            startLine: null,
            endLine: null,
          },
        );
        if (!result.content?.trim()) {
          continue;
        }
        const parsed = parseSnippetMarkdown(result.content);
        if (!parsed.name || !parsed.description || !parsed.body) {
          // Skip files missing required fields rather than render broken entries.
          continue;
        }
        discovered.push({
          id: toGlobalFileId(stem),
          name: parsed.name,
          description: parsed.description,
          body: parsed.body.slice(0, MAX_SNIPPET_BODY_LENGTH),
          source: "global-file",
          enabled: true,
          filePath: `${cofreeDir}/${GLOBAL_SNIPPETS_DIR}/${entry.name}`,
          createdAt: new Date().toISOString(),
        });
      } catch {
        continue;
      }
    }

    snippetDiscoveryCache.set(cacheKey, {
      entries: discovered,
      loadedAt: Date.now(),
    });
    return discovered;
  } catch (error) {
    console.debug("[snippets] Failed to discover global snippets", error);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Resolution + prompt fragment
// ---------------------------------------------------------------------------

export function resolveSnippets(
  entries: ReadonlyArray<SnippetEntry>,
): ResolvedSnippet[] {
  const resolved: ResolvedSnippet[] = [];
  for (const entry of entries) {
    const body = entry.body.trim().slice(0, MAX_SNIPPET_BODY_LENGTH);
    if (!body) {
      console.warn("[snippets] Skipping snippet with empty body", {
        id: entry.id,
        name: entry.name,
      });
      continue;
    }
    resolved.push({
      id: entry.id,
      name: entry.name,
      description: entry.description,
      body,
      source: entry.source,
    });
  }
  return resolved;
}

/**
 * Build the system-prompt fragment for explicitly-selected snippets.
 * Returns an empty string when no snippets resolve, so callers can blindly
 * append the result.
 *
 * Format uses `<snippet name="...">...</snippet>` blocks so the model sees
 * clear boundaries between fragments without polluting the markdown heading
 * hierarchy.
 */
export function buildSnippetPromptFragment(
  resolved: ReadonlyArray<ResolvedSnippet>,
): string {
  if (resolved.length === 0) {
    return "";
  }
  const blocks = resolved.map((snippet) => {
    const escapedName = snippet.name.replace(/"/g, '\\"');
    return `<snippet name="${escapedName}">\n${snippet.body}\n</snippet>`;
  });
  return [
    "## 已激活的知识 / Snippets",
    "用户在本轮显式选中以下知识片段（通过 @ 提及）。请将其作为上下文参考，必要时直接引用其中信息：",
    "",
    blocks.join("\n\n"),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Registry merge (file-based + custom)
// ---------------------------------------------------------------------------

/**
 * Combine custom (inline) snippet entries from settings with global-file
 * entries discovered on disk. File-based entries always reflect the latest
 * disk state; custom entries are user-managed and pass through unchanged.
 *
 * Stale file-based entries (i.e. previously discovered but now missing from
 * disk) are dropped, matching how `mergeDiscoveredSkills` handles skills.
 */
export function mergeSnippets(
  custom: ReadonlyArray<SnippetEntry>,
  discovered: ReadonlyArray<SnippetEntry>,
): SnippetEntry[] {
  const merged: SnippetEntry[] = [];
  for (const entry of custom) {
    if (entry.source === "custom") {
      merged.push({ ...entry });
    }
  }
  for (const entry of discovered) {
    merged.push({ ...entry });
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Cache invalidation + subscription
// ---------------------------------------------------------------------------

export function subscribeToSnippetCacheInvalidation(
  listener: () => void,
): () => void {
  snippetCacheListeners.add(listener);
  return () => {
    snippetCacheListeners.delete(listener);
  };
}

export function invalidateSnippetCache(): void {
  snippetDiscoveryCache.clear();
  for (const listener of snippetCacheListeners) {
    try {
      listener();
    } catch (error) {
      console.warn("[snippets] cache invalidation listener threw", error);
    }
  }
}

// ---------------------------------------------------------------------------
// Custom (inline) snippet creation helper
// ---------------------------------------------------------------------------

export function createCustomSnippetEntry(params: {
  name: string;
  description: string;
  body: string;
}): SnippetEntry {
  return {
    id: generateCustomSnippetId(),
    name: params.name.trim(),
    description: params.description.trim(),
    body: params.body.trim(),
    source: "custom",
    enabled: true,
    createdAt: new Date().toISOString(),
  };
}
