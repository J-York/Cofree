import { describe, expect, it } from "vitest";
import {
  createFileContextAttachment,
  createFolderContextAttachment,
} from "../../../lib/contextAttachments";
import type { SkillEntry } from "../../../lib/skillStore";
import {
  buildMentionSearchPattern,
  buildDefaultMentionSuggestions,
  buildFolderSuggestionsFromFiles,
  buildRecentAttachmentSuggestions,
  buildSkillMentionSuggestions,
  buildSubmittedPrompt,
  findActiveMention,
  rankMentionSuggestions,
} from "./mentions";

describe("chat mention helpers", () => {
  it("detects an active mention from the current caret position", () => {
    expect(findActiveMention("请查看 @src/App", "请查看 @src/App".length)).toEqual({
      query: "src/App",
      start: 4,
      end: 12,
    });
  });

  it("ranks basename prefix matches ahead of weaker path matches", () => {
    const ranked = rankMentionSuggestions("app", [
      {
        kind: "file",
        relativePath: "src/components/AppShell.tsx",
        displayName: "AppShell.tsx",
        size: 1,
        modified: 10,
        source: "search",
      },
      {
        kind: "file",
        relativePath: "docs/happy-path.md",
        displayName: "happy-path.md",
        size: 1,
        modified: 20,
        source: "search",
      },
      {
        kind: "file",
        relativePath: "src/App.tsx",
        displayName: "App.tsx",
        size: 1,
        modified: 5,
        source: "search",
      },
    ]);

    expect(ranked.map((entry) => entry.relativePath)).toEqual([
      "src/App.tsx",
      "src/components/AppShell.tsx",
      "docs/happy-path.md",
    ]);
  });

  it("boosts recent paths in default suggestions and supports folder targets", () => {
    const recentSuggestions = buildRecentAttachmentSuggestions([
      createFolderContextAttachment("src/ui"),
      createFileContextAttachment("src/App.tsx"),
    ]);

    const defaults = buildDefaultMentionSuggestions({
      recentSuggestions,
      gitSuggestions: [
        {
          kind: "file",
          relativePath: "src/main.tsx",
          displayName: "main.tsx",
          size: 0,
          modified: 0,
          source: "git",
        },
      ],
      rootDirectorySuggestions: [
        {
          kind: "folder",
          relativePath: "docs",
          displayName: "docs",
          size: 0,
          modified: 0,
          source: "root",
        },
      ],
      signals: {
        recentPaths: ["src/ui", "src/App.tsx"],
      },
    });

    expect(defaults.map((entry) => `${entry.kind}:${entry.relativePath}`)).toEqual([
      "folder:src/ui",
      "file:src/App.tsx",
      "file:src/main.tsx",
      "folder:docs",
    ]);
  });

  it("derives matching folder suggestions from file hits", () => {
    const folders = buildFolderSuggestionsFromFiles("chat", [
      {
        path: "src/ui/pages/chat/mentions.ts",
        size: 1,
        modified: 100,
      },
      {
        path: "src/styles/features/chat/input.css",
        size: 1,
        modified: 90,
      },
    ]);

    expect(folders.map((entry) => entry.relativePath)).toContain("src/ui/pages/chat");
    expect(folders.map((entry) => entry.relativePath)).toContain("src/styles/features/chat");
  });

  it("builds a case-insensitive glob pattern for mention search", () => {
    expect(buildMentionSearchPattern("src/App")).toBe(
      "**/*[sS][rR][cC]*[aA][pP][pP]*",
    );
  });

  it("builds a fallback prompt when only attachments are present", () => {
    const prompt = buildSubmittedPrompt("", [
      createFileContextAttachment("src/App.tsx"),
    ]);

    expect(prompt).toBe("请基于我附加的上下文文件或目录协助我。");
  });

  it("builds a fallback prompt when only skills are selected", () => {
    const prompt = buildSubmittedPrompt("", [], true);

    expect(prompt).toBe("请使用我选择的 Skills 协助我。");
  });

  it("builds skill suggestions from SkillEntry array", () => {
    const skills: SkillEntry[] = [
      {
        id: "global:odps",
        name: "ODPS",
        description: "MaxCompute data query skill",
        source: "global",
        enabled: true,
        createdAt: "",
        keywords: ["sql", "odps", "maxcompute"],
      },
      {
        id: "global:react",
        name: "React Expert",
        description: "React development patterns",
        source: "global",
        enabled: true,
        createdAt: "",
        keywords: ["react", "jsx"],
      },
      {
        id: "global:disabled",
        name: "Disabled Skill",
        description: "Should not appear",
        source: "global",
        enabled: false,
        createdAt: "",
      },
    ];

    const allSuggestions = buildSkillMentionSuggestions(skills, "");
    expect(allSuggestions).toHaveLength(2);
    expect(allSuggestions[0]!.kind).toBe("skill");
    expect(allSuggestions[0]!.skillId).toBe("global:odps");

    const filtered = buildSkillMentionSuggestions(skills, "react");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.skillId).toBe("global:react");
  });

  it("ranks skill suggestions higher than files for matching queries", () => {
    const ranked = rankMentionSuggestions("sql", [
      {
        kind: "skill",
        relativePath: "SQL Expert",
        displayName: "SQL Expert",
        modified: 0,
        size: 0,
        source: "skill",
        skillId: "global:sql",
        description: "SQL query helper",
        keywords: ["sql"],
      },
      {
        kind: "file",
        relativePath: "src/sql/queries.ts",
        displayName: "queries.ts",
        modified: 10,
        size: 1,
        source: "search",
      },
    ]);

    expect(ranked[0]!.kind).toBe("skill");
  });

  it("includes skill suggestions in default suggestions and ranks them high", () => {
    const skillSuggestions = buildSkillMentionSuggestions([
      {
        id: "global:odps",
        name: "ODPS",
        description: "ODPS query skill",
        source: "global",
        enabled: true,
        createdAt: "",
      },
    ], "");

    const defaults = buildDefaultMentionSuggestions({
      recentSuggestions: [],
      gitSuggestions: [
        {
          kind: "file",
          relativePath: "src/main.ts",
          displayName: "main.ts",
          size: 0,
          modified: 0,
          source: "git",
        },
      ],
      rootDirectorySuggestions: [],
      skillSuggestions,
      signals: {},
    });

    expect(defaults[0]!.kind).toBe("skill");
    expect(defaults[0]!.skillId).toBe("global:odps");
  });
});


  it("builds skill suggestions with source labels and preserves different skillIds for same-name skills", () => {
    const sameNameSkills: SkillEntry[] = [
      {
        id: "global:odps",
        name: "odps",
        description: "Global ODPS skill",
        source: "global",
        enabled: true,
        createdAt: "",
      },
      {
        id: "workspace:odps",
        name: "odps",
        description: "Workspace ODPS skill",
        source: "workspace",
        enabled: true,
        createdAt: "",
      },
    ];

    const suggestions = buildSkillMentionSuggestions(sameNameSkills, "");
    expect(suggestions).toHaveLength(2);
    expect(suggestions.map((s) => s.skillId)).toEqual(["global:odps", "workspace:odps"]);
    expect(suggestions[0]!.displayName).toContain("global");
    expect(suggestions[1]!.displayName).toContain("workspace");
  });

  it("deduplicates skills by skillId so same-name skills from different sources both survive", () => {
    const ranked = rankMentionSuggestions("", [
      {
        kind: "skill",
        relativePath: "odps",
        displayName: "odps (global)",
        modified: 0,
        size: 0,
        source: "skill",
        skillId: "global:odps",
        description: "Global ODPS",
        keywords: ["odps"],
      },
      {
        kind: "skill",
        relativePath: "odps",
        displayName: "odps (workspace)",
        modified: 0,
        size: 0,
        source: "skill",
        skillId: "workspace:odps",
        description: "Workspace ODPS",
        keywords: ["odps"],
      },
    ]);
    const skillIds = ranked.filter((s) => s.kind === "skill").map((s) => s.skillId);
    expect(skillIds).toEqual(["global:odps", "workspace:odps"]);
  });