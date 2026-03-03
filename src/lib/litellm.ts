/**
 * Cofree - AI Programming Cafe
 * File: src/lib/litellm.ts
 * Milestone: 2
 * Task: 2.1
 * Status: Completed
 * Owner: Codex-GPT-5
 * Last Modified: 2026-02-27
 * Description: LiteLLM provider/model registry, fetch helpers, and request config builders.
 */

import type { AppSettings } from "./settingsStore";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface StreamChunkEvent {
  request_id: string;
  content: string;
  done: boolean;
  finish_reason: string | null;
}

export interface ModelProvider {
  id: string;
  label: string;
  models: string[];
  localOnly: boolean;
}

export const MODEL_PROVIDERS: ModelProvider[] = [
  {
    id: "openai",
    label: "OpenAI",
    models: ["gpt-4o-mini", "gpt-4.1-mini", "gpt-4.1"],
    localOnly: false
  },
  {
    id: "anthropic",
    label: "Anthropic",
    models: ["claude-3-5-sonnet-latest", "claude-3-7-sonnet-latest"],
    localOnly: false
  },
  {
    id: "xai",
    label: "xAI",
    models: ["grok-2-latest", "grok-2-vision-latest"],
    localOnly: false
  },
  {
    id: "ollama",
    label: "Ollama (Local)",
    models: ["llama3.1:8b", "qwen2.5-coder:7b"],
    localOnly: true
  }
];

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

export function listProviderIds(): string[] {
  return MODEL_PROVIDERS.map((provider) => provider.id);
}

export function listModelsByProvider(providerId: string): string[] {
  const provider = MODEL_PROVIDERS.find((item) => item.id === providerId);
  return provider ? provider.models : [];
}

export function isLocalProvider(providerId: string): boolean {
  const provider = MODEL_PROVIDERS.find((item) => item.id === providerId);
  return provider?.localOnly ?? false;
}

export function defaultModelForProvider(providerId: string): string {
  const [firstModel] = listModelsByProvider(providerId);
  return firstModel ?? "";
}

export function formatModelRef(providerId: string, model: string): string {
  if (!providerId) {
    return model;
  }
  return `${providerId}/${model}`;
}

export function parseModelRef(modelRef: string): { provider: string; model: string } {
  const trimmed = modelRef.trim();
  const slashIndex = trimmed.indexOf("/");
  
  if (slashIndex > 0) {
    return {
      provider: trimmed.substring(0, slashIndex),
      model: trimmed.substring(slashIndex + 1)
    };
  }
  
  return {
    provider: "",
    model: trimmed
  };
}


function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/$/, "");
}

function buildChatCompletionEndpoints(baseUrl: string): string[] {
  const normalized = normalizeBaseUrl(baseUrl);
  const endpoints = [`${normalized}/chat/completions`];
  if (!normalized.endsWith("/v1")) {
    endpoints.push(`${normalized}/v1/chat/completions`);
  }
  return endpoints;
}

function createAuthHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };

  if (apiKey.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`;
  }

  return headers;
}

function extractModelEntries(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown[] }).data)) {
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

export function createLiteLLMClientConfig(settings: AppSettings): LiteLLMClientConfig {
  const [endpoint] = buildChatCompletionEndpoints(settings.liteLLMBaseUrl);
  const headers = createAuthHeaders(settings.apiKey);
  const modelRef = settings.provider
    ? formatModelRef(settings.provider, settings.model)
    : settings.model;

  return {
    endpoint,
    headers,
    modelRef
  };
}

export async function postLiteLLMChatCompletions(
  settings: Pick<AppSettings, "liteLLMBaseUrl" | "apiKey">,
  body: Record<string, unknown>
): Promise<LiteLLMHttpResponse> {
  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  
  try {
    return await invoke<LiteLLMHttpResponse>("post_litellm_chat_completions", {
      baseUrl: settings.liteLLMBaseUrl,
      apiKey: settings.apiKey,
      body
    });
  } catch (error) {
    // If we're in Tauri, don't fallback to browser fetch (which will fail with CORS).
    // Throw the real Rust error so the user sees the actual problem.
    if (isTauri) {
      throw error;
    }
    // Fallback to frontend fetch for non-Tauri environments.
  }

  const errors: string[] = [];
  const endpoints = buildChatCompletionEndpoints(settings.liteLLMBaseUrl);
  for (let index = 0; index < endpoints.length; index += 1) {
    const endpoint = endpoints[index];
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: createAuthHeaders(settings.apiKey),
        body: JSON.stringify(body)
      });
      const rawBody = await response.text();
      if (response.status === 404 && index < endpoints.length - 1) {
        errors.push(`endpoint ${endpoint} 返回 404`);
        continue;
      }

      return {
        status: response.status,
        body: rawBody,
        endpoint
      };
    } catch (error) {
      errors.push(String(error || "Unknown error"));
    }
  }

  throw new Error(errors.join(" | ") || "请求 LiteLLM 失败。");
}

export async function fetchLiteLLMModelIds(
  settings: Pick<AppSettings, "liteLLMBaseUrl" | "apiKey">
): Promise<string[]> {
  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  
  try {
    const viaTauri = await invoke<string[]>("fetch_litellm_models", {
      baseUrl: settings.liteLLMBaseUrl,
      apiKey: settings.apiKey
    });
    const normalized = Array.from(
      new Set(viaTauri.map((modelId) => modelId.trim()).filter((modelId) => Boolean(modelId)))
    ).sort((left, right) => left.localeCompare(right));
    if (normalized.length) {
      return normalized;
    }
  } catch (error) {
    // If we're in Tauri, don't fallback to browser fetch (which will fail with CORS).
    // Throw the real Rust error so the user sees the actual problem.
    if (isTauri) {
      throw error;
    }
    // Fallback to frontend fetch for non-Tauri environments.
  }
  const normalizedBaseUrl = normalizeBaseUrl(settings.liteLLMBaseUrl);
  const endpoints = [`${normalizedBaseUrl}/models`];
  if (!normalizedBaseUrl.endsWith("/v1")) {
    endpoints.push(`${normalizedBaseUrl}/v1/models`);
  }
  const errors: string[] = [];
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: "GET",
        headers: createAuthHeaders(settings.apiKey)
      });
      const payload = (await response.json().catch(() => null)) as unknown;
      if (!response.ok) {
        const detail = extractErrorMessage(payload);
        const message = detail
          ? `拉取模型失败（${response.status}）：${detail}`
          : `拉取模型失败（${response.status}）`;
        throw new Error(message);
      }
      const modelIds = Array.from(
        new Set(extractModelEntries(payload).map(extractModelId).filter((id): id is string => Boolean(id)))
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
  throw new Error("未获取到可用模型，请确认 LiteLLM 已正确配置。");
}

export function createLiteLLMRequestBody(
  messages: LiteLLMMessage[],
  settings: AppSettings,
  options?: {
    responseFormat?: JsonSchemaResponseFormat;
    stream?: boolean;
    temperature?: number;
    tools?: LiteLLMToolDefinition[];
    toolChoice?: "auto" | "none" | { type: "function"; function: { name: string } };
  }
): Record<string, unknown> {
  const modelRef = settings.provider
    ? formatModelRef(settings.provider, settings.model)
    : settings.model;
  const body: Record<string, unknown> = {
    model: modelRef,
    messages,
    temperature: options?.temperature ?? 0.2,
    stream: options?.stream ?? true
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

export async function postLiteLLMChatCompletionsStream(
  settings: AppSettings,
  body: Record<string, unknown>,
  onChunk: (content: string) => void,
): Promise<LiteLLMHttpResponse> {
  const baseUrl = settings.liteLLMBaseUrl;
  const apiKey = settings.apiKey;

  const requestId = `stream-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  // Listen for streaming events, filtering by request_id
  let unlisten: UnlistenFn | undefined;
  const listenerReady = listen<StreamChunkEvent>("llm-stream-chunk", (event) => {
    if (event.payload.request_id === requestId && !event.payload.done && event.payload.content) {
      onChunk(event.payload.content);
    }
  }).then((fn) => {
    unlisten = fn;
  });

  await listenerReady;

  try {
    const response = await invoke<LiteLLMHttpResponse>(
      "post_litellm_chat_completions_stream",
      {
        baseUrl,
        apiKey,
        body,
        requestId,
      }
    );
    return response;
  } finally {
    unlisten?.();
  }
}
