import { describe, expect, it } from "vitest";

import {
  createSkillEntry,
  matchSkills,
  mergeDiscoveredSkills,
  parseSkillMarkdown,
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
