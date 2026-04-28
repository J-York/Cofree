import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  completeMock,
  streamMock,
  performHttpRequestMock,
  cancelHttpRequestMock,
} = vi.hoisted(() => ({
  completeMock: vi.fn(),
  streamMock: vi.fn(),
  performHttpRequestMock: vi.fn(),
  cancelHttpRequestMock: vi.fn(),
}));

vi.mock("@mariozechner/pi-ai", () => ({
  complete: completeMock,
  stream: streamMock,
  getProviders: vi.fn(() => []),
  getModels: vi.fn(() => []),
}));

vi.mock("./tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tauriBridge")>();
  return {
    ...actual,
    performHttpRequest: performHttpRequestMock,
    cancelHttpRequest: cancelHttpRequestMock,
  };
});

import {
  applyAnthropicCacheAnchor,
  applyAnthropicCacheBreakpoints,
  gatewayComplete,
  gatewayStream,
  piAiChatStream,
  type LiteLLMMessage,
} from "./piAiBridge";
import { DEFAULT_SETTINGS, type AppSettings } from "./settingsStore";

const originalFetch = globalThis.fetch;
const originalTauriInternals = (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;

function createSettings(): AppSettings {
  const cloned = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as AppSettings;
  cloned.apiKey = "test-key";
  cloned.model = "test-model";
  cloned.liteLLMBaseUrl = "https://example.com/v1";
  return cloned;
}

function createAssistantMessage(text: string) {
  return {
    stopReason: "stop",
    content: [{ type: "text", text }],
    usage: { input: 5, output: 7 },
  } as any;
}

function createMockStream(events: unknown[], finalResult: unknown) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
    result: vi.fn().mockResolvedValue(finalResult),
  } as any;
}

describe("piAiBridge tauri runtime regressions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalTauriInternals === undefined) {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    } else {
      (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = originalTauriInternals;
    }
  });

  it("maps pre-aborted signals to cancelled Rust-backed fetches in gatewayComplete", async () => {
    const settings = createSettings();
    const messages: LiteLLMMessage[] = [{ role: "user", content: "hello" }];
    const controller = new AbortController();
    controller.abort();

    performHttpRequestMock.mockResolvedValue({
      status: 200,
      status_text: "OK",
      url: "https://example.com/v1/chat/completions",
      headers: [],
      body: JSON.stringify({ ok: true }),
    });
    cancelHttpRequestMock.mockResolvedValue(true);

    completeMock.mockImplementation(async (_model: unknown, _context: unknown, options?: { signal?: AbortSignal }) => {
      await fetch("https://example.com/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
        signal: options?.signal,
      });
      return createAssistantMessage("should not resolve");
    });

    const pending = gatewayComplete(messages, settings, null, {
      signal: controller.signal,
    });

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    expect(cancelHttpRequestMock).toHaveBeenCalledTimes(1);
    const cancelledRequestId = cancelHttpRequestMock.mock.calls[0]?.[0];
    expect(typeof cancelledRequestId).toBe("string");
    expect(cancelledRequestId).toContain("pi-http-");
    expect(performHttpRequestMock).not.toHaveBeenCalled();
  });

  it("uses piStream directly for piAiChatStream in Tauri runtime", async () => {
    const onChunk = vi.fn();
    const stream = createMockStream(
      [
        { type: "text_delta", delta: "he" },
        { type: "text_delta", delta: "llo" },
      ],
      createAssistantMessage("hello"),
    );

    streamMock.mockReturnValue(stream);
    completeMock.mockResolvedValue(createAssistantMessage("fallback"));

    const model = {
      id: "model",
      name: "model",
      provider: "custom",
      api: "openai-completions",
      baseUrl: "https://example.com/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 4_096,
    } as any;

    await piAiChatStream(
      model,
      [{ role: "user", content: "hello" }],
      "test-key",
      onChunk,
    );

    expect(streamMock).toHaveBeenCalledTimes(1);
    expect(completeMock).not.toHaveBeenCalled();
    expect(onChunk).toHaveBeenNthCalledWith(1, "he");
    expect(onChunk).toHaveBeenNthCalledWith(2, "llo");
  });

  it("uses piStream directly for gatewayStream in Tauri runtime", async () => {
    const settings = createSettings();
    const messages: LiteLLMMessage[] = [{ role: "user", content: "hello" }];
    const onChunk = vi.fn();

    const nativeFetch = vi.fn(async () => new Response("ok", { status: 200 }));
    globalThis.fetch = nativeFetch as unknown as typeof fetch;
    performHttpRequestMock.mockResolvedValue({
      status: 200,
      status_text: "OK",
      url: "https://example.com/stream-check",
      headers: [],
      body: "ok",
    });

    const stream = {
      async *[Symbol.asyncIterator]() {
        await fetch("https://example.com/stream-check");
        yield { type: "text_delta", delta: "chunk" };
      },
      result: vi.fn().mockResolvedValue(createAssistantMessage("chunk")),
    } as any;

    streamMock.mockReturnValue(stream);
    completeMock.mockResolvedValue(createAssistantMessage("fallback"));

    await gatewayStream(messages, settings, null, {}, onChunk);

    expect(streamMock).toHaveBeenCalledTimes(1);
    expect(completeMock).not.toHaveBeenCalled();
    expect(nativeFetch).not.toHaveBeenCalledWith("https://example.com/stream-check");
    expect(performHttpRequestMock).toHaveBeenCalledTimes(1);
    expect(performHttpRequestMock).toHaveBeenCalledWith(expect.objectContaining({
      method: "GET",
      url: "https://example.com/stream-check",
    }));
    expect(onChunk).toHaveBeenCalledWith("chunk");
  });
});

describe("applyAnthropicCacheBreakpoints (M2 multi-breakpoint injection)", () => {
  it("converts a string system prompt into a single text block with cache_control", () => {
    const payload: Record<string, unknown> = {
      model: "claude-sonnet-4",
      system: "You are a helpful assistant.",
      messages: [],
    };
    applyAnthropicCacheBreakpoints(payload);

    expect(payload.system).toEqual([
      {
        type: "text",
        text: "You are a helpful assistant.",
        cache_control: { type: "ephemeral" },
      },
    ]);
  });

  it("attaches cache_control to the LAST block when system is already an array", () => {
    const payload: Record<string, unknown> = {
      system: [
        { type: "text", text: "Block one" },
        { type: "text", text: "Block two" },
      ],
    };
    applyAnthropicCacheBreakpoints(payload);

    const blocks = payload.system as Array<Record<string, unknown>>;
    expect(blocks[0].cache_control).toBeUndefined();
    expect(blocks[1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("is a no-op when system is missing or empty", () => {
    const a: Record<string, unknown> = { messages: [] };
    applyAnthropicCacheBreakpoints(a);
    expect(a.system).toBeUndefined();

    const b: Record<string, unknown> = { system: "" };
    applyAnthropicCacheBreakpoints(b);
    expect(b.system).toBe("");
  });

  it("produces byte-identical output for identical payloads (cache stability invariant)", () => {
    const build = (): Record<string, unknown> => ({
      system: "stable prefix",
      tools: [
        { name: "read_file", description: "", input_schema: {} },
        { name: "grep", description: "", input_schema: {} },
      ],
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
        { role: "user", content: "second" },
      ],
    });
    const a = build();
    const b = build();
    applyAnthropicCacheBreakpoints(a);
    applyAnthropicCacheBreakpoints(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("attaches cache_control to the LAST tool entry only", () => {
    const payload: Record<string, unknown> = {
      tools: [
        { name: "read_file", description: "", input_schema: {} },
        { name: "grep", description: "", input_schema: {} },
        { name: "list_files", description: "", input_schema: {} },
      ],
    };
    applyAnthropicCacheBreakpoints(payload);

    const tools = payload.tools as Array<Record<string, unknown>>;
    expect(tools[0].cache_control).toBeUndefined();
    expect(tools[1].cache_control).toBeUndefined();
    expect(tools[2].cache_control).toEqual({ type: "ephemeral" });
  });

  it("does not touch tools when the array is missing or empty", () => {
    const a: Record<string, unknown> = {};
    applyAnthropicCacheBreakpoints(a);
    expect(a.tools).toBeUndefined();

    const b: Record<string, unknown> = { tools: [] };
    applyAnthropicCacheBreakpoints(b);
    expect(b.tools).toEqual([]);
  });

  it("marks the last two messages as rolling cache anchors", () => {
    const payload: Record<string, unknown> = {
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: [{ type: "text", text: "second" }] },
        { role: "user", content: "third" },
        { role: "assistant", content: [{ type: "text", text: "fourth" }] },
      ],
    };
    applyAnthropicCacheBreakpoints(payload);

    const msgs = payload.messages as Array<Record<string, unknown>>;
    // First two messages untouched.
    expect(msgs[0].content).toBe("first");
    expect((msgs[1].content as Array<Record<string, unknown>>)[0].cache_control).toBeUndefined();

    // Penultimate (msgs[2]): string-content user message gets converted to array form.
    expect(msgs[2].content).toEqual([
      { type: "text", text: "third", cache_control: { type: "ephemeral" } },
    ]);

    // Last (msgs[3]): assistant message — cache_control attached to the final block in place.
    const lastBlocks = msgs[3].content as Array<Record<string, unknown>>;
    expect(lastBlocks[lastBlocks.length - 1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("falls back to a single message anchor when only one message exists", () => {
    const payload: Record<string, unknown> = {
      messages: [{ role: "user", content: "only message" }],
    };
    applyAnthropicCacheBreakpoints(payload);

    const msgs = payload.messages as Array<Record<string, unknown>>;
    expect(msgs[0].content).toEqual([
      { type: "text", text: "only message", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("attaches cache_control to the last block of an array-content message (e.g. tool_result)", () => {
    const payload: Record<string, unknown> = {
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tc_a", content: "first result" },
            { type: "tool_result", tool_use_id: "tc_b", content: "second result" },
          ],
        },
      ],
    };
    applyAnthropicCacheBreakpoints(payload);

    const blocks = (payload.messages as Array<Record<string, unknown>>)[0].content as Array<
      Record<string, unknown>
    >;
    expect(blocks[0].cache_control).toBeUndefined();
    expect(blocks[1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("respects the 4-breakpoint cap (tools + system + 2 messages = 4)", () => {
    const payload: Record<string, unknown> = {
      system: "sys",
      tools: [{ name: "t1", description: "", input_schema: {} }],
      messages: [
        { role: "user", content: "u1" },
        { role: "assistant", content: [{ type: "text", text: "a1" }] },
        { role: "user", content: "u2" },
      ],
    };
    applyAnthropicCacheBreakpoints(payload);

    let count = 0;
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) {
        for (const item of v) walk(item);
      } else if (v && typeof v === "object") {
        const obj = v as Record<string, unknown>;
        if (obj.cache_control && (obj.cache_control as Record<string, unknown>).type === "ephemeral") {
          count++;
        }
        for (const val of Object.values(obj)) walk(val);
      }
    };
    walk(payload);

    expect(count).toBe(4);
  });

  it("keeps the legacy applyAnthropicCacheAnchor export pointing at the new implementation", () => {
    expect(applyAnthropicCacheAnchor).toBe(applyAnthropicCacheBreakpoints);
  });
});
