import { describe, expect, it } from "vitest";
import type { LiteLLMMessage } from "../lib/piAiBridge";
import {
  PINNED_SLOT_KEYS,
  setPinnedSlot,
} from "./loopPromptScaffolding";

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
  it("inserts a new slot after the initial system prefix and before user", () => {
    const messages = initial();
    setPinnedSlot(
      messages,
      PINNED_SLOT_KEYS.WORKING_MEMORY,
      `${PINNED_SLOT_KEYS.WORKING_MEMORY}\nfoo`,
    );

    expect(messages[0].content).toBe("Agent prompt");
    expect(messages[1].content).toBe("Runtime context");
    expect(messages[2].content.startsWith(PINNED_SLOT_KEYS.WORKING_MEMORY)).toBe(true);
    expect(messages[3].role).toBe("user");
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
