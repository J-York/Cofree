/**
 * Cofree - AI Programming Cafe
 * File: src/lib/litellm.ts
 * Description: 多协议 LLM 请求、模型拉取与响应归一化。
 */

import {
  type AppSettings,
  type VendorProtocol,
  getActiveManagedModel,
  getActiveVendor,
} from "./settingsStore";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface StreamChunkEvent {
  request_id: string;
  content: string;
  done: boolean;
  finish_reason: string | null;
}

export interface LiteLLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

export interface LiteLLMClientConfig {
  endpoint: string;
  headers: Record<string, string>;
  modelRef: string;
  protocol: VendorProtocol;
}

export interface LiteLLMHttpResponse {
  status: number;
  body: string;
  endpoint: string;
}

interface JsonSchemaResponseFormat {
  type: "json_schema";
  json_schema: {
    name: string;
    schema: Record<string, unknown>;
    strict: true;
  };
}

export interface LiteLLMToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface VendorProtocolOption {
  id: VendorProtocol;
  label: string;
  endpointLabel: string;
}

export const VENDOR_PROTOCOLS: VendorProtocolOption[] = [
  {
    id: "openai-chat-completions",
    label: "OpenAI Chat Completions",
    endpointLabel: "/chat/completions",
  },
  {
    id: "openai-responses",
    label: "OpenAI Responses",
    endpointLabel: "/responses",
  },
  {
    id: "anthropic-messages",
    label: "Anthropic Messages",
    endpointLabel: "/v1/messages",
  },
];

export function getProtocolLabel(protocol: VendorProtocol): string {
  return (
    VENDOR_PROTOCOLS.find((item) => item.id === protocol)?.label ?? protocol
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

export function formatModelRef(providerId: string, model: string): string {
  if (!providerId) {
    return model;
  }
  return `${providerId}/${model}`;
}

export function parseModelRef(modelRef: string): {
  provider: string;
  model: string;
} {
  const trimmed = modelRef.trim();
  const slashIndex = trimmed.indexOf("/");

  if (slashIndex > 0) {
    return {
      provider: trimmed.substring(0, slashIndex),
      model: trimmed.substring(slashIndex + 1),
    };
  }

  return {
    provider: "",
    model: trimmed,
  };
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/$/, "");
}

function buildProtocolEndpoints(
  baseUrl: string,
  protocol: VendorProtocol,
  resource: "models" | "invoke"
): string[] {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) {
    return [];
  }

  const suffix =
    resource === "models"
      ? "models"
      : protocol === "openai-chat-completions"
      ? "chat/completions"
      : protocol === "openai-responses"
      ? "responses"
      : "messages";

  const endpoints = [`${normalized}/${suffix}`];
  if (!normalized.endsWith("/v1")) {
    endpoints.push(`${normalized}/v1/${suffix}`);
  }

  return endpoints;
}

function createAuthHeaders(
  protocol: VendorProtocol,
  apiKey: string
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (protocol === "anthropic-messages") {
    headers["anthropic-version"] = "2023-06-01";
    if (apiKey.trim()) {
      headers["x-api-key"] = apiKey.trim();
    }
    return headers;
  }

  if (apiKey.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`;
  }

  return headers;
}

function extractModelEntries(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (
    payload &&
    typeof payload === "object" &&
    Array.isArray((payload as { data?: unknown[] }).data)
  ) {
    return (payload as { data: unknown[] }).data;
  }

  return [];
}

function extractModelId(entry: unknown): string | null {
  if (typeof entry === "string") {
    const trimmed = entry.trim();
    return trimmed || null;
  }

  if (!entry || typeof entry !== "object") {
    return null;
  }

  const record = entry as Record<string, unknown>;
  const candidates = [record.id, record.model_name, record.model, record.name];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

function extractErrorMessage(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const record = payload as Record<string, unknown>;
  if (typeof record.message === "string") {
    return record.message;
  }

  if (typeof record.error === "string") {
    return record.error;
  }

  if (record.error && typeof record.error === "object") {
    const nestedMessage = (record.error as Record<string, unknown>).message;
    if (typeof nestedMessage === "string") {
      return nestedMessage;
    }
  }

  return "";
}

export function createLiteLLMClientConfig(
  settings: AppSettings
): LiteLLMClientConfig {
  const activeVendor = getActiveVendor(settings);
  const activeModel = getActiveManagedModel(settings);
  const protocol = activeVendor?.protocol ?? "openai-chat-completions";
  const [endpoint] = buildProtocolEndpoints(
    activeVendor?.baseUrl || settings.liteLLMBaseUrl,
    protocol,
    "invoke"
  );
  const headers = createAuthHeaders(protocol, settings.apiKey);
  const modelRef = activeModel?.name || settings.model;

  return {
    endpoint,
    headers,
    modelRef,
    protocol,
  };
}

function getActiveProtocol(settings: AppSettings): VendorProtocol {
  return getActiveVendor(settings)?.protocol ?? "openai-chat-completions";
}

function getModelName(settings: AppSettings): string {
  return getActiveManagedModel(settings)?.name || settings.model;
}

async function fetchModelIdsWithProtocol(params: {
  baseUrl: string;
  apiKey: string;
  protocol: VendorProtocol;
  proxy?: AppSettings["proxy"];
}): Promise<string[]> {
  const isTauri =
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  try {
    const viaTauri = await invoke<string[]>("fetch_litellm_models", {
      baseUrl: params.baseUrl,
      apiKey: params.apiKey,
      protocol: params.protocol,
      proxy: params.proxy,
    });
    const normalized = Array.from(
      new Set(
        viaTauri
          .map((modelId) => modelId.trim())
          .filter((modelId) => Boolean(modelId))
      )
    ).sort((left, right) => left.localeCompare(right));
    if (normalized.length) {
      return normalized;
    }
  } catch (error) {
    if (isTauri) {
      throw error;
    }
  }

  const endpoints = buildProtocolEndpoints(params.baseUrl, params.protocol, "models");
  const errors: string[] = [];
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: "GET",
        headers: createAuthHeaders(params.protocol, params.apiKey),
      });
      const payload = (await response.json().catch(() => null)) as unknown;
      if (!response.ok) {
        const detail = extractErrorMessage(payload);
        throw new Error(
          detail
            ? `拉取模型失败（${response.status}）：${detail}`
            : `拉取模型失败（${response.status}）`
        );
      }
      const modelIds = Array.from(
        new Set(
          extractModelEntries(payload)
            .map(extractModelId)
            .filter((id): id is string => Boolean(id))
        )
      ).sort((left, right) => left.localeCompare(right));
      if (modelIds.length) {
        return modelIds;
      }
      throw new Error("未获取到可用模型。");
    } catch (error) {
      errors.push(String(error || "Unknown error"));
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join(" | "));
  }
  throw new Error("未获取到可用模型，请确认模型供应商配置正确。");
}

export function fetchVendorModelIds(params: {
  baseUrl: string;
  apiKey: string;
  protocol: VendorProtocol;
  proxy?: AppSettings["proxy"];
}): Promise<string[]> {
  return fetchModelIdsWithProtocol(params);
}

function toOpenAIChatMessages(messages: LiteLLMMessage[]): LiteLLMMessage[] {
  return messages;
}

function toOpenAIResponsesInput(messages: LiteLLMMessage[]): unknown[] {
  const items: unknown[] = [];

  for (const message of messages) {
    if (message.role === "system" || message.role === "user") {
      items.push({
        type: "message",
        role: message.role,
        content: [{ type: "input_text", text: message.content }],
      });
      continue;
    }

    if (message.role === "assistant") {
      if (message.content.trim()) {
        items.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: message.content }],
        });
      }
      for (const toolCall of message.tool_calls ?? []) {
        items.push({
          type: "function_call",
          call_id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        });
      }
      continue;
    }

    if (message.role === "tool" && message.tool_call_id) {
      items.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output: message.content,
      });
    }
  }

  return items;
}

function toAnthropicMessages(
  messages: LiteLLMMessage[]
): { system?: string; messages: Array<Record<string, unknown>> } {
  const systemParts: string[] = [];
  const anthropicMessages: Array<Record<string, unknown>> = [];

  for (const message of messages) {
    if (message.role === "system") {
      if (message.content.trim()) {
        systemParts.push(message.content.trim());
      }
      continue;
    }

    if (message.role === "user") {
      anthropicMessages.push({
        role: "user",
        content: [{ type: "text", text: message.content }],
      });
      continue;
    }

    if (message.role === "assistant") {
      const content: Array<Record<string, unknown>> = [];
      if (message.content.trim()) {
        content.push({ type: "text", text: message.content });
      }
      for (const toolCall of message.tool_calls ?? []) {
        let parsedInput: unknown = toolCall.function.arguments;
        try {
          parsedInput = JSON.parse(toolCall.function.arguments);
        } catch (_error) {
          parsedInput = { raw: toolCall.function.arguments };
        }
        content.push({
          type: "tool_use",
          id: toolCall.id,
          name: toolCall.function.name,
          input: parsedInput,
        });
      }
      anthropicMessages.push({
        role: "assistant",
        content,
      });
      continue;
    }

    if (message.role === "tool" && message.tool_call_id) {
      anthropicMessages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.tool_call_id,
            content: message.content,
          },
        ],
      });
    }
  }

  return {
    system: systemParts.length ? systemParts.join("\n\n") : undefined,
    messages: anthropicMessages,
  };
}

function normalizeToolChoice(
  toolChoice:
    | "auto"
    | "none"
    | { type: "function"; function: { name: string } }
    | undefined,
  protocol: VendorProtocol
): unknown {
  if (!toolChoice || toolChoice === "auto") {
    return protocol === "anthropic-messages" ? { type: "auto" } : "auto";
  }
  if (toolChoice === "none") {
    return protocol === "anthropic-messages" ? { type: "auto" } : "none";
  }
  if (protocol === "anthropic-messages") {
    return { type: "tool", name: toolChoice.function.name };
  }
  return toolChoice;
}

function createOpenAIResponsesRequestBody(
  messages: LiteLLMMessage[],
  settings: AppSettings,
  options?: {
    responseFormat?: JsonSchemaResponseFormat;
    stream?: boolean;
    temperature?: number;
    tools?: LiteLLMToolDefinition[];
    toolChoice?:
      | "auto"
      | "none"
      | { type: "function"; function: { name: string } };
  }
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: getModelName(settings),
    input: toOpenAIResponsesInput(messages),
    temperature: options?.temperature ?? 0.2,
    stream: options?.stream ?? false,
  };

  if (options?.tools?.length) {
    body.tools = options.tools.map((tool) => ({
      type: "function",
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
      strict: true,
    }));
    body.tool_choice = normalizeToolChoice(
      options.toolChoice,
      "openai-responses"
    );
  }

  if (options?.responseFormat) {
    body.text = {
      format: options.responseFormat,
    };
  }

  return body;
}

function createAnthropicRequestBody(
  messages: LiteLLMMessage[],
  settings: AppSettings,
  options?: {
    responseFormat?: JsonSchemaResponseFormat;
    stream?: boolean;
    temperature?: number;
    tools?: LiteLLMToolDefinition[];
    toolChoice?:
      | "auto"
      | "none"
      | { type: "function"; function: { name: string } };
  }
): Record<string, unknown> {
  const anthropic = toAnthropicMessages(messages);
  const body: Record<string, unknown> = {
    model: getModelName(settings),
    messages: anthropic.messages,
    max_tokens: 4096,
    temperature: options?.temperature ?? 0.2,
    stream: options?.stream ?? false,
  };

  if (anthropic.system) {
    body.system = anthropic.system;
  }

  if (options?.tools?.length) {
    body.tools = options.tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
    }));
    body.tool_choice = normalizeToolChoice(
      options.toolChoice,
      "anthropic-messages"
    );
  }

  // Anthropic Messages API 不支持 OpenAI 风格的 JSON schema/responseFormat；
  // 这里只是显式消费该参数以避免未使用变量告警。
  void options?.responseFormat;
  return body;
}

export async function postLiteLLMChatCompletions(
  settings: AppSettings,
  body: Record<string, unknown>
): Promise<LiteLLMHttpResponse> {
  const protocol = getActiveProtocol(settings);
  const baseUrl = getActiveVendor(settings)?.baseUrl || settings.liteLLMBaseUrl;
  const isTauri =
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  try {
    const viaTauri = await invoke<LiteLLMHttpResponse>("post_litellm_chat_completions", {
      baseUrl,
      apiKey: settings.apiKey,
      protocol,
      body,
      proxy: settings.proxy,
    });
    return {
      ...viaTauri,
      body: normalizeResponseBody(protocol, viaTauri.body),
    };
  } catch (error) {
    if (isTauri) {
      throw error;
    }
  }

  const errors: string[] = [];
  const endpoints = buildProtocolEndpoints(baseUrl, protocol, "invoke");
  for (let index = 0; index < endpoints.length; index += 1) {
    const endpoint = endpoints[index];
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: createAuthHeaders(protocol, settings.apiKey),
        body: JSON.stringify(body),
      });
      const rawBody = await response.text();
      if (response.status === 404 && index < endpoints.length - 1) {
        errors.push(`endpoint ${endpoint} 返回 404`);
        continue;
      }

      return {
        status: response.status,
        body: normalizeResponseBody(protocol, rawBody),
        endpoint,
      };
    } catch (error) {
      errors.push(String(error || "Unknown error"));
    }
  }

  throw new Error(errors.join(" | ") || "请求 LiteLLM 失败。");
}

export async function fetchLiteLLMModelIds(
  settings: AppSettings
): Promise<string[]> {
  const protocol = getActiveProtocol(settings);
  const baseUrl = getActiveVendor(settings)?.baseUrl || settings.liteLLMBaseUrl;
  return fetchModelIdsWithProtocol({
    baseUrl,
    apiKey: settings.apiKey,
    protocol,
    proxy: settings.proxy,
  });
}

export function createLiteLLMRequestBody(
  messages: LiteLLMMessage[],
  settings: AppSettings,
  options?: {
    responseFormat?: JsonSchemaResponseFormat;
    stream?: boolean;
    temperature?: number;
    tools?: LiteLLMToolDefinition[];
    toolChoice?:
      | "auto"
      | "none"
      | { type: "function"; function: { name: string } };
  }
): Record<string, unknown> {
  const protocol = getActiveProtocol(settings);
  const modelRef = getModelName(settings);

  if (protocol === "openai-responses") {
    return createOpenAIResponsesRequestBody(messages, settings, options);
  }

  if (protocol === "anthropic-messages") {
    return createAnthropicRequestBody(messages, settings, options);
  }

  const body: Record<string, unknown> = {
    model: modelRef,
    messages: toOpenAIChatMessages(messages),
    temperature: options?.temperature ?? 0.2,
    stream: options?.stream ?? true,
  };

  if (options?.responseFormat) {
    body.response_format = options.responseFormat;
  }

  if (options?.tools?.length) {
    body.tools = options.tools;
    body.tool_choice = options.toolChoice ?? "auto";
  }

  return body;
}

function normalizeOpenAIResponsesBody(raw: string): string {
  const payload = JSON.parse(raw) as Record<string, unknown>;
  const output = Array.isArray(payload.output) ? payload.output : [];
  const textParts: string[] = [];
  const toolCalls: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }> = [];

  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (record.type === "message" && Array.isArray(record.content)) {
      for (const block of record.content) {
        if (!block || typeof block !== "object") {
          continue;
        }
        const contentBlock = block as Record<string, unknown>;
        const text =
          typeof contentBlock.text === "string"
            ? contentBlock.text
            : typeof contentBlock.output_text === "string"
            ? contentBlock.output_text
            : "";
        if (text) {
          textParts.push(text);
        }
      }
    }

    if (record.type === "function_call") {
      toolCalls.push({
        id:
          typeof record.call_id === "string" && record.call_id.trim()
            ? record.call_id
            : `call-${toolCalls.length + 1}`,
        type: "function",
        function: {
          name: typeof record.name === "string" ? record.name : "",
          arguments:
            typeof record.arguments === "string"
              ? record.arguments
              : JSON.stringify(record.arguments ?? {}),
        },
      });
    }
  }

  if (!textParts.length && typeof payload.output_text === "string") {
    textParts.push(payload.output_text);
  }

  const usage: Record<string, unknown> = isRecord(payload.usage)
    ? payload.usage
    : {};
  return JSON.stringify({
    id: payload.id,
    choices: [
      {
        message: {
          role: "assistant",
          content: textParts.join(""),
          tool_calls: toolCalls.length ? toolCalls : undefined,
        },
      },
    ],
    usage: {
      prompt_tokens:
        typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
      completion_tokens:
        typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
      total_tokens:
        typeof usage.total_tokens === "number" ? usage.total_tokens : 0,
    },
  });
}

function normalizeAnthropicMessagesBody(raw: string): string {
  const payload = JSON.parse(raw) as Record<string, unknown>;
  const content = Array.isArray(payload.content) ? payload.content : [];
  const textParts: string[] = [];
  const toolCalls: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }> = [];

  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      textParts.push(record.text);
      continue;
    }
    if (record.type === "tool_use") {
      toolCalls.push({
        id:
          typeof record.id === "string" && record.id.trim()
            ? record.id
            : `toolu-${toolCalls.length + 1}`,
        type: "function",
        function: {
          name: typeof record.name === "string" ? record.name : "",
          arguments: JSON.stringify(record.input ?? {}),
        },
      });
    }
  }

  const usage: Record<string, unknown> = isRecord(payload.usage)
    ? payload.usage
    : {};
  return JSON.stringify({
    id: payload.id,
    choices: [
      {
        message: {
          role: "assistant",
          content: textParts.join(""),
          tool_calls: toolCalls.length ? toolCalls : undefined,
        },
        finish_reason:
          typeof payload.stop_reason === "string" ? payload.stop_reason : "stop",
      },
    ],
    usage: {
      prompt_tokens:
        typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
      completion_tokens:
        typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
      total_tokens:
        typeof usage.input_tokens === "number" &&
        typeof usage.output_tokens === "number"
          ? usage.input_tokens + usage.output_tokens
          : 0,
    },
  });
}

function normalizeResponseBody(protocol: VendorProtocol, raw: string): string {
  if (!raw.trim()) {
    return raw;
  }

  try {
    if (protocol === "openai-responses") {
      return normalizeOpenAIResponsesBody(raw);
    }
    if (protocol === "anthropic-messages") {
      return normalizeAnthropicMessagesBody(raw);
    }
  } catch (_error) {
    return raw;
  }

  return raw;
}

export async function postLiteLLMChatCompletionsStream(
  settings: AppSettings,
  body: Record<string, unknown>,
  onChunk: (content: string) => void
): Promise<LiteLLMHttpResponse> {
  const protocol = getActiveProtocol(settings);
  if (protocol !== "openai-chat-completions") {
    const response = await postLiteLLMChatCompletions(settings, {
      ...body,
      stream: false,
    });
    try {
      const payload = JSON.parse(response.body) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = payload.choices?.[0]?.message?.content ?? "";
      if (content) {
        onChunk(content);
      }
    } catch (_error) {
      // ignore parsing error and return the normalized body
    }
    return response;
  }

  const baseUrl = settings.liteLLMBaseUrl;
  const apiKey = settings.apiKey;

  const requestId = `stream-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2, 8)}`;

  // Listen for streaming events, filtering by request_id
  let unlisten: UnlistenFn | undefined;
  const listenerReady = listen<StreamChunkEvent>(
    "llm-stream-chunk",
    (event) => {
      if (
        event.payload.request_id === requestId &&
        !event.payload.done &&
        event.payload.content
      ) {
        onChunk(event.payload.content);
      }
    }
  ).then((fn) => {
    unlisten = fn;
  });

  await listenerReady;

  try {
    const response = await invoke<LiteLLMHttpResponse>(
      "post_litellm_chat_completions_stream",
      {
        baseUrl,
        apiKey,
        protocol,
        body,
        requestId,
        proxy: settings.proxy,
      }
    );
    return response;
  } finally {
    unlisten?.();
  }
}
