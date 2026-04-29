import { useEffect, useState } from "react";
import {
  discoverGlobalSnippets,
  mergeSnippets,
  subscribeToSnippetCacheInvalidation,
  type SnippetEntry,
} from "../../../../lib/snippetStore";

/**
 * Discover enabled snippets (global + custom from settings) for the @-mention
 * picker. Re-runs when the snippet cache is invalidated (e.g. after creating
 * or deleting a snippet from the settings page).
 */
export function useSnippetDiscovery(
  settingsSnippets: SnippetEntry[] | undefined,
): SnippetEntry[] {
  const [available, setAvailable] = useState<SnippetEntry[]>([]);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    const unsubscribe = subscribeToSnippetCacheInvalidation(() => {
      setRefreshToken((prev) => prev + 1);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const discovered = await discoverGlobalSnippets();
        if (cancelled) return;
        const merged = mergeSnippets(settingsSnippets ?? [], discovered);
        setAvailable(merged.filter((entry) => entry.enabled));
      } catch {
        // Snippet discovery failure is non-blocking.
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [settingsSnippets, refreshToken]);

  return available;
}
