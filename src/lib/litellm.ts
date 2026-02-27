/**
 * Cofree - AI Programming Cafe
 * File: src/lib/litellm.ts
 * Milestone: 2
 * Task: 2.1
 * Status: Completed
 * Owner: Codex-GPT-5
 * Last Modified: 2026-02-27
 * Description: LiteLLM provider/model registry and request helpers for streaming planning.
 */

import type { AppSettings } from "./settingsStore";

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
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LiteLLMClientConfig {
  endpoint: string;
  headers: Record<string, string>;
  modelRef: string;
}

interface JsonSchemaResponseFormat {
  type: "json_schema";
  json_schema: {
    name: string;
    schema: Record<string, unknown>;
    strict: true;
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
  return `${providerId}/${model}`;
}

export function createLiteLLMClientConfig(settings: AppSettings): LiteLLMClientConfig {
  const endpoint = `${settings.liteLLMBaseUrl.replace(/\/$/, "")}/chat/completions`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };

  if (settings.apiKey.trim()) {
    headers.Authorization = `Bearer ${settings.apiKey.trim()}`;
  }

  return {
    endpoint,
    headers,
    modelRef: formatModelRef(settings.provider, settings.model)
  };
}

export function createLiteLLMRequestBody(
  messages: LiteLLMMessage[],
  settings: AppSettings,
  options?: {
    responseFormat?: JsonSchemaResponseFormat;
  }
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: formatModelRef(settings.provider, settings.model),
    messages,
    temperature: 0.2,
    stream: true
  };

  if (options?.responseFormat) {
    body.response_format = options.responseFormat;
  }

  return body;
}
