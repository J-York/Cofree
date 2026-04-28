import { describe, expect, it } from "vitest";
import type { LiteLLMMessage } from "../lib/piAiBridge";
import {
  PINNED_SLOT_KEYS,
  dedupeStaleFileReads,
  setPinnedSlot,
} from "./loopPromptScaffolding";
import {
  createWorkingMemory,
  invalidateFileContent,
  setFileContent,
} from "./workingMemory";

const initial = (): LiteLLMMessage[] => [
  { role: "system", content: "Agent prompt" },
  { role: "system", content: "Runtime context" },
  { role: "user", content: "hello" },
];

const slotContents = (messages: LiteLLMMessage[]): string =>
  messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("|");

describe("setPinnedSlot", () => {
  it("appends a new slot at the tail, leaving the head prefix and user message untouched", () => {
    const messages = initial();
    setPinnedSlot(
      messages,
      PINNED_SLOT_KEYS.WORKING_MEMORY,
      `${PINNED_SLOT_KEYS.WORKING_MEMORY}\nfoo`,
    );

    expect(messages[0].content).toBe("Agent prompt");
    expect(messages[1].content).toBe("Runtime context");
    expect(messages[2].role).toBe("user");
    expect(messages[3].role).toBe("system");
    expect(messages[3].content.startsWith(PINNED_SLOT_KEYS.WORKING_MEMORY)).toBe(true);
  });

  it("preserves cacheable head prefix when slot content churns", () => {
    const messages = initial();
    setPinnedSlot(
      messages,
      PINNED_SLOT_KEYS.WORKING_MEMORY,
      `${PINNED_SLOT_KEYS.WORKING_MEMORY}\nv1`,
    );
    const headBefore = messages.slice(0, 3).map((m) => `${m.role}:${m.content}`).join("|");
    setPinnedSlot(
      messages,
      PINNED_SLOT_KEYS.WORKING_MEMORY,
      `${PINNED_SLOT_KEYS.WORKING_MEMORY}\nv2-different-bytes`,
    );
    const headAfter = messages.slice(0, 3).map((m) => `${m.role}:${m.content}`).join("|");
    expect(headAfter).toBe(headBefore);
  });

  it("replaces an existing slot in place rather than duplicating", () => {
    const messages = initial();
    setPinnedSlot(
      messages,
      PINNED_SLOT_KEYS.WORKING_MEMORY,
      `${PINNED_SLOT_KEYS.WORKING_MEMORY}\nv1`,
    );
    setPinnedSlot(
      messages,
      PINNED_SLOT_KEYS.WORKING_MEMORY,
      `${PINNED_SLOT_KEYS.WORKING_MEMORY}\nv2`,
    );

    const slots = messages.filter((m) =>
      m.content.startsWith(PINNED_SLOT_KEYS.WORKING_MEMORY),
    );
    expect(slots).toHaveLength(1);
    expect(slots[0].content).toContain("v2");
    expect(slots[0].content).not.toContain("v1");
  });

  it("clears a slot when content is empty", () => {
    const messages = initial();
    setPinnedSlot(
      messages,
      PINNED_SLOT_KEYS.WORKING_MEMORY,
      `${PINNED_SLOT_KEYS.WORKING_MEMORY}\nfoo`,
    );
    setPinnedSlot(messages, PINNED_SLOT_KEYS.WORKING_MEMORY, "");

    expect(
      messages.some((m) => m.content.startsWith(PINNED_SLOT_KEYS.WORKING_MEMORY)),
    ).toBe(false);
  });

  it("produces the same byte layout regardless of which slot was set first (cache-stability invariant)", () => {
    const wmContent = `${PINNED_SLOT_KEYS.WORKING_MEMORY}\nworking memory body`;
    const wsContent = `${PINNED_SLOT_KEYS.WORKSPACE_REFRESH}\nworkspace body`;

    const a = initial();
    setPinnedSlot(a, PINNED_SLOT_KEYS.WORKING_MEMORY, wmContent);
    setPinnedSlot(a, PINNED_SLOT_KEYS.WORKSPACE_REFRESH, wsContent);

    const b = initial();
    setPinnedSlot(b, PINNED_SLOT_KEYS.WORKSPACE_REFRESH, wsContent);
    setPinnedSlot(b, PINNED_SLOT_KEYS.WORKING_MEMORY, wmContent);

    expect(slotContents(a)).toBe(slotContents(b));
    // Workspace must precede working-memory per declared PINNED_SLOT_ORDER.
    const workspaceIdx = a.findIndex((m) =>
      m.content.startsWith(PINNED_SLOT_KEYS.WORKSPACE_REFRESH),
    );
    const memoryIdx = a.findIndex((m) =>
      m.content.startsWith(PINNED_SLOT_KEYS.WORKING_MEMORY),
    );
    expect(workspaceIdx).toBeLessThan(memoryIdx);
    // Both slots must sit AFTER the user message so the cacheable prefix
    // (system block + first user turn) stays byte-stable.
    const firstUserIdx = a.findIndex((m) => m.role === "user");
    expect(firstUserIdx).toBeLessThan(workspaceIdx);
  });

  it("steady-state: setting an unchanged slot is idempotent", () => {
    const messages = initial();
    const content = `${PINNED_SLOT_KEYS.WORKING_MEMORY}\nstable`;
    setPinnedSlot(messages, PINNED_SLOT_KEYS.WORKING_MEMORY, content);
    const snapshot = JSON.stringify(messages);
    setPinnedSlot(messages, PINNED_SLOT_KEYS.WORKING_MEMORY, content);
    expect(JSON.stringify(messages)).toBe(snapshot);
  });
});

describe("dedupeStaleFileReads (M3)", () => {
  function makeReadResult(path: string, body: string): LiteLLMMessage {
    return {
      role: "tool",
      tool_call_id: `call-${path}-${body.length}`,
      name: "read_file",
      content: JSON.stringify({
        ok: true,
        relative_path: path,
        total_lines: body.split("\n").length,
        showing_lines: `1-${body.split("\n").length}`,
        content_preview: body,
      }),
    };
  }

  it("rewrites earlier read_file results once content is cached, keeps the latest", () => {
    const memory = createWorkingMemory({ maxTokenBudget: 4000 });
    setFileContent(memory, "src/a.ts", "current body");

    const messages: LiteLLMMessage[] = [
      { role: "user", content: "task" },
      makeReadResult("src/a.ts", "first read body"),
      { role: "assistant", content: "intermediate" },
      makeReadResult("src/a.ts", "current body"),
    ];

    const rewrites = dedupeStaleFileReads(messages, memory);
    expect(rewrites).toBe(1);

    const first = JSON.parse(messages[1].content);
    expect(first.stale).toBe(true);
    expect(first.hint).toContain("旧版本省略");

    // The latest read is preserved.
    const latest = JSON.parse(messages[3].content);
    expect(latest.content_preview).toBe("current body");
  });

  it("rewrites EVERY copy (including the latest) when slot is invalidated", () => {
    const memory = createWorkingMemory({ maxTokenBudget: 4000 });
    setFileContent(memory, "src/a.ts", "stale body");
    invalidateFileContent(memory, "src/a.ts");

    const messages: LiteLLMMessage[] = [
      { role: "user", content: "task" },
      makeReadResult("src/a.ts", "stale body"),
      { role: "assistant", content: "intermediate" },
      makeReadResult("src/a.ts", "another stale body"),
    ];

    expect(dedupeStaleFileReads(messages, memory)).toBe(2);
    for (const idx of [1, 3]) {
      const parsed = JSON.parse(messages[idx].content);
      expect(parsed.stale).toBe(true);
      expect(parsed.hint).toContain("已被修改");
    }
  });

  it("leaves unrelated paths untouched", () => {
    const memory = createWorkingMemory({ maxTokenBudget: 4000 });
    setFileContent(memory, "src/a.ts", "a body");

    const messages: LiteLLMMessage[] = [
      makeReadResult("src/a.ts", "old a body"),
      makeReadResult("src/a.ts", "a body"),
      makeReadResult("src/b.ts", "untracked b body"),
    ];

    expect(dedupeStaleFileReads(messages, memory)).toBe(1);
    expect(JSON.parse(messages[2].content).content_preview).toBe("untracked b body");
  });

  it("is idempotent — running twice rewrites nothing further", () => {
    const memory = createWorkingMemory({ maxTokenBudget: 4000 });
    setFileContent(memory, "src/a.ts", "current");

    const messages: LiteLLMMessage[] = [
      makeReadResult("src/a.ts", "old"),
      makeReadResult("src/a.ts", "current"),
    ];

    expect(dedupeStaleFileReads(messages, memory)).toBe(1);
    expect(dedupeStaleFileReads(messages, memory)).toBe(0);
  });
});
