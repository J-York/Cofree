import type { AppSettings } from "../lib/settingsStore";
import {
  discoverGlobalSkills,
  discoverWorkspaceSkills,
  matchSkills,
  mergeDiscoveredSkills,
  resolveSkills,
  type ResolvedSkill,
  type SkillEntry,
} from "../lib/skillStore";
import {
  convertCofreeRcSkillEntries,
  type CofreeRcConfig,
} from "../lib/cofreerc";

/**
 * Discover, match, and resolve skills for the current request.
 * Merges skills from three sources: global (~/.cofree/skills/), workspace
 * (.cofree/skills/), .cofreerc, and user-registered custom skills in settings.
 */
export async function resolveMatchedSkills(
  settings: AppSettings,
  projectConfig: CofreeRcConfig | undefined,
  userMessage: string,
  focusedPaths: string[],
  explicitSkillIds?: string[],
): Promise<ResolvedSkill[]> {
  try {
    const allSkillDefs: SkillEntry[] = [];
    const workspacePath = settings.workspacePath.trim();

    const [globalSkills, workspaceSkills] = await Promise.all([
      discoverGlobalSkills(),
      workspacePath ? discoverWorkspaceSkills(workspacePath) : Promise.resolve([]),
    ]);
    allSkillDefs.push(...globalSkills, ...workspaceSkills);

    if (projectConfig?.skills?.length && workspacePath) {
      allSkillDefs.push(...convertCofreeRcSkillEntries(projectConfig, workspacePath));
    }

    const mergedRegistry = mergeDiscoveredSkills(settings.skills, allSkillDefs);

    if (explicitSkillIds && explicitSkillIds.length > 0) {
      const explicitSkills = explicitSkillIds
        .map((id) => mergedRegistry.find((skill) => skill.id === id))
        .filter((skill): skill is SkillEntry => skill != null && skill.enabled);
      console.debug(
        "[skills] Explicit skill selection",
        explicitSkills.map((skill) => ({ id: skill.id, name: skill.name })),
      );
      return resolveSkills(explicitSkills);
    }

    const matched = matchSkills(mergedRegistry, userMessage, focusedPaths);
    if (matched.length === 0) {
      console.debug("[skills] No matched skills", {
        registrySize: mergedRegistry.length,
        focusedPathCount: focusedPaths.length,
      });
      return [];
    }

    console.debug(
      "[skills] Matched skills",
      matched.map((skill) => ({ id: skill.id, name: skill.name, source: skill.source })),
    );

    return resolveSkills(matched);
  } catch (error) {
    // Skill resolution should never block the main loop.
    console.warn("[skills] Failed to resolve matched skills", error);
    return [];
  }
}
