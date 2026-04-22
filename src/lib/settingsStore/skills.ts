import type { SkillEntry } from "../skillStore";
import type { AppSettings } from "./general";

export function addSkill(
  settings: AppSettings,
  skill: SkillEntry,
): AppSettings {
  const exists = settings.skills.some((existing) => existing.id === skill.id);
  if (exists) {
    return settings;
  }
  return {
    ...settings,
    skills: [...settings.skills, skill],
  };
}

export function updateSkill(
  settings: AppSettings,
  skillId: string,
  updates: Partial<Omit<SkillEntry, "id" | "createdAt">>,
): AppSettings {
  return {
    ...settings,
    skills: settings.skills.map((skill) =>
      skill.id === skillId ? { ...skill, ...updates } : skill,
    ),
  };
}

export function deleteSkill(settings: AppSettings, skillId: string): AppSettings {
  return {
    ...settings,
    skills: settings.skills.filter((skill) => skill.id !== skillId),
  };
}

export function toggleSkill(settings: AppSettings, skillId: string): AppSettings {
  return {
    ...settings,
    skills: settings.skills.map((skill) =>
      skill.id === skillId ? { ...skill, enabled: !skill.enabled } : skill,
    ),
  };
}

export function setSkills(settings: AppSettings, skills: SkillEntry[]): AppSettings {
  return { ...settings, skills };
}
