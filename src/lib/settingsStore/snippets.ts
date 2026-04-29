import type { SnippetEntry } from "../snippetStore";
import type { AppSettings } from "./general";

export function addSnippet(
  settings: AppSettings,
  snippet: SnippetEntry,
): AppSettings {
  if (settings.snippets.some((existing) => existing.id === snippet.id)) {
    return settings;
  }
  return {
    ...settings,
    snippets: [...settings.snippets, snippet],
  };
}

export function updateSnippet(
  settings: AppSettings,
  snippetId: string,
  updates: Partial<Omit<SnippetEntry, "id" | "createdAt">>,
): AppSettings {
  return {
    ...settings,
    snippets: settings.snippets.map((entry) =>
      entry.id === snippetId ? { ...entry, ...updates } : entry,
    ),
  };
}

export function deleteSnippet(
  settings: AppSettings,
  snippetId: string,
): AppSettings {
  return {
    ...settings,
    snippets: settings.snippets.filter((entry) => entry.id !== snippetId),
  };
}

export function toggleSnippet(
  settings: AppSettings,
  snippetId: string,
): AppSettings {
  return {
    ...settings,
    snippets: settings.snippets.map((entry) =>
      entry.id === snippetId ? { ...entry, enabled: !entry.enabled } : entry,
    ),
  };
}

export function setSnippets(
  settings: AppSettings,
  snippets: SnippetEntry[],
): AppSettings {
  return { ...settings, snippets };
}
