import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS, type AppSettings } from "../lib/settingsStore";
import type { SkillEntry } from "../lib/skillStore";
import * as skillStore from "../lib/skillStore";
import { resolveMatchedSkills } from "./skillMatching";

function createSettings(skills: SkillEntry[] = []): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    workspacePath: "",
    skills,
  };
}

function createGlobalSkill(params: {
  id: string;
  name: string;
  description: string;
  instructions: string;
  enabled?: boolean;
}): SkillEntry {
  return {
    id: params.id,
    name: params.name,
    description: params.description,
    instructions: params.instructions,
    source: "global",
    enabled: params.enabled ?? true,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("resolveMatchedSkills", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back to normal matching when explicit skill ids resolve to nothing", async () => {
    const odpsSkill = createGlobalSkill({
      id: "global:odps",
      name: "odps",
      description: "ODPS SQL query helper",
      instructions: "Use ODPS SQL commands",
    });

    vi.spyOn(skillStore, "discoverGlobalSkills").mockResolvedValue([odpsSkill]);

    const result = await resolveMatchedSkills(
      createSettings(),
      undefined,
      "please query odps table",
      [],
      ["global:missing"],
    );

    expect(result.resolved.map((skill) => skill.id)).toEqual(["global:odps"]);
  });

  it("still runs generic intent fallback when explicit ids are invalid", async () => {
    const profilerSkill = createGlobalSkill({
      id: "global:profiler",
      name: "profiler",
      description: "Performance diagnostics helper",
      instructions: "Profile and inspect performance bottlenecks",
    });

    vi.spyOn(skillStore, "discoverGlobalSkills").mockResolvedValue([profilerSkill]);

    const result = await resolveMatchedSkills(
      createSettings(),
      undefined,
      "please use a skill for this task",
      [],
      ["global:missing"],
    );

    expect(result.resolved.map((skill) => skill.id)).toEqual(["global:profiler"]);
  });

  it("keeps explicit selection precedence when explicit ids are valid", async () => {
    const odpsSkill = createGlobalSkill({
      id: "global:odps",
      name: "odps",
      description: "ODPS SQL query helper",
      instructions: "Use ODPS SQL commands",
    });
    const resumeSkill = createGlobalSkill({
      id: "global:resume-screener",
      name: "resume-screener",
      description: "Batch resume screening helper",
      instructions: "Screen resumes and export candidates",
    });

    vi.spyOn(skillStore, "discoverGlobalSkills").mockResolvedValue([odpsSkill, resumeSkill]);

    const result = await resolveMatchedSkills(
      createSettings(),
      undefined,
      "please screen resumes",
      [],
      ["global:odps"],
    );

    expect(result.resolved.map((skill) => skill.id)).toEqual(["global:odps"]);
  });
});
