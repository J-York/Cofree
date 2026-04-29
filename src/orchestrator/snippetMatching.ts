/**
 * Cofree - AI Programming Cafe
 * File: src/orchestrator/snippetMatching.ts
 * Description: Resolves snippets that the user explicitly selected via
 * @-mention. Snippets — unlike skills — never auto-match against the user
 * message: if the caller does not pass `explicitSnippetIds`, nothing is
 * resolved.
 */

import type { AppSettings } from "../lib/settingsStore";
import {
  discoverGlobalSnippets,
  mergeSnippets,
  resolveSnippets,
  type ResolvedSnippet,
  type SnippetEntry,
} from "../lib/snippetStore";

export interface SnippetResolutionResult {
  resolved: ResolvedSnippet[];
}

/**
 * Resolve only the snippets the user explicitly @-mentioned. If
 * `explicitSnippetIds` is undefined or empty, returns an empty result —
 * snippets must never leak into the prompt without a deliberate user act.
 */
export async function resolveMatchedSnippets(
  settings: AppSettings,
  explicitSnippetIds?: string[],
): Promise<SnippetResolutionResult> {
  if (!explicitSnippetIds || explicitSnippetIds.length === 0) {
    return { resolved: [] };
  }

  try {
    const discovered = await discoverGlobalSnippets();
    const merged = mergeSnippets(settings.snippets ?? [], discovered);
    const enabled = merged.filter((entry) => entry.enabled);
    const wanted = explicitSnippetIds
      .map((id) => enabled.find((entry) => entry.id === id))
      .filter((entry): entry is SnippetEntry => entry != null);
    if (wanted.length === 0) {
      return { resolved: [] };
    }
    return { resolved: resolveSnippets(wanted) };
  } catch (error) {
    console.warn("[snippets] Failed to resolve explicit snippets", error);
    return { resolved: [] };
  }
}
