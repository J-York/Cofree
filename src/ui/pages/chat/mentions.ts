import type { FileEntry, GlobEntry } from "../../../lib/tauriTypes";
import type { SkillEntry } from "../../../lib/skillStore";
import {
  createFileContextAttachment,
  createFolderContextAttachment,
  type ChatContextAttachment,
  type ChatContextAttachmentKind,
} from "../../../lib/contextAttachments";

export interface ActiveMention {
  query: string;
  start: number;
  end: number;
}

export interface MentionSuggestion {
  kind: ChatContextAttachmentKind | "skill";
  relativePath: string;
  displayName: string;
  modified: number;
  size: number;
  source: "search" | "recent" | "git" | "root" | "skill";
  skillId?: string;
  description?: string;
  keywords?: string[];
}

export interface MentionRankingSignals {
  recentPaths?: string[];
  relatedPaths?: string[];
  gitModifiedPaths?: string[];
}

function basenameOf(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

function directoryPathsOf(path: string): string[] {
  const normalized = normalizePath(path);
  const parts = normalized.split("/").filter(Boolean);
  const directories: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    directories.push(parts.slice(0, index).join("/"));
  }
  return directories;
}

function scoreSubsequence(haystack: string, needle: string): number {
  if (!needle) return 0;
  let index = 0;
  let jumps = 0;

  for (const char of needle) {
    const nextIndex = haystack.indexOf(char, index);
    if (nextIndex === -1) {
      return Number.NEGATIVE_INFINITY;
    }
    if (nextIndex > index) {
      jumps += nextIndex - index;
    }
    index = nextIndex + 1;
  }

  return Math.max(1, 120 - jumps);
}

function scoreMentionMatch(
  suggestion: MentionSuggestion,
  query: string,
  signals: MentionRankingSignals,
): number {
  const normalizedQuery = query.toLowerCase();

  if (suggestion.kind === "skill") {
    if (normalizedQuery.length === 0) return 200;
    const name = suggestion.relativePath.toLowerCase();
    const desc = (suggestion.description ?? "").toLowerCase();
    const kwStr = (suggestion.keywords ?? []).join(" ").toLowerCase();
    if (name === normalizedQuery) return 1100;
    if (name.startsWith(normalizedQuery)) return 960;
    if (name.includes(normalizedQuery)) return 800;
    if (desc.includes(normalizedQuery) || kwStr.includes(normalizedQuery)) return 650;
    return Number.NEGATIVE_INFINITY;
  }

  const normalizedPath = suggestion.relativePath.toLowerCase();
  const basename = basenameOf(normalizedPath);
  const recentSet = new Set((signals.recentPaths ?? []).map((path) => normalizePath(path).toLowerCase()));
  const relatedSet = new Set((signals.relatedPaths ?? []).map((path) => normalizePath(path).toLowerCase()));
  const gitSet = new Set((signals.gitModifiedPaths ?? []).map((path) => normalizePath(path).toLowerCase()));

  let score = 0;
  if (normalizedQuery.length > 0) {
    if (normalizedPath === normalizedQuery) score = 1000;
    else if (basename === normalizedQuery) score = 960;
    else if (basename.startsWith(normalizedQuery)) score = 860;
    else if (normalizedPath.startsWith(normalizedQuery)) score = 820;
    else if (normalizedPath.includes(`/${normalizedQuery}`)) score = 760;
    else if (basename.includes(normalizedQuery)) score = 700;
    else if (normalizedPath.includes(normalizedQuery)) score = 640;
    else {
      const basenameSubsequence = scoreSubsequence(basename, normalizedQuery);
      if (Number.isFinite(basenameSubsequence)) {
        score = 500 + basenameSubsequence;
      } else {
        const pathSubsequence = scoreSubsequence(normalizedPath, normalizedQuery);
        if (Number.isFinite(pathSubsequence)) {
          score = 300 + pathSubsequence;
        } else {
          return Number.NEGATIVE_INFINITY;
        }
      }
    }
  }

  if (suggestion.kind === "folder") {
    score += 15;
  }
  if (suggestion.source === "recent") {
    score += 60;
  } else if (suggestion.source === "git") {
    score += 45;
  } else if (suggestion.source === "root") {
    score += 25;
  }
  if (recentSet.has(normalizedPath)) {
    score += 120;
  }
  if (relatedSet.has(normalizedPath)) {
    score += 90;
  }
  if (gitSet.has(normalizedPath)) {
    score += 70;
  }
  if (
    suggestion.kind === "folder" &&
    (Array.from(recentSet).some((path) => path.startsWith(`${normalizedPath}/`)) ||
      Array.from(relatedSet).some((path) => path.startsWith(`${normalizedPath}/`)) ||
      Array.from(gitSet).some((path) => path.startsWith(`${normalizedPath}/`)))
  ) {
    score += 55;
  }
  if (suggestion.modified > 0) {
    score += Math.min(20, Math.floor(suggestion.modified / 100000000));
  }

  return score;
}

function dedupeMentionSuggestions(suggestions: MentionSuggestion[]): MentionSuggestion[] {
  const seen = new Set<string>();
  const result: MentionSuggestion[] = [];

  for (const suggestion of suggestions) {
    const key =
      suggestion.kind === "skill" && suggestion.skillId
        ? `skill:${suggestion.skillId}`
        : `${suggestion.kind}:${normalizePath(suggestion.relativePath)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({
      ...suggestion,
      relativePath: normalizePath(suggestion.relativePath),
    });
  }

  return result;
}

export function findActiveMention(text: string, caretIndex: number): ActiveMention | null {
  const safeCaret = Math.max(0, Math.min(caretIndex, text.length));
  const beforeCaret = text.slice(0, safeCaret);
  const match = beforeCaret.match(/(^|\s)@([^\s@]*)$/);
  if (!match) {
    return null;
  }

  const query = match[2] ?? "";
  return {
    query,
    start: safeCaret - query.length - 1,
    end: safeCaret,
  };
}

export function buildMentionSearchPattern(query: string): string {
  const sanitized = query
    .trim()
    .replace(/\\/g, "/")
    .replace(/[?*[\]{}!]/g, "")
    .replace(/\/+/g, "*");
  const caseInsensitive = sanitized.replace(/[a-z]/gi, (char) => {
    const lower = char.toLowerCase();
    const upper = char.toUpperCase();
    return lower === upper ? char : `[${lower}${upper}]`;
  });
  return `**/*${caseInsensitive}*`;
}

export function buildFolderSuggestionsFromFiles(
  query: string,
  entries: GlobEntry[],
): MentionSuggestion[] {
  const normalizedQuery = query.trim().toLowerCase();
  const candidates: MentionSuggestion[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const directories = directoryPathsOf(entry.path);
    for (const directory of directories) {
      const normalizedDirectory = directory.toLowerCase();
      if (
        normalizedQuery.length > 0 &&
        !normalizedDirectory.includes(normalizedQuery) &&
        !basenameOf(normalizedDirectory).includes(normalizedQuery)
      ) {
        continue;
      }
      if (seen.has(normalizedDirectory)) {
        continue;
      }
      seen.add(normalizedDirectory);
      candidates.push({
        kind: "folder",
        relativePath: normalizePath(directory),
        displayName: basenameOf(directory),
        modified: entry.modified,
        size: 0,
        source: "search",
      });
    }
  }

  return candidates;
}

export function buildRootDirectorySuggestions(entries: FileEntry[]): MentionSuggestion[] {
  return entries
    .filter((entry) => entry.is_dir)
    .map((entry) => ({
      kind: "folder" as const,
      relativePath: normalizePath(entry.name),
      displayName: entry.name,
      modified: entry.modified,
      size: entry.size,
      source: "root" as const,
    }));
}

export function buildGitModifiedSuggestions(paths: string[]): MentionSuggestion[] {
  return paths
    .map((path) => normalizePath(path))
    .filter(Boolean)
    .map((relativePath) => ({
      kind: "file" as const,
      relativePath,
      displayName: basenameOf(relativePath),
      modified: 0,
      size: 0,
      source: "git" as const,
    }));
}

export function buildRecentAttachmentSuggestions(
  attachments: ChatContextAttachment[],
): MentionSuggestion[] {
  return attachments.map((attachment) => ({
    kind: attachment.kind,
    relativePath: normalizePath(attachment.relativePath),
    displayName: attachment.displayName,
    modified: 0,
    size: 0,
    source: "recent",
  }));
}

export function buildSkillMentionSuggestions(
  skills: SkillEntry[],
  query: string,
): MentionSuggestion[] {
  const normalizedQuery = query.trim().toLowerCase();
  return skills
    .filter((skill) => skill.enabled)
    .filter((skill) => {
      if (normalizedQuery.length === 0) return true;
      const name = skill.name.toLowerCase();
      const desc = skill.description.toLowerCase();
      const kws = (skill.keywords ?? []).join(" ").toLowerCase();
      return (
        name.includes(normalizedQuery) ||
        desc.includes(normalizedQuery) ||
        kws.includes(normalizedQuery)
      );
    })
    .map((skill) => {
      // Include source label so same-name skills from different
      // origins are visually distinguishable in the suggestion list.
      const sourceLabel =
        skill.source === "global" ? "global" :
          skill.source === "workspace" ? "workspace" :
          skill.source === "cofreerc" ? "cofreerc" :
          "custom";
      return {
        kind: "skill" as const,
        relativePath: skill.name,
        displayName: `${skill.name} (${sourceLabel})`,
        modified: 0,
        size: 0,
        source: "skill" as const,
        skillId: skill.id,
        description: skill.description,
        keywords: skill.keywords,
      };
    })
}

export function rankMentionSuggestions(
  query: string,
  suggestions: MentionSuggestion[],
  signals: MentionRankingSignals = {},
): MentionSuggestion[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery && suggestions.length === 0) {
    return [];
  }

  return dedupeMentionSuggestions(suggestions)
    .map((suggestion) => ({
      suggestion,
      score: scoreMentionMatch(suggestion, normalizedQuery, signals),
    }))
    .filter(({ score }) => Number.isFinite(score))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (left.suggestion.relativePath.length !== right.suggestion.relativePath.length) {
        return left.suggestion.relativePath.length - right.suggestion.relativePath.length;
      }
      if (right.suggestion.modified !== left.suggestion.modified) {
        return right.suggestion.modified - left.suggestion.modified;
      }
      return left.suggestion.relativePath.localeCompare(right.suggestion.relativePath);
    })
    .slice(0, 8)
    .map(({ suggestion }) => suggestion);
}

export function buildDefaultMentionSuggestions(params: {
  recentSuggestions: MentionSuggestion[];
  gitSuggestions: MentionSuggestion[];
  rootDirectorySuggestions: MentionSuggestion[];
  skillSuggestions?: MentionSuggestion[];
  signals?: MentionRankingSignals;
}): MentionSuggestion[] {
  return rankMentionSuggestions(
    "",
    [
      ...(params.skillSuggestions ?? []),
      ...params.recentSuggestions,
      ...params.gitSuggestions,
      ...params.rootDirectorySuggestions,
    ],
    params.signals,
  );
}

export function applyMentionSuggestion(
  text: string,
  mention: ActiveMention,
): { nextText: string; nextCaret: number } {
  const nextText = `${text.slice(0, mention.start)}${text.slice(mention.end)}`
    .replace(/[ \t]{2,}/g, " ");
  return {
    nextText,
    nextCaret: mention.start,
  };
}

export function buildSubmittedPrompt(
  text: string,
  attachments: ChatContextAttachment[],
  hasSkills?: boolean,
): string {
  const trimmed = text.trim();
  if (trimmed) {
    return trimmed;
  }
  if (attachments.length > 0) {
    return "请基于我附加的上下文文件或目录协助我。";
  }
  if (hasSkills) {
    return "请使用我选择的 Skills 协助我。";
  }
  return "";
}

export function createAttachmentFromSuggestion(
  suggestion: MentionSuggestion,
): ChatContextAttachment {
  return suggestion.kind === "folder"
    ? createFolderContextAttachment(suggestion.relativePath)
    : createFileContextAttachment(suggestion.relativePath);
}
