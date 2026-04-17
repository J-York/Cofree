import { useEffect, useState } from "react";
import { loadCofreeRc } from "../../../../lib/cofreerc";
import { gitStatusWorkspace, listWorkspaceFiles } from "../../../../lib/tauriBridge";
import {
  buildGitModifiedSuggestions,
  buildRootDirectorySuggestions,
} from "../mentions";
import type { ActiveMention, MentionSuggestion } from "../mentions";

/**
 * Owns the @-mention UI state: active mention window, suggestion list,
 * selection index, and workspace-derived data (ignore patterns, root entries,
 * git-modified files).
 *
 * Extracted from ChatPage.tsx (B1.4, see docs/REFACTOR_PLAN.md). The complex
 * suggestion-derivation effect stays in ChatPage for now — it depends on
 * composer attachments, selected skills, available skills, etc., which aren't
 * owned here.
 */
export function useMentionSuggestions(wsPath: string | undefined) {
  const [activeMention, setActiveMention] = useState<ActiveMention | null>(null);
  const [mentionSuggestions, setMentionSuggestions] = useState<MentionSuggestion[]>([]);
  const [mentionSelectionIndex, setMentionSelectionIndex] = useState(0);
  const [mentionIgnorePatterns, setMentionIgnorePatterns] = useState<string[]>([]);
  const [rootDirectorySuggestions, setRootDirectorySuggestions] = useState<MentionSuggestion[]>([]);
  const [gitMentionSuggestions, setGitMentionSuggestions] = useState<MentionSuggestion[]>([]);

  // Workspace-scoped: refresh ignore patterns + root entries + git status
  // whenever the active workspace changes.
  useEffect(() => {
    let cancelled = false;

    if (!wsPath) {
      setMentionIgnorePatterns([]);
      setRootDirectorySuggestions([]);
      setGitMentionSuggestions([]);
      return () => {
        cancelled = true;
      };
    }

    void loadCofreeRc(wsPath)
      .then(async (config) => {
        const ignorePatterns = config.ignorePatterns ?? [];
        const [rootEntries, gitStatus] = await Promise.all([
          listWorkspaceFiles({
            workspacePath: wsPath,
            relativePath: "",
            ignorePatterns,
          }).catch(() => []),
          gitStatusWorkspace(wsPath).catch(() => ({
            modified: [],
            added: [],
            deleted: [],
            untracked: [],
          })),
        ]);
        if (!cancelled) {
          setMentionIgnorePatterns(ignorePatterns);
          setRootDirectorySuggestions(buildRootDirectorySuggestions(rootEntries));
          setGitMentionSuggestions(
            buildGitModifiedSuggestions([
              ...gitStatus.modified,
              ...gitStatus.added,
              ...gitStatus.untracked,
            ]),
          );
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMentionIgnorePatterns([]);
          setRootDirectorySuggestions([]);
          setGitMentionSuggestions([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [wsPath]);

  return {
    activeMention,
    setActiveMention,
    mentionSuggestions,
    setMentionSuggestions,
    mentionSelectionIndex,
    setMentionSelectionIndex,
    mentionIgnorePatterns,
    rootDirectorySuggestions,
    gitMentionSuggestions,
  };
}
