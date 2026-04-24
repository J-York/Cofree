import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/tauriBridge", () => ({
  globWorkspaceFiles: vi.fn(),
  readWorkspaceFile: vi.fn(),
}));

import {
  createFileContextAttachment,
  createFolderContextAttachment,
} from "../lib/contextAttachments";
import { DEFAULT_SETTINGS } from "../lib/settingsStore";
import { globWorkspaceFiles, readWorkspaceFile } from "../lib/tauriBridge";
import { buildExplicitContextNote } from "./explicitContextService";

describe("explicitContextService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(globWorkspaceFiles).mockResolvedValue([]);
  });

  it("builds a note from explicit file attachments", async () => {
    vi.mocked(readWorkspaceFile).mockResolvedValue({
      content: "export const answer = 42;\n",
      total_lines: 20,
      start_line: 1,
      end_line: 10,
    });

    const note = await buildExplicitContextNote({
      attachments: [createFileContextAttachment("src/App.tsx")],
      settings: {
        ...DEFAULT_SETTINGS,
        workspacePath: "/repo",
      },
      ignorePatterns: ["dist/**"],
    });

    expect(readWorkspaceFile).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: "/repo",
        relativePath: "src/App.tsx",
        ignorePatterns: ["dist/**"],
      }),
    );
    expect(note).toContain("[用户显式上下文]");
    expect(note).toContain("--- src/App.tsx");
    expect(note).toContain("export const answer = 42;");
  });

  it("records unreadable files in the failure section", async () => {
    vi.mocked(readWorkspaceFile)
      .mockRejectedValueOnce(new Error("Path is ignored by project config"))
      .mockResolvedValueOnce({
        content: "body\n",
        total_lines: 3,
        start_line: 1,
        end_line: 3,
      });

    const note = await buildExplicitContextNote({
      attachments: [
        createFileContextAttachment("secret/.env"),
        createFileContextAttachment("src/main.ts"),
      ],
      settings: {
        ...DEFAULT_SETTINGS,
        workspacePath: "/repo",
      },
    });

    expect(note).toContain("[未能附加的路径]");
    expect(note).toContain("secret/.env");
    expect(note).toContain("src/main.ts");
  });

  it("builds folder context from sampled files", async () => {
    vi.mocked(globWorkspaceFiles).mockResolvedValue([
      {
        path: "src/ui/pages/chat/mentions.ts",
        size: 10,
        modified: 100,
      },
      {
        path: "src/ui/pages/chat/helpers.ts",
        size: 10,
        modified: 90,
      },
    ]);
    vi.mocked(readWorkspaceFile).mockResolvedValue({
      content: "export const helper = true;\n",
      total_lines: 10,
      start_line: 1,
      end_line: 10,
    });

    const note = await buildExplicitContextNote({
      attachments: [createFolderContextAttachment("src/ui/pages/chat")],
      settings: {
        ...DEFAULT_SETTINGS,
        workspacePath: "/repo",
      },
    });

    expect(globWorkspaceFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: "/repo",
        pattern: "src/ui/pages/chat/**/*",
      }),
    );
    expect(note).toContain("--- src/ui/pages/chat/ ---");
    expect(note).toContain("目录样本文件");
    expect(note).toContain("src/ui/pages/chat/mentions.ts");
  });

  it("injects matching path rules and lazy-loads supplemental rule files", async () => {
    vi.mocked(readWorkspaceFile).mockImplementation(async (params) => {
      if (params.relativePath === "src/ui/pages/chat/mentions.ts") {
        return {
          content: "export const mention = true;\n",
          total_lines: 10,
          start_line: 1,
          end_line: 10,
        };
      }
      if (params.relativePath === "docs/ARCHITECTURE.md") {
        return {
          content: "# Architecture\nChat UI lives under src/ui/pages/chat.\n",
          total_lines: 20,
          start_line: 1,
          end_line: 20,
        };
      }
      throw new Error(`Unexpected path: ${params.relativePath}`);
    });

    const note = await buildExplicitContextNote({
      attachments: [createFileContextAttachment("src/ui/pages/chat/mentions.ts")],
      settings: {
        ...DEFAULT_SETTINGS,
        workspacePath: "/repo",
      },
      projectConfig: {
        contextRules: [
          {
            id: "chat-ui",
            paths: ["src/ui/pages/chat/**/*"],
            instructions: "Preserve existing chat interaction patterns.",
            contextFiles: ["docs/ARCHITECTURE.md"],
          },
        ],
      },
    });

    expect(note).toContain("[匹配的项目规则]");
    expect(note).toContain("chat-ui");
    expect(note).toContain("Preserve existing chat interaction patterns.");
    expect(note).toContain("[规则补充文件]");
    expect(note).toContain("docs/ARCHITECTURE.md");
    expect(note).toContain("Chat UI lives under src/ui/pages/chat.");
  });
});
