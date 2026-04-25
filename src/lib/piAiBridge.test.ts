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

describe("applyAnthropicCacheAnchor (M1 prompt-cache injection)", () => {
  it("converts a string system prompt into a single text block with cache_control", () => {
    const payload: Record<string, unknown> = {
      model: "claude-sonnet-4",
      system: "You are a helpful assistant.",
      messages: [],
    };
    applyAnthropicCacheAnchor(payload);

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
    applyAnthropicCacheAnchor(payload);

    const blocks = payload.system as Array<Record<string, unknown>>;
    expect(blocks[0].cache_control).toBeUndefined();
    expect(blocks[1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("is a no-op when system is missing or empty", () => {
    const a: Record<string, unknown> = { messages: [] };
    applyAnthropicCacheAnchor(a);
    expect(a.system).toBeUndefined();

    const b: Record<string, unknown> = { system: "" };
    applyAnthropicCacheAnchor(b);
    expect(b.system).toBe("");
  });

  it("produces byte-identical output for identical system prompts (cache stability invariant)", () => {
    const a: Record<string, unknown> = { system: "stable prefix" };
    const b: Record<string, unknown> = { system: "stable prefix" };
    applyAnthropicCacheAnchor(a);
    applyAnthropicCacheAnchor(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
