import { describe, expect, it } from "vitest";

import {
  buildCofreeRcPromptFragment,
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
});