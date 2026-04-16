import { describe, expect, it } from "vitest";

import {
  createSkillEntry,
  matchSkills,
  mergeDiscoveredSkills,
  type SkillEntry,
} from "./skillStore";

describe("skillStore", () => {
  it("creates custom skills with source-scoped ids", () => {
    const entry = createSkillEntry({
      name: "resume-screener",
      description: "筛选简历",
      instructions: "Do work",
    });

    expect(entry.source).toBe("custom");
    expect(entry.id.startsWith("custom:")).toBe(true);
  });

  it("matches Chinese descriptions via CJK tokens", () => {
    const skills: SkillEntry[] = [
      {
        id: "cofreerc:resume-screener",
        name: "resume-screener",
        description: "批量筛选简历并生成候选人信息表",
        source: "cofreerc",
        enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        instructions: "Run the screener",
      },
    ];

    const matched = matchSkills(skills, "请帮我筛选简历并导出候选人列表");
    expect(matched).toHaveLength(1);
    expect(matched[0].id).toBe("cofreerc:resume-screener");
  });

  it("keeps source-scoped ids distinct across discovery sources", () => {
    const discovered: SkillEntry[] = [
      {
        id: "global:odps",
        name: "odps-global",
        description: "global",
        source: "global",
        enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "workspace:odps",
        name: "odps-workspace",
        description: "workspace",
        source: "workspace",
        enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    const merged = mergeDiscoveredSkills([], discovered);
    expect(merged).toHaveLength(2);
    expect(merged.map((skill) => skill.id)).toEqual(["global:odps", "workspace:odps"]);
  });

  it("preserves enabled state while refreshing discovered metadata", () => {
    const existing: SkillEntry[] = [
      {
        id: "workspace:odps",
        name: "old name",
        description: "old desc",
        source: "workspace",
        enabled: false,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    const discovered: SkillEntry[] = [
      {
        id: "workspace:odps",
        name: "new name",
        description: "new desc",
        source: "workspace",
        enabled: true,
        createdAt: "2026-02-01T00:00:00.000Z",
        keywords: ["sql"],
      },
    ];

    const merged = mergeDiscoveredSkills(existing, discovered);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: "workspace:odps",
      name: "new name",
      description: "new desc",
      enabled: false,
      keywords: ["sql"],
    });
  });
});
