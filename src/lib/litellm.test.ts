import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  createLiteLLMRequestBody,
  isAnthropicModelName,
  isHighRiskToolCallingModelCombo,
  postLiteLLMChatCompletions,
  postLiteLLMChatCompletionsStream,
  type LiteLLMMessage,
} from "./litellm";
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type VendorProtocol,
} from "./settingsStore";

const BASE_MESSAGES: LiteLLMMessage[] = [{ role: "user", content: "hello" }];

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function createSettings(params: {
  protocol: VendorProtocol;
  supportsThinking: boolean;
  thinkingLevel?: AppSettings["managedModels"][number]["thinkingLevel"];
  modelName?: string;
}): AppSettings {
  const vendorId = `vendor-${params.protocol}`;
  const modelId = `model-${params.protocol}`;
  const modelName = params.modelName ?? `${params.protocol}-model`;

  return {
    ...DEFAULT_SETTINGS,
    apiKey: "",
    provider: "Vendor",
    model: modelName,
    liteLLMBaseUrl: "http://localhost:4000",
    activeVendorId: vendorId,
    activeModelId: modelId,
    vendors: [
      {
        ...DEFAULT_SETTINGS.vendors[0],
        id: vendorId,
        name: "Vendor",
        protocol: params.protocol,
        baseUrl: "http://localhost:4000",
      },
    ],
    managedModels: [
      {
        ...DEFAULT_SETTINGS.managedModels[0],
        id: modelId,
        vendorId,
        name: modelName,
        supportsThinking: params.supportsThinking,
        thinkingLevel: params.thinkingLevel ?? "medium",
      },
    ],
  };
}

describe("tool-calling risk helpers", () => {
  it("detects anthropic model names on openai-chat compatibility paths", () => {
    expect(isAnthropicModelName("claude-3-7-sonnet")).toBe(true);
    expect(isAnthropicModelName("anthropic/claude-sonnet-4-5")).toBe(true);
    expect(isAnthropicModelName("gpt-4.1")).toBe(false);
  });

  it("flags anthropic models behind openai chat completions as high risk", () => {
    const settings = createSettings({
      protocol: "openai-chat-completions",
      supportsThinking: false,
      modelName: "claude-sonnet-4-5",
    });

    expect(isHighRiskToolCallingModelCombo(settings)).toBe(true);
  });

  it("does not flag native anthropic protocol as the compatibility-path risk combo", () => {
    const settings = createSettings({
      protocol: "anthropic-messages",
      supportsThinking: false,
      modelName: "claude-sonnet-4-5",
    });

    expect(isHighRiskToolCallingModelCombo(settings)).toBe(false);
  });
});

describe("Anthropic normalization for tool-calling replies", () => {
  it("preserves tool_calls when anthropic returns a tool_use-only assistant message", async () => {
    const settings = createSettings({
      protocol: "anthropic-messages",
      supportsThinking: false,
      modelName: "claude-sonnet-4-5",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        text: async () =>
          JSON.stringify({
            id: "msg_123",
            content: [
              {
                type: "tool_use",
                id: "toolu_123",
                name: "read_file",
                input: { relative_path: "src/App.tsx" },
              },
            ],
            stop_reason: "tool_use",
            usage: {
              input_tokens: 12,
              output_tokens: 7,
            },
          }),
      }),
    );

    const response = await postLiteLLMChatCompletions(settings, {
      model: "claude-sonnet-4-5",
      messages: [],
      stream: false,
    });
    const payload = JSON.parse(response.body) as {
      choices: Array<{
        message: {
          role: string;
          content: string;
          tool_calls?: Array<{
            id: string;
            type: string;
            function: { name: string; arguments: string };
          }>;
        };
      }>;
    };

    expect(payload.choices[0]?.message.role).toBe("assistant");
    expect(payload.choices[0]?.message.content).toBe("");
    expect(payload.choices[0]?.message.tool_calls).toEqual([
      {
        id: "toolu_123",
        type: "function",
        function: {
          name: "read_file",
          arguments: JSON.stringify({ relative_path: "src/App.tsx" }),
        },
      },
    ]);

  });

});

describe("streaming tool-call events", () => {
  it("forwards tool-call deltas before the final streamed response resolves", async () => {
    const settings = createSettings({
      protocol: "openai-chat-completions",
      supportsThinking: false,
      modelName: "gpt-4.1",
    });

    let handler:
      | ((event: {
        payload: {
          request_id: string;
          content: string;
          done: boolean;
          finish_reason: string | null;
          event_type?: "text_delta" | "tool_call" | "done";
          tool_call_id?: string | null;
          tool_name?: string | null;
          tool_arguments?: string | null;
        };
      }) => void)
      | undefined;

    vi.mocked(listen).mockImplementation(async (_eventName, callback) => {
      handler = callback as typeof handler;
      return vi.fn();
    });

    vi.mocked(invoke).mockImplementation(async (_command, args) => {
      const requestId = (args as { requestId: string }).requestId;
      handler?.({
        payload: {
          request_id: requestId,
          content: "",
          done: false,
          finish_reason: null,
          event_type: "tool_call",
          tool_call_id: "call_1",
          tool_name: "propose_file_edit",
          tool_arguments: "{\"relative_path\":\"src/App.tsx\"}",
        },
      });
      handler?.({
        payload: {
          request_id: requestId,
          content: "ready",
          done: false,
          finish_reason: null,
          event_type: "text_delta",
        },
      });

      return {
        status: 200,
        endpoint: "http://localhost:4000/v1/chat/completions",
        body: JSON.stringify({
          id: "chatcmpl_stream_123",
          choices: [
            {
              message: {
                role: "assistant",
                content: "ready",
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "propose_file_edit",
                      arguments: "{\"relative_path\":\"src/App.tsx\"}",
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 8,
            total_tokens: 20,
          },
        }),
      };
    });

    const textChunks: string[] = [];
    const toolCalls: Array<{ callId: string; toolName: string; arguments: string }> = [];

    const response = await postLiteLLMChatCompletionsStream(
      settings,
      { model: "gpt-4.1", messages: [], stream: true },
      (chunk) => {
        textChunks.push(chunk);
      },
      (event) => {
        toolCalls.push(event);
      },
    );

    expect(textChunks).toEqual(["ready"]);
    expect(toolCalls).toEqual([
      {
        callId: "call_1",
        toolName: "propose_file_edit",
        arguments: "{\"relative_path\":\"src/App.tsx\"}",
      },
    ]);
    expect(vi.mocked(invoke)).toHaveBeenCalledWith(
      "post_litellm_chat_completions_stream",
      expect.objectContaining({
        body: expect.objectContaining({
          model: "gpt-4.1",
          stream: true,
          stream_options: { include_usage: true },
        }),
      }),
    );
    expect(response.status).toBe(200);
  });
});

describe("createLiteLLMRequestBody thinking integration", () => {
  it("adds reasoning effort for openai chat completions models", () => {
    const settings = createSettings({
      protocol: "openai-chat-completions",
      supportsThinking: true,
      thinkingLevel: "high",
    });

    const body = createLiteLLMRequestBody(BASE_MESSAGES, settings, { stream: false });

    expect(body.reasoning_effort).toBe("high");
  });

  it("adds reasoning config for openai responses models", () => {
    const settings = createSettings({
      protocol: "openai-responses",
      supportsThinking: true,
      thinkingLevel: "low",
    });

    const body = createLiteLLMRequestBody(BASE_MESSAGES, settings, { stream: false });

    expect(body.reasoning).toEqual({ effort: "low" });
  });

  it("uses anthropic effort mode for effort-capable anthropic models", () => {
    const settings = createSettings({
      protocol: "anthropic-messages",
      modelName: "claude-sonnet-4-6",
      supportsThinking: true,
      thinkingLevel: "medium",
    });

    const body = createLiteLLMRequestBody(BASE_MESSAGES, settings, { stream: false });

    expect(body.output_config).toEqual({ effort: "medium" });
    expect(body).not.toHaveProperty("thinking");
  });

  it("uses manual anthropic thinking for non-effort models on initial turns", () => {
    const settings = createSettings({
      protocol: "anthropic-messages",
      modelName: "claude-sonnet-4-5-20250929",
      supportsThinking: true,
      thinkingLevel: "medium",
    });

    const body = createLiteLLMRequestBody(BASE_MESSAGES, settings, {
      stream: false,
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            parameters: {
              type: "object",
              properties: { location: { type: "string" } },
            },
          },
        },
      ],
      toolChoice: "auto",
    });

    expect(body.thinking).toEqual({
      type: "enabled",
      budget_tokens: 2048,
    });
    expect(body).not.toHaveProperty("output_config");
    expect(body).not.toHaveProperty("temperature");
  });

  it("drops manual anthropic thinking during tool-loop continuations", () => {
    const settings = createSettings({
      protocol: "anthropic-messages",
      modelName: "claude-sonnet-4-5-20250929",
      supportsThinking: true,
      thinkingLevel: "high",
    });
    const toolMessages: LiteLLMMessage[] = [
      { role: "user", content: "天气如何？" },
      {
        role: "assistant",
        content: "让我查一下。",
        tool_calls: [
          {
            id: "tool-1",
            type: "function",
            function: {
              name: "get_weather",
              arguments: JSON.stringify({ location: "Paris" }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "tool-1",
        content: "25°C",
      },
    ];

    const body = createLiteLLMRequestBody(toolMessages, settings, {
      stream: false,
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            parameters: {
              type: "object",
              properties: { location: { type: "string" } },
            },
          },
        },
      ],
      toolChoice: "auto",
    });

    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("output_config");
  });

  it("re-enables manual anthropic thinking for a fresh user turn after tool use completes", () => {
    const settings = createSettings({
      protocol: "anthropic-messages",
      modelName: "claude-sonnet-4-5-20250929",
      supportsThinking: true,
      thinkingLevel: "high",
    });
    const messages: LiteLLMMessage[] = [
      { role: "user", content: "天气如何？" },
      {
        role: "assistant",
        content: "让我查一下。",
        tool_calls: [
          {
            id: "tool-1",
            type: "function",
            function: {
              name: "get_weather",
              arguments: JSON.stringify({ location: "Paris" }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "tool-1",
        content: "25°C",
      },
      { role: "assistant", content: "巴黎现在 25°C。" },
      { role: "user", content: "那明天呢？" },
    ];

    const body = createLiteLLMRequestBody(messages, settings, {
      stream: false,
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            parameters: {
              type: "object",
              properties: { location: { type: "string" } },
            },
          },
        },
      ],
      toolChoice: "auto",
    });

    expect(body.thinking).toEqual({
      type: "enabled",
      budget_tokens: 3072,
    });
  });

  it("keeps anthropic effort enabled when tool use is forced on effort-capable models", () => {
    const settings = createSettings({
      protocol: "anthropic-messages",
      modelName: "claude-opus-4-5-20251101",
      supportsThinking: true,
      thinkingLevel: "high",
    });

    const body = createLiteLLMRequestBody(BASE_MESSAGES, settings, {
      stream: false,
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            parameters: {
              type: "object",
              properties: { location: { type: "string" } },
            },
          },
        },
      ],
      toolChoice: { type: "function", function: { name: "get_weather" } },
    });

    expect(body.output_config).toEqual({ effort: "high" });
    expect(body).not.toHaveProperty("thinking");
  });

  it("omits thinking fields when the active model does not support thinking", () => {
    const chatSettings = createSettings({
      protocol: "openai-chat-completions",
      supportsThinking: false,
    });
    const responsesSettings = createSettings({
      protocol: "openai-responses",
      supportsThinking: false,
    });
    const anthropicSettings = createSettings({
      protocol: "anthropic-messages",
      modelName: "claude-sonnet-4-5-20250929",
      supportsThinking: false,
    });

    const chatBody = createLiteLLMRequestBody(BASE_MESSAGES, chatSettings, { stream: false });
    const responsesBody = createLiteLLMRequestBody(BASE_MESSAGES, responsesSettings, {
      stream: false,
    });
    const anthropicBody = createLiteLLMRequestBody(BASE_MESSAGES, anthropicSettings, {
      stream: false,
    });

    expect(chatBody).not.toHaveProperty("reasoning_effort");
    expect(responsesBody).not.toHaveProperty("reasoning");
    expect(anthropicBody).not.toHaveProperty("thinking");
    expect(anthropicBody).not.toHaveProperty("output_config");
  });
});
