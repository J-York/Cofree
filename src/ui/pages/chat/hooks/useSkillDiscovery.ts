import { useEffect, useState } from "react";
import {
  loadCofreeRc,
  convertCofreeRcSkillEntries,
} from "../../../../lib/cofreerc";
import {
  discoverGlobalSkills,
  discoverWorkspaceSkills,
  mergeDiscoveredSkills,
  subscribeToSkillCacheInvalidation,
  type SkillEntry,
} from "../../../../lib/skillStore";

/**
 * Discovers enabled skills (global + workspace + .cofreerc) and keeps them in sync with
 * the workspace and the user's settings registry. Also re-runs discovery
 * whenever the skill cache is invalidated (e.g. after installing or deleting
 * a skill from the settings page) so newly installed skills show up in the
 * chat composer without requiring an app restart.
 */
export function useSkillDiscovery(
  wsPath: string | undefined,
  settingsSkills: SkillEntry[] | undefined,
): SkillEntry[] {
  const [availableSkills, setAvailableSkills] = useState<SkillEntry[]>([]);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    const unsubscribe = subscribeToSkillCacheInvalidation(() => {
      setRefreshToken((prev) => prev + 1);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadSkills = async () => {
      try {
        const workspacePath = wsPath?.trim() ?? "";
        const [globalSkills, workspaceSkills, cofreeRcSkills] = await Promise.all([
          discoverGlobalSkills(),
          workspacePath ? discoverWorkspaceSkills(workspacePath) : Promise.resolve([]),
          workspacePath
            ? loadCofreeRc(workspacePath)
                .then((config) => convertCofreeRcSkillEntries(config, workspacePath))
                .catch((error) => {
                  console.warn("[skills] Failed to load .cofreerc skills for chat discovery", error);
                  return [];
                })
            : Promise.resolve([]),
        ]);
        if (cancelled) return;
        const allDiscovered = [...globalSkills, ...workspaceSkills, ...cofreeRcSkills];
        const merged = mergeDiscoveredSkills(settingsSkills ?? [], allDiscovered);
        setAvailableSkills(merged.filter((s) => s.enabled));
      } catch {
        // Skill discovery failure is non-blocking.
      }
    };
    void loadSkills();
    return () => {
      cancelled = true;
    };
  }, [wsPath, settingsSkills, refreshToken]);

  return availableSkills;
}
