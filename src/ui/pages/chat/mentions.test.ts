import { describe, expect, it } from "vitest";
import {
  createFileContextAttachment,
  createFolderContextAttachment,
} from "../../../lib/contextAttachments";
import {
  buildMentionSearchPattern,
  buildDefaultMentionSuggestions,
  buildFolderSuggestionsFromFiles,
  buildRecentAttachmentSuggestions,
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
});
