import { useEffect, useState } from "react";
import {
  discoverGlobalSkills,
  discoverWorkspaceSkills,
  mergeDiscoveredSkills,
  type SkillEntry,
} from "../../../../lib/skillStore";

/**
 * Discovers enabled skills (global + workspace) and keeps them in sync with
 * the workspace and the user's settings registry.
 *
 * Extracted from ChatPage.tsx (B1.4, see docs/REFACTOR_PLAN.md).
 */
export function useSkillDiscovery(
  wsPath: string | undefined,
  settingsSkills: SkillEntry[] | undefined,
): SkillEntry[] {
  const [availableSkills, setAvailableSkills] = useState<SkillEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    const loadSkills = async () => {
      try {
        const [globalSkills, workspaceSkills] = await Promise.all([
          discoverGlobalSkills(),
          wsPath ? discoverWorkspaceSkills(wsPath) : Promise.resolve([]),
        ]);
        if (cancelled) return;
        const allDiscovered = [...globalSkills, ...workspaceSkills];
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
  }, [wsPath, settingsSkills]);

  return availableSkills;
}
