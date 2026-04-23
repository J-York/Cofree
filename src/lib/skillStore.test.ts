import { describe, expect, it, vi } from "vitest";

import {
  buildSkillPromptFragment,
  createSkillEntry,
  invalidateSkillCache,
  matchSkills,
  mentionsGenericSkillIntent,
  mergeDiscoveredSkills,
  parseSkillMarkdown,
  subscribeToSkillCacheInvalidation,
  type ResolvedSkill,
  type SkillEntry,
  type SkillManifestEntry,
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
        instructions: "new instructions",
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
      instructions: "new instructions",
    });
  });
  it("drops stale discovered entries while preserving custom skills", () => {
    const existing: SkillEntry[] = [
      {
        id: "workspace:old-skill",
        name: "old-skill",
        description: "stale",
        source: "workspace",
        enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "custom:my-local",
        name: "my-local",
        description: "custom",
        source: "custom",
        enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        instructions: "local instructions",
      },
    ];

    const discovered: SkillEntry[] = [
      {
        id: "workspace:new-skill",
        name: "new-skill",
        description: "fresh",
        source: "workspace",
        enabled: true,
        createdAt: "2026-02-01T00:00:00.000Z",
      },
    ];

    const merged = mergeDiscoveredSkills(existing, discovered);
    expect(merged.map((skill) => skill.id)).toEqual(["custom:my-local", "workspace:new-skill"]);
  });

  it("matches glob-style file patterns for active files", () => {
    const skills: SkillEntry[] = [
      {
        id: "workspace:sql-helper",
        name: "sql-helper",
        description: "SQL helper",
        source: "workspace",
        enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        instructions: "Use SQL helper",
        filePatterns: ["db/**/*.sql", "*.ts"],
      },
    ];

    const matchedSql = matchSkills(skills, "check files", ["db/migrations/001_init.sql"]);
    expect(matchedSql).toHaveLength(1);
    expect(matchedSql[0].id).toBe("workspace:sql-helper");

    const matchedTs = matchSkills(skills, "check files", ["src/lib/tool.ts"]);
    expect(matchedTs).toHaveLength(1);
    expect(matchedTs[0].id).toBe("workspace:sql-helper");

    const unmatched = matchSkills(skills, "check files", ["docs/guide.md"]);
    expect(unmatched).toHaveLength(0);
  });

  describe("parseSkillMarkdown", () => {
    it("extracts name from H1, description from first non-empty line", () => {
      const content = `# ODPS Query\n查询 MaxCompute 数据\n\n## Instructions\nDo the query.`;
      const parsed = parseSkillMarkdown(content);
      expect(parsed.name).toBe("ODPS Query");
      expect(parsed.description).toBe("查询 MaxCompute 数据");
    });

    it("extracts keywords section", () => {
      const content = `# Resume\n筛选简历\n\n## Keywords\n简历, screening, HR\n\n## Instructions\nRun screener.`;
      const parsed = parseSkillMarkdown(content);
      expect(parsed.keywords).toEqual(["简历", "screening", "hr"]);
    });

    it("extracts Chinese 关键词 section", () => {
      const content = `# Test\nDesc\n\n## 关键词\nsql, 数据\n\n## 指令\nDo it.`;
      const parsed = parseSkillMarkdown(content);
      expect(parsed.keywords).toEqual(["sql", "数据"]);
    });

    it("extracts file patterns section", () => {
      const content = `# SQL\nSQL helper\n\n## File Patterns\n*.sql, db/**/*.sql\n\n## Instructions\nUse SQL.`;
      const parsed = parseSkillMarkdown(content);
      expect(parsed.filePatterns).toEqual(["*.sql", "db/**/*.sql"]);
    });

    it("extracts 文件模式 section (Chinese)", () => {
      const content = `# Test\nDesc\n\n## 文件模式\n*.py\n\n## 说明\nDo it.`;
      const parsed = parseSkillMarkdown(content);
      expect(parsed.filePatterns).toEqual(["*.py"]);
    });

    it("stops parsing at 指令/说明 section and does not include it in metadata", () => {
      const content = `# Skill\nA skill\n\n## Keywords\ntest\n\n## 指令\nThis is instruction content.`;
      const parsed = parseSkillMarkdown(content);
      expect(parsed.keywords).toEqual(["test"]);
      // Instructions section stops metadata parsing — no file patterns parsed after it
      expect(parsed.filePatterns).toBeUndefined();
    });

    it("returns empty strings and undefined arrays for minimal input", () => {
      const parsed = parseSkillMarkdown("");
      expect(parsed.name).toBe("");
      expect(parsed.description).toBe("");
      expect(parsed.keywords).toBeUndefined();
      expect(parsed.filePatterns).toBeUndefined();
    });

    it("handles name-only content without any sections", () => {
      const parsed = parseSkillMarkdown("# MySkill");
      expect(parsed.name).toBe("MySkill");
      expect(parsed.description).toBe("");
    });

    it("prefers YAML frontmatter name and description over H1", () => {
      const content = [
        "---",
        "name: odps",
        "description: MaxCompute (ODPS) data query skill. Use when working with ODPS or SQL.",
        "---",
        "",
        "# ODPS Query Skill",
        "**Just tell me what data you need.**",
      ].join("\n");

      const parsed = parseSkillMarkdown(content);
      expect(parsed.name).toBe("odps");
      expect(parsed.description).toBe(
        "MaxCompute (ODPS) data query skill. Use when working with ODPS or SQL.",
      );
    });

    it("parses frontmatter inline array keywords and file-patterns", () => {
      const content = [
        "---",
        "name: sql",
        'description: "SQL helper"',
        "keywords: [SQL, odps, MaxCompute]",
        'file-patterns: ["*.sql", "db/**/*.sql"]',
        "---",
        "",
        "# fallback heading",
      ].join("\n");

      const parsed = parseSkillMarkdown(content);
      expect(parsed.keywords).toEqual(["sql", "odps", "maxcompute"]);
      expect(parsed.filePatterns).toEqual(["*.sql", "db/**/*.sql"]);
    });

    it("parses frontmatter block-list keywords", () => {
      const content = [
        "---",
        "name: resume",
        "description: Resume screener",
        "keywords:",
        "  - resume",
        "  - 简历",
        "  - HR",
        "---",
        "",
        "# Resume Screener",
      ].join("\n");

      const parsed = parseSkillMarkdown(content);
      expect(parsed.keywords).toEqual(["resume", "简历", "hr"]);
    });

    it("falls back to H1 when frontmatter lacks name, still honors frontmatter description", () => {
      const content = [
        "---",
        "description: Some description",
        "---",
        "",
        "# Heading Name",
        "Unused body description",
      ].join("\n");

      const parsed = parseSkillMarkdown(content);
      expect(parsed.name).toBe("Heading Name");
      expect(parsed.description).toBe("Some description");
    });

    it("ignores unterminated frontmatter and falls back to markdown parsing", () => {
      const content = [
        "---",
        "name: never-closed",
        "description: leaked",
        "# Real Heading",
        "Real description",
      ].join("\n");

      const parsed = parseSkillMarkdown(content);
      expect(parsed.name).toBe("Real Heading");
      expect(parsed.description).toBe("Real description");
    });

    it("matches user messages against frontmatter-derived description tokens", () => {
      const content = [
        "---",
        "name: odps",
        "description: MaxCompute (ODPS) data query skill. Execute SQL queries and manage credentials.",
        "---",
        "",
        "# ODPS Query Skill",
        "**Just tell me what data you need.**",
      ].join("\n");

      const parsed = parseSkillMarkdown(content);
      const skill: SkillEntry = {
        id: "global:odps",
        name: parsed.name,
        description: parsed.description,
        source: "global",
        enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        keywords: parsed.keywords,
        filePatterns: parsed.filePatterns,
      };

      const matched = matchSkills([skill], "帮我查询 odps 里的一张表");
      expect(matched).toHaveLength(1);
      expect(matched[0].id).toBe("global:odps");
    });
  });

  describe("cache invalidation subscription", () => {
    it("notifies subscribers on full cache invalidation and not on path-only invalidation", () => {
      const listener = vi.fn();
      const unsubscribe = subscribeToSkillCacheInvalidation(listener);
      try {
        invalidateSkillCache("/absolute/path/SKILL.md");
        expect(listener).not.toHaveBeenCalled();

        invalidateSkillCache();
        expect(listener).toHaveBeenCalledTimes(1);

        invalidateSkillCache();
        expect(listener).toHaveBeenCalledTimes(2);
      } finally {
        unsubscribe();
      }
    });

    it("stops notifying after unsubscribe", () => {
      const listener = vi.fn();
      const unsubscribe = subscribeToSkillCacheInvalidation(listener);
      unsubscribe();
      invalidateSkillCache();
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("mentionsGenericSkillIntent", () => {
    it("matches English 'skill' / 'skills' as whole words", () => {
      expect(mentionsGenericSkillIntent("请你帮我使用 skill 检查表结构")).toBe(true);
      expect(mentionsGenericSkillIntent("use a skill here")).toBe(true);
      expect(mentionsGenericSkillIntent("check my skills please")).toBe(true);
    });

    it("matches Chinese 技能", () => {
      expect(mentionsGenericSkillIntent("请用技能帮我处理")).toBe(true);
    });

    it("does not match unrelated mentions like 'skillet'", () => {
      expect(mentionsGenericSkillIntent("I need a skillet for cooking")).toBe(false);
      expect(mentionsGenericSkillIntent("unskilled hands")).toBe(false);
    });
  });

  describe("buildSkillPromptFragment", () => {
    const resolved: ResolvedSkill = {
      id: "global:odps",
      name: "odps",
      description: "MaxCompute (ODPS) data query skill.",
      instructions: "Run ./run.sh query.py --sql <SQL>",
      source: "global",
    };
    const manifest: SkillManifestEntry[] = [
      {
        id: "global:odps",
        name: "odps",
        description: "MaxCompute (ODPS) data query skill.",
        source: "global",
      },
      {
        id: "global:resume-screener",
        name: "resume-screener",
        description: "Batch resume screening",
        source: "global",
      },
    ];

    it("returns empty string when nothing to render", () => {
      expect(buildSkillPromptFragment([], [])).toBe("");
    });

    it("renders the manifest alone when no skill is resolved", () => {
      const fragment = buildSkillPromptFragment([], manifest);
      expect(fragment).toContain("可用 Skills（尚未激活）");
      expect(fragment).toContain("**odps**");
      expect(fragment).toContain("**resume-screener**");
      expect(fragment).not.toContain("已激活的 Skills");
    });

    it("renders resolved full instructions plus remaining manifest without duplicates", () => {
      const fragment = buildSkillPromptFragment([resolved], manifest);
      expect(fragment).toContain("已激活的 Skills");
      expect(fragment).toContain("Run ./run.sh query.py");
      // resume-screener is in manifest but not resolved, so it must appear
      expect(fragment).toContain("resume-screener");
      // odps is already in the activated block — its manifest entry must be deduped
      const afterManifestHeader = fragment.split("可用 Skills（尚未激活）")[1] ?? "";
      expect(afterManifestHeader).not.toContain("**odps**");
    });

    it("renders the skill's absolute directory path and invocation hint when available", () => {
      const resolvedWithPath: ResolvedSkill = {
        ...resolved,
        directoryPath: "/Users/jiyuhe/.cofree/skills/odps",
      };
      const fragment = buildSkillPromptFragment([resolvedWithPath], []);
      expect(fragment).toContain("Skill 根目录（绝对路径）");
      expect(fragment).toContain("/Users/jiyuhe/.cofree/skills/odps");
      expect(fragment).toContain("以该目录为工作目录");
      expect(fragment).toContain("cd /Users/jiyuhe/.cofree/skills/odps && ./run.sh");
      expect(fragment).toContain("不在当前工作区内");
    });

    it("does not label workspace skill directories as outside the workspace", () => {
      const workspaceSkill: ResolvedSkill = {
        ...resolved,
        id: "workspace:odps",
        source: "workspace",
        directoryPath: "/repo/.cofree/skills/odps",
      };
      const fragment = buildSkillPromptFragment([workspaceSkill], []);
      expect(fragment).toContain("以该目录为工作目录");
      expect(fragment).not.toContain("不在当前工作区内");
    });

    it("omits the directory/invocation block when the skill has no filesystem path", () => {
      const fragment = buildSkillPromptFragment([resolved], []);
      expect(fragment).not.toContain("Skill 根目录");
      expect(fragment).not.toContain("不在当前工作区内");
    });
  });

  describe("fileMatchesPattern (via matchSkills activeFilePaths)", () => {
    it("matches simple extension pattern", () => {
      const skills: SkillEntry[] = [
        {
          id: "global:sql",
          name: "sql",
          description: "SQL helper",
          source: "global",
          enabled: true,
          createdAt: "2026-01-01T00:00:00.000Z",
          filePatterns: ["*.sql"],
        },
      ];
      const matched = matchSkills(skills, "unrelated query", ["db/migrations/001.sql"]);
      expect(matched).toHaveLength(1);
    });

    it("matches globstar directory pattern (**/)", () => {
      const skills: SkillEntry[] = [
        {
          id: "global:db",
          name: "db",
          description: "DB helper",
          source: "global",
          enabled: true,
          createdAt: "2026-01-01T00:00:00.000Z",
          filePatterns: ["db/**/*.sql"],
        },
      ];
      const matched = matchSkills(skills, "unrelated", ["db/migrations/001.sql"]);
      expect(matched).toHaveLength(1);
    });

    it("does not match non-matching file patterns", () => {
      const skills: SkillEntry[] = [
        {
          id: "global:sql",
          name: "sql",
          description: "SQL helper",
          source: "global",
          enabled: true,
          createdAt: "2026-01-01T00:00:00.000Z",
          filePatterns: ["*.sql"],
        },
      ];
      const matched = matchSkills(skills, "unrelated", ["src/index.ts"]);
      expect(matched).toHaveLength(0);
    });

    it("matches exact filename without glob", () => {
      const skills: SkillEntry[] = [
        {
          id: "global:makefile",
          name: "makefile",
          description: "Makefile helper",
          source: "global",
          enabled: true,
          createdAt: "2026-01-01T00:00:00.000Z",
          filePatterns: ["Makefile"],
        },
      ];
      const matched = matchSkills(skills, "unrelated", ["Makefile"]);
      expect(matched).toHaveLength(1);
    });
  });

});
