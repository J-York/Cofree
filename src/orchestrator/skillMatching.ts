import type { AppSettings } from "../lib/settingsStore";
import {
  MAX_SKILLS_PER_REQUEST,
  discoverGlobalSkills,
  discoverWorkspaceSkills,
  matchSkills,
  mentionsGenericSkillIntent,
  mergeDiscoveredSkills,
  resolveSkills,
  type ResolvedSkill,
  type SkillEntry,
  type SkillManifestEntry,
} from "../lib/skillStore";
import {
  convertCofreeRcSkillEntries,
  type CofreeRcConfig,
} from "../lib/cofreerc";

export interface SkillResolutionResult {
  /**
   * Skills whose full instructions should be injected into the system prompt
   * (matched by message/keywords/file-patterns, or explicitly selected via
   * @-mention, or triggered by a generic skill-intent fallback).
   */
  resolved: ResolvedSkill[];
  /**
   * All enabled skills in the merged registry, rendered as a brief manifest
   * in the system prompt so the LLM is always aware of what exists — even
   * when nothing matched.
   */
  available: SkillManifestEntry[];
}

function toManifestEntry(skill: SkillEntry): SkillManifestEntry {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    source: skill.source,
  };
}

/**
 * Discover, match, and resolve skills for the current request.
 * Merges skills from three sources: global (~/.cofree/skills/), workspace
 * (.cofree/skills/), .cofreerc, and user-registered custom skills in settings.
 *
 * Returns both the fully-resolved skills (whose instructions will be injected
 * into the system prompt) and a manifest of all enabled skills (so the LLM
 * can be made aware that other skills exist even when nothing matched).
 */
export async function resolveMatchedSkills(
  settings: AppSettings,
  projectConfig: CofreeRcConfig | undefined,
  userMessage: string,
  focusedPaths: string[],
  explicitSkillIds?: string[],
): Promise<SkillResolutionResult> {
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
    const enabledRegistry = mergedRegistry.filter((skill) => skill.enabled);
    const manifest = enabledRegistry.map(toManifestEntry);

    if (explicitSkillIds && explicitSkillIds.length > 0) {
      const explicitSkills = explicitSkillIds
        .map((id) => mergedRegistry.find((skill) => skill.id === id))
        .filter((skill): skill is SkillEntry => skill != null && skill.enabled);
      if (explicitSkills.length > 0) {
        console.debug(
          "[skills] Explicit skill selection",
          explicitSkills.map((skill) => ({ id: skill.id, name: skill.name })),
        );
        return {
          resolved: await resolveSkills(explicitSkills),
          available: manifest,
        };
      }

      console.debug("[skills] Explicit skill selection yielded no enabled skills; falling back", {
        explicitSkillIds,
        registrySize: mergedRegistry.length,
      });
    }

    const matched = matchSkills(mergedRegistry, userMessage, focusedPaths);
    if (matched.length > 0) {
      console.debug(
        "[skills] Matched skills",
        matched.map((skill) => ({ id: skill.id, name: skill.name, source: skill.source })),
      );
      return {
        resolved: await resolveSkills(matched),
        available: manifest,
      };
    }

    // Fallback: user generically asked to "use a skill" but no specific skill
    // keyword matched. Resolve all enabled skills (bounded) so the LLM has
    // actual instructions to follow instead of denying the skill exists.
    if (mentionsGenericSkillIntent(userMessage) && enabledRegistry.length > 0) {
      const fallback = enabledRegistry.slice(0, MAX_SKILLS_PER_REQUEST);
      console.debug(
        "[skills] Generic skill intent fallback",
        fallback.map((skill) => ({ id: skill.id, name: skill.name, source: skill.source })),
      );
      return {
        resolved: await resolveSkills(fallback),
        available: manifest,
      };
    }

    console.debug("[skills] No matched skills", {
      registrySize: mergedRegistry.length,
      enabledCount: enabledRegistry.length,
      focusedPathCount: focusedPaths.length,
    });
    return { resolved: [], available: manifest };
  } catch (error) {
    // Skill resolution should never block the main loop.
    console.warn("[skills] Failed to resolve matched skills", error);
    return { resolved: [], available: [] };
  }
}
