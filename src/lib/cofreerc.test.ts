import { describe, expect, it } from "vitest";

import {
  buildCofreeRcPromptFragment,
  convertCofreeRcSkillEntries,
  convertCofreeRcSkills,
  parseCofreeRc,
  resolveMatchingContextRules,
} from "./cofreerc";

describe("cofreerc", () => {
  it("parses contextRules and keeps bounded fields", () => {
    const config = parseCofreeRc(JSON.stringify({
      systemPrompt: "Always use pnpm",
      contextRules: [
        {
          id: "chat-ui",
          paths: ["src/ui/pages/chat/**/*"],
          instructions: "Preserve the existing chat layout patterns.",
          contextFiles: ["docs/ARCHITECTURE.md"],
        },
        {
          id: "global-testing",
          instructions: "Run targeted tests before proposing completion.",
        },
      ],
    }));

    expect(config.contextRules).toHaveLength(2);
    expect(config.contextRules?.[0].paths).toEqual(["src/ui/pages/chat/**/*"]);
    expect(config.contextRules?.[0].contextFiles).toEqual(["docs/ARCHITECTURE.md"]);
    expect(config.contextRules?.[1].instructions).toContain("targeted tests");
  });

  it("resolves matching path-scoped context rules", () => {
    const config = parseCofreeRc(JSON.stringify({
      contextRules: [
        {
          id: "chat-ui",
          paths: ["src/ui/pages/chat/**/*"],
          instructions: "Keep chat UI conventions.",
        },
        {
          id: "global",
          instructions: "Always run tests.",
        },
      ],
    }));

    const matched = resolveMatchingContextRules(config, ["src/ui/pages/chat/mentions.ts"]);
    expect(matched).toHaveLength(1);
    expect(matched[0].id).toBe("chat-ui");
  });

  it("includes only global rule instructions in the eager prompt fragment", () => {
    const config = parseCofreeRc(JSON.stringify({
      systemPrompt: "Always use pnpm",
      contextRules: [
        {
          id: "global-testing",
          instructions: "Run targeted tests before proposing completion.",
        },
        {
          id: "path-only",
          paths: ["src/**/*"],
          instructions: "Do not include this eagerly.",
        },
      ],
    }));

    const fragment = buildCofreeRcPromptFragment(config);
    expect(fragment).toContain("Always use pnpm");
    expect(fragment).toContain("global-testing");
    expect(fragment).not.toContain("Do not include this eagerly");
  });
  it("scopes converted cofreerc skill ids", () => {
    const config = parseCofreeRc(JSON.stringify({
      skills: [
        {
          id: "odps",
          name: "odps",
          description: "query maxcompute",
          filePath: "skills/odps/SKILL.md",
        },
        {
          name: "resume-screener",
          description: "筛选简历",
          instructions: "Do screening",
        },
      ],
    }));

    const converted = convertCofreeRcSkills(config, "/workspace/project");
    expect(converted[0].id).toBe("cofreerc:odps");
    expect(converted[1].id).toBe("cofreerc:skill-2");
    expect(converted[0].filePath).toBe("/workspace/project/skills/odps/SKILL.md");
  });

  it("converts cofreerc skills into registry entries", () => {
    const config = parseCofreeRc(JSON.stringify({
      skills: [
        {
          id: "resume-screener",
          name: "resume-screener",
          description: "筛选简历",
          instructions: "Do screening",
        },
      ],
    }));

    const entries = convertCofreeRcSkillEntries(config, "/workspace/project");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "cofreerc:resume-screener",
      source: "cofreerc",
      enabled: true,
      instructions: "Do screening",
    });
  });

  it("rejects traversal-like skill file paths during parse", () => {
    const config = parseCofreeRc(JSON.stringify({
      skills: [
        {
          id: "safe",
          name: "safe",
          description: "safe",
          filePath: "skills/odps/SKILL.md",
        },
        {
          id: "unsafe",
          name: "unsafe",
          description: "unsafe",
          filePath: "../secrets/SKILL.md",
        },
      ],
    }));

    expect(config.skills).toHaveLength(1);
    expect(config.skills?.[0]).toMatchObject({
      id: "safe",
      filePath: "skills/odps/SKILL.md",
    });
  });

  it("drops converted cofreerc skills whose filePath escapes workspace", () => {
    const converted = convertCofreeRcSkills({
      skills: [
        {
          id: "unsafe-only",
          name: "unsafe-only",
          description: "unsafe",
          filePath: "../../private/SKILL.md",
        },
        {
          id: "inline-fallback",
          name: "inline-fallback",
          description: "inline",
          filePath: "../private/SKILL.md",
          instructions: "inline instructions",
        },
      ],
    }, "/workspace/project");

    expect(converted).toHaveLength(1);
    expect(converted[0]).toMatchObject({
      id: "cofreerc:inline-fallback",
      filePath: undefined,
      instructions: "inline instructions",
    });
  });

});
