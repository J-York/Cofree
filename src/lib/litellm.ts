/**
 * Cofree - AI Programming Cafe
 * File: src/lib/litellm.ts
 * Description: 多协议 LLM 请求、模型拉取与响应归一化。
 */

import {
  type AppSettings,
  type ManagedModelThinkingLevel,
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
  event_type?: "text_delta" | "tool_call" | "done";
  tool_call_id?: string | null;
  tool_name?: string | null;
  tool_arguments?: string | null;
}

export interface StreamToolCallEvent {
  callId: string;
  toolName: string;
  arguments: string;
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

  // Anthropic 端点需要 /v1 前缀，自动补全
  // 最终格式：baseUrl/v1/messages
  let baseWithV1 = normalized;
  if (!normalized.endsWith("/v1")) {
    baseWithV1 = `${normalized}/v1`;
  }

  return [`${baseWithV1}/${suffix}`];
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
    headers["anthropic-beta"] = "prompt-caching-2024-07-31";
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

const LLM_DEBUG_PREVIEW_MAX_CHARS = 2000;
const LLM_DEBUG_RECENT_ITEMS = 6;

function hasOwnField(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function createLlmDebugId(): string {
  return `llm-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function elapsedMs(startedAt: number): number {
  const current = typeof performance !== "undefined" ? performance.now() : Date.now();
  return Math.max(0, Math.round(current - startedAt));
}

function truncateDebugText(
  value: string,
  maxLength = LLM_DEBUG_PREVIEW_MAX_CHARS
): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}…(truncated ${value.length - maxLength} chars)`;
}

function serializeDebugValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? truncateDebugText(trimmed) : null;
  }
  if (value == null) {
    return null;
  }
  try {
    return truncateDebugText(JSON.stringify(value));
  } catch (_error) {
    return truncateDebugText(String(value));
  }
}

function tryParseJson(raw: string): unknown | null {
  if (!raw.trim()) {
    return null;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (_error) {
    return null;
  }
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      values.filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0
      )
    )
  );
}

function summarizeBlockKinds(content: unknown): string[] {
  if (typeof content === "string") {
    return content.trim() ? ["text"] : ["empty"];
  }
  if (Array.isArray(content)) {
    return uniqueStrings(
      content.map((item) => {
        if (typeof item === "string") {
          return item.trim() ? "text" : "empty";
        }
        if (isRecord(item) && typeof item.type === "string") {
          return item.type;
        }
        return item == null ? null : typeof item;
      })
    );
  }
  if (isRecord(content)) {
    if (typeof content.type === "string") {
      return [content.type];
    }
    return ["object"];
  }
  return content == null ? [] : [typeof content];
}

function summarizeRoleAndBlocks(message: unknown): string | null {
  if (!isRecord(message)) {
    return null;
  }
  const role = typeof message.role === "string" ? message.role : "unknown";
  const parts = [...summarizeBlockKinds(message.content)];
  const toolCallCount = Array.isArray(message.tool_calls) ? message.tool_calls.length : 0;
  if (toolCallCount > 0) {
    parts.push(`tool_calls:${toolCallCount}`);
  }
  if (typeof message.tool_call_id === "string" && message.tool_call_id.trim()) {
    parts.push("tool_result");
  }
  return parts.length ? `${role}:${parts.join("+")}` : role;
}

function summarizeResponsesInputItem(item: unknown): string | null {
  if (!isRecord(item)) {
    return null;
  }
  const type = typeof item.type === "string" ? item.type : "";
  if (type === "message") {
    const role = typeof item.role === "string" ? item.role : "message";
    const kinds = summarizeBlockKinds(item.content);
    return kinds.length ? `${role}:${kinds.join("+")}` : role;
  }
  if (!type && typeof item.role === "string") {
    const kinds = summarizeBlockKinds(item.content);
    return kinds.length ? `${item.role}:${kinds.join("+")}` : item.role;
  }
  if (type === "function_call") {
    return "assistant:function_call";
  }
  if (type === "function_call_output") {
    return "tool:function_call_output";
  }
  return type || null;
}

function summarizeToolChoiceValue(toolChoice: unknown): string | null {
  if (typeof toolChoice === "string") {
    return toolChoice;
  }
  if (!isRecord(toolChoice)) {
    return null;
  }
  if (
    toolChoice.type === "function" &&
    isRecord(toolChoice.function) &&
    typeof toolChoice.function.name === "string"
  ) {
    return `function:${toolChoice.function.name}`;
  }
  if (typeof toolChoice.type === "string" && typeof toolChoice.name === "string") {
    return `${toolChoice.type}:${toolChoice.name}`;
  }
  if (typeof toolChoice.type === "string") {
    return toolChoice.type;
  }
  return serializeDebugValue(toolChoice);
}

function summarizeOptionalConfig(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (isRecord(value)) {
    if (typeof value.type === "string" && typeof value.budget_tokens === "number") {
      return `${value.type}:${value.budget_tokens}`;
    }
    if (typeof value.effort === "string") {
      return `effort:${value.effort}`;
    }
    if (
      typeof value.type === "string" &&
      isRecord(value.function) &&
      typeof value.function.name === "string"
    ) {
      return `${value.type}:${value.function.name}`;
    }
    if (typeof value.type === "string" && typeof value.name === "string") {
      return `${value.type}:${value.name}`;
    }
  }
  return serializeDebugValue(value);
}

function summarizeRequestMessages(
  protocol: VendorProtocol,
  body: Record<string, unknown>
): {
  messageCount: number;
  systemPresent: boolean;
  recentMessages: string[];
} {
  if (protocol === "openai-responses") {
    const input = Array.isArray(body.input) ? body.input : [];
    return {
      messageCount: input.length,
      systemPresent: input.some(
        (item) => isRecord(item) && item.type === "message" && item.role === "system"
      ),
      recentMessages: input
        .slice(-LLM_DEBUG_RECENT_ITEMS)
        .map(summarizeResponsesInputItem)
        .filter((item): item is string => Boolean(item)),
    };
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const systemPresent =
    protocol === "anthropic-messages"
      ? (typeof body.system === "string" && body.system.trim().length > 0) ||
      (Array.isArray(body.system) && body.system.length > 0)
      : messages.some((message) => isRecord(message) && message.role === "system");

  return {
    messageCount: messages.length,
    systemPresent,
    recentMessages: messages
      .slice(-LLM_DEBUG_RECENT_ITEMS)
      .map(summarizeRoleAndBlocks)
      .filter((item): item is string => Boolean(item)),
  };
}

function summarizeUsage(usage: unknown): Record<string, number> | undefined {
  if (!isRecord(usage)) {
    return undefined;
  }
  const fields: Record<string, number> = {};
  const usageFields = [
    "input_tokens",
    "output_tokens",
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
  ] as const;

  for (const field of usageFields) {
    const value = usage[field];
    if (typeof value === "number") {
      fields[field] = value;
    }
  }

  return Object.keys(fields).length > 0 ? fields : undefined;
}

function summarizeResponseBody(
  protocol: VendorProtocol,
  rawBody: string
): {
  responseId?: string;
  stopReason?: string;
  finishReason?: string;
  responseState?: string;
  outputSummary?: string[];
  toolCallCount?: number;
  usage?: Record<string, number>;
  errorMessage?: string;
  bodyPreview?: string;
  systemFingerprint?: string;
} {
  const parsed = tryParseJson(rawBody);
  if (!isRecord(parsed)) {
    return {
      bodyPreview: serializeDebugValue(rawBody) ?? undefined,
    };
  }

  const responseId = typeof parsed.id === "string" ? parsed.id : undefined;
  const usage = summarizeUsage(parsed.usage);
  const errorMessage = extractErrorMessage(parsed) || undefined;
  const systemFingerprint = typeof parsed.system_fingerprint === "string"
    ? parsed.system_fingerprint
    : undefined;

  if (protocol === "anthropic-messages") {
    const content = Array.isArray(parsed.content) ? parsed.content : [];
    const outputSummary = uniqueStrings(
      content.map((item) =>
        isRecord(item) && typeof item.type === "string" ? item.type : null
      )
    );
    const toolCallCount = content.filter(
      (item) => isRecord(item) && item.type === "tool_use"
    ).length;
    return {
      responseId,
      stopReason: typeof parsed.stop_reason === "string" ? parsed.stop_reason : undefined,
      outputSummary: outputSummary.length ? outputSummary : undefined,
      toolCallCount: toolCallCount > 0 ? toolCallCount : undefined,
      usage,
      errorMessage,
    };
  }

  if (protocol === "openai-responses") {
    const output = Array.isArray(parsed.output) ? parsed.output : [];
    const outputSummary = uniqueStrings(
      output.map((item) =>
        isRecord(item) && typeof item.type === "string" ? item.type : null
      )
    );
    const toolCallCount = output.filter(
      (item) => isRecord(item) && item.type === "function_call"
    ).length;
    return {
      responseId,
      responseState: typeof parsed.status === "string" ? parsed.status : undefined,
      outputSummary: outputSummary.length ? outputSummary : undefined,
      toolCallCount: toolCallCount > 0 ? toolCallCount : undefined,
      usage,
      errorMessage,
      systemFingerprint,
    };
  }

  const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
  const firstChoice = isRecord(choices[0]) ? choices[0] : null;
  const message = firstChoice && isRecord(firstChoice.message) ? firstChoice.message : null;
  const outputSummary = message ? summarizeBlockKinds(message.content) : [];

  return {
    responseId,
    stopReason:
      firstChoice && typeof firstChoice.stop_reason === "string"
        ? firstChoice.stop_reason
        : undefined,
    finishReason:
      firstChoice && typeof firstChoice.finish_reason === "string"
        ? firstChoice.finish_reason
        : undefined,
    outputSummary: outputSummary.length ? outputSummary : undefined,
    toolCallCount:
      message && Array.isArray(message.tool_calls) && message.tool_calls.length > 0
        ? message.tool_calls.length
        : undefined,
    usage,
    errorMessage,
    systemFingerprint,
  };
}

function summarizeErrorPreview(rawBody: string): string | undefined {
  const parsed = tryParseJson(rawBody);
  if (parsed != null) {
    return serializeDebugValue(parsed) ?? undefined;
  }
  return serializeDebugValue(rawBody) ?? undefined;
}

function getEndpointPath(endpoint: string): string {
  try {
    return new URL(endpoint).pathname || endpoint;
  } catch (_error) {
    return endpoint;
  }
}

function logLlmRequest(params: {
  requestId: string;
  transport: "tauri" | "fetch";
  protocol: VendorProtocol;
  endpointCandidates: string[];
  body: Record<string, unknown>;
}): void {
  const requestSummary = summarizeRequestMessages(params.protocol, params.body);
  const tools = Array.isArray(params.body.tools) ? params.body.tools : [];

  console.log("[LLM][Request]", {
    requestId: params.requestId,
    transport: params.transport,
    protocol: params.protocol,
    endpointCandidates: params.endpointCandidates,
    endpointPaths: params.endpointCandidates.map(getEndpointPath),
    model: typeof params.body.model === "string" ? params.body.model : undefined,
    stream: params.body.stream === true,
    hasTools: tools.length > 0,
    toolCount: tools.length,
    toolChoice: summarizeToolChoiceValue(params.body.tool_choice),
    hasToolChoice: hasOwnField(params.body, "tool_choice"),
    hasThinking: hasOwnField(params.body, "thinking"),
    thinking: summarizeOptionalConfig(params.body.thinking),
    hasReasoning: hasOwnField(params.body, "reasoning"),
    reasoning: summarizeOptionalConfig(params.body.reasoning),
    hasReasoningEffort: hasOwnField(params.body, "reasoning_effort"),
    reasoningEffort: summarizeOptionalConfig(params.body.reasoning_effort),
    hasOutputConfig: hasOwnField(params.body, "output_config"),
    outputConfig: summarizeOptionalConfig(params.body.output_config),
    hasResponseFormat:
      hasOwnField(params.body, "response_format") ||
      (isRecord(params.body.text) && hasOwnField(params.body.text, "format")),
    messageCount: requestSummary.messageCount,
    systemPresent: requestSummary.systemPresent,
    recentMessages: requestSummary.recentMessages,
  });
}

function logLlmResponse(params: {
  requestId: string;
  transport: "tauri" | "fetch";
  protocol: VendorProtocol;
  endpoint: string;
  status: number;
  durationMs: number;
  rawBody: string;
}): void {
  const responseSummary = summarizeResponseBody(params.protocol, params.rawBody);

  console.log("[LLM][Response]", {
    requestId: params.requestId,
    transport: params.transport,
    protocol: params.protocol,
    endpoint: params.endpoint,
    endpointPath: getEndpointPath(params.endpoint),
    status: params.status,
    durationMs: params.durationMs,
    responseId: responseSummary.responseId,
    stopReason: responseSummary.stopReason,
    finishReason: responseSummary.finishReason,
    responseState: responseSummary.responseState,
    outputSummary: responseSummary.outputSummary,
    toolCallCount: responseSummary.toolCallCount,
    usage: responseSummary.usage,
    systemFingerprint: responseSummary.systemFingerprint,
    bodyPreview: responseSummary.bodyPreview,
  });
}

function logLlmError(params: {
  requestId: string;
  transport: "tauri" | "fetch";
  protocol: VendorProtocol;
  endpoint?: string;
  endpointCandidates?: string[];
  status?: number;
  durationMs: number;
  rawBody?: string;
  error?: unknown;
  attempt?: number;
}): void {
  const responseSummary =
    typeof params.rawBody === "string"
      ? summarizeResponseBody(params.protocol, params.rawBody)
      : undefined;
  const errorPreview =
    typeof params.rawBody === "string"
      ? summarizeErrorPreview(params.rawBody)
      : undefined;
  const errorMessage =
    params.error instanceof Error
      ? params.error.message
      : params.error != null
        ? String(params.error)
        : responseSummary?.errorMessage;

  console.error("[LLM][Error]", {
    requestId: params.requestId,
    transport: params.transport,
    protocol: params.protocol,
    endpoint: params.endpoint,
    endpointPath: params.endpoint ? getEndpointPath(params.endpoint) : undefined,
    endpointCandidates: params.endpointCandidates,
    endpointPaths: params.endpointCandidates?.map(getEndpointPath),
    attempt: params.attempt,
    status: params.status,
    durationMs: params.durationMs,
    errorMessage: errorMessage ? truncateDebugText(errorMessage) : undefined,
    errorPreview,
    responseId: responseSummary?.responseId,
    stopReason: responseSummary?.stopReason,
    finishReason: responseSummary?.finishReason,
    responseState: responseSummary?.responseState,
    outputSummary: responseSummary?.outputSummary,
    toolCallCount: responseSummary?.toolCallCount,
    usage: responseSummary?.usage,
  });
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

export function isAnthropicModelName(modelName: string): boolean {
  const normalized = modelName.trim().toLowerCase();
  return normalized.includes("claude") || normalized.startsWith("anthropic/");
}

export function isHighRiskToolCallingModelCombo(settings: AppSettings): boolean {
  const protocol = getActiveProtocol(settings);
  const modelName = getModelName(settings);
  return (
    protocol === "openai-chat-completions" &&
    isAnthropicModelName(modelName)
  );
}

const ANTHROPIC_THINKING_BUDGET_BY_LEVEL: Record<ManagedModelThinkingLevel, number> = {
  low: 1024,
  medium: 2048,
  high: 3072,
};

function getActiveModelThinkingLevel(
  settings: AppSettings,
): ManagedModelThinkingLevel | null {
  const activeModel = getActiveManagedModel(settings);
  if (!activeModel?.supportsThinking) {
    return null;
  }
  return activeModel.thinkingLevel;
}

function isAnthropicEffortModel(modelName: string): boolean {
  const normalized = modelName.toLowerCase();
  return (
    normalized.includes("claude-opus-4-6") ||
    normalized.includes("claude-sonnet-4-6") ||
    normalized.includes("claude-opus-4-5")
  );
}

function canUseAnthropicManualThinking(
  messages: LiteLLMMessage[],
  options?: {
    tools?: LiteLLMToolDefinition[];
    toolChoice?:
    | "auto"
    | "none"
    | { type: "function"; function: { name: string } };
  },
): boolean {
  const lastModelFacingMessage = [...messages]
    .reverse()
    .find((message) => message.role !== "system");
  const continuesToolTurn =
    lastModelFacingMessage?.role === "tool" ||
    (lastModelFacingMessage?.role === "assistant" &&
      (lastModelFacingMessage.tool_calls?.length ?? 0) > 0);
  const usesForcedToolChoice =
    Boolean(options?.tools?.length) &&
    options?.toolChoice !== undefined &&
    options.toolChoice !== "auto" &&
    options.toolChoice !== "none";

  return !continuesToolTurn && !usesForcedToolChoice;
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
  // For better caching with OpenAI API, preserve message structure without transformation.
  // OpenAI's caching is based on exact prefix matching of the messages array.
  // Converting system messages to user messages breaks cache consistency.
  //
  // Note: OpenAI API officially only supports one system message at the beginning,
  // but many implementations (including proxies) accept multiple system messages.
  // We preserve the original structure to maximize cache hit rates.
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
        items.push({ role: "assistant", content: message.content });
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
): { system?: string | Array<Record<string, unknown>>; messages: Array<Record<string, unknown>> } {
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

  // Convert system prompt to cache-enabled format if present
  // Mark the system prompt for caching since it's large and repetitive
  let systemContent: string | Array<Record<string, unknown>> | undefined;
  if (systemParts.length > 0) {
    const systemText = systemParts.join("\n\n");
    // Only enable caching if system prompt is substantial (>1024 chars)
    // Anthropic charges for cached content, so only cache meaningful content
    if (systemText.length > 1024) {
      systemContent = [
        {
          type: "text",
          text: systemText,
          cache_control: { type: "ephemeral" },
        },
      ];
    } else {
      systemContent = systemText;
    }
  }

  return {
    system: systemContent,
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
    return protocol === "anthropic-messages" ? { type: "none" } : "none";
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
  const thinkingLevel = getActiveModelThinkingLevel(settings);

  if (thinkingLevel) {
    body.reasoning = { effort: thinkingLevel };
  }

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
  const modelName = getModelName(settings);
  const thinkingLevel = getActiveModelThinkingLevel(settings);
  const usesEffortMode = Boolean(thinkingLevel) && isAnthropicEffortModel(modelName);
  const usesManualThinking =
    Boolean(thinkingLevel) &&
    !usesEffortMode &&
    canUseAnthropicManualThinking(messages, options);
  const body: Record<string, unknown> = {
    model: modelName,
    messages: anthropic.messages,
    max_tokens: 4096,
    stream: options?.stream ?? false,
  };

  if (!usesManualThinking) {
    body.temperature = options?.temperature ?? 0.2;
  }

  if (anthropic.system) {
    body.system = anthropic.system;
  }

  if (usesEffortMode && thinkingLevel) {
    body.output_config = { effort: thinkingLevel };
  } else if (usesManualThinking && thinkingLevel) {
    body.thinking = {
      type: "enabled",
      budget_tokens: ANTHROPIC_THINKING_BUDGET_BY_LEVEL[thinkingLevel],
    };
  }

  if (options?.tools?.length && options.toolChoice !== "none") {
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
  const transport: "tauri" | "fetch" = isTauri ? "tauri" : "fetch";
  const endpoints = buildProtocolEndpoints(baseUrl, protocol, "invoke");
  const debugRequestId = createLlmDebugId();
  const startedAt = nowMs();

  logLlmRequest({
    requestId: debugRequestId,
    transport,
    protocol,
    endpointCandidates: endpoints,
    body,
  });

  try {
    const viaTauri = await invoke<LiteLLMHttpResponse>("post_litellm_chat_completions", {
      baseUrl,
      apiKey: settings.apiKey,
      protocol,
      body,
      proxy: settings.proxy,
    });
    const durationMs = elapsedMs(startedAt);
    if (viaTauri.status >= 200 && viaTauri.status < 300) {
      logLlmResponse({
        requestId: debugRequestId,
        transport: "tauri",
        protocol,
        endpoint: viaTauri.endpoint,
        status: viaTauri.status,
        durationMs,
        rawBody: viaTauri.body,
      });
    } else {
      logLlmError({
        requestId: debugRequestId,
        transport: "tauri",
        protocol,
        endpoint: viaTauri.endpoint,
        status: viaTauri.status,
        durationMs,
        rawBody: viaTauri.body,
      });
    }
    return {
      ...viaTauri,
      body: normalizeResponseBody(protocol, viaTauri.body),
    };
  } catch (error) {
    if (isTauri) {
      logLlmError({
        requestId: debugRequestId,
        transport: "tauri",
        protocol,
        endpointCandidates: endpoints,
        durationMs: elapsedMs(startedAt),
        error,
      });
      throw error;
    }
  }

  const errors: string[] = [];
  for (let index = 0; index < endpoints.length; index += 1) {
    const endpoint = endpoints[index];
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: createAuthHeaders(protocol, settings.apiKey),
        body: JSON.stringify(body),
      });
      const rawBody = await response.text();
      const durationMs = elapsedMs(startedAt);
      // 可重试的服务端错误：404 (endpoint not found), 500 (server error), 502 (bad gateway), 503 (service unavailable), 504 (gateway timeout), 429 (rate limit)
      const isRetriableError = [404, 500, 502, 503, 504, 429].includes(response.status);
      if (isRetriableError && index < endpoints.length - 1) {
        console.warn(`[LLM][Retry] 端点 ${endpoint} 返回 ${response.status}，尝试下一个候选端点 (${index + 1}/${endpoints.length})`);
        logLlmError({
          requestId: debugRequestId,
          transport: "fetch",
          protocol,
          endpoint,
          status: response.status,
          durationMs,
          rawBody,
          attempt: index + 1,
        });
        errors.push(`endpoint ${endpoint} 返回 ${response.status}`);
        continue;
      }

      if (response.status >= 200 && response.status < 300) {
        logLlmResponse({
          requestId: debugRequestId,
          transport: "fetch",
          protocol,
          endpoint,
          status: response.status,
          durationMs,
          rawBody,
        });
      } else {
        logLlmError({
          requestId: debugRequestId,
          transport: "fetch",
          protocol,
          endpoint,
          status: response.status,
          durationMs,
          rawBody,
          attempt: index + 1,
        });
      }

      return {
        status: response.status,
        body: normalizeResponseBody(protocol, rawBody),
        endpoint,
      };
    } catch (error) {
      logLlmError({
        requestId: debugRequestId,
        transport: "fetch",
        protocol,
        endpoint,
        durationMs: elapsedMs(startedAt),
        error,
        attempt: index + 1,
      });
      errors.push(String(error || "Unknown error"));
    }
  }

  const aggregateError = new Error(errors.join(" | ") || "请求 LiteLLM 失败。");
  logLlmError({
    requestId: debugRequestId,
    transport: "fetch",
    protocol,
    endpointCandidates: endpoints,
    durationMs: elapsedMs(startedAt),
    error: aggregateError,
  });
  throw aggregateError;
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
    seed?: number;
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
  const thinkingLevel = getActiveModelThinkingLevel(settings);

  if (thinkingLevel) {
    body.reasoning_effort = thinkingLevel;
  }

  if (options?.responseFormat) {
    body.response_format = options.responseFormat;
  }

  if (options?.tools?.length) {
    body.tools = options.tools;
    body.tool_choice = options.toolChoice ?? "auto";
  }

  // Add seed parameter for better caching and deterministic outputs
  // Helps OpenAI's caching mechanism by ensuring consistent requests
  if (options?.seed !== undefined) {
    body.seed = options.seed;
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

  // Preserve cache-related usage metrics
  const normalizedUsage: Record<string, number> = {
    prompt_tokens:
      typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
    completion_tokens:
      typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
    total_tokens:
      typeof usage.input_tokens === "number" &&
        typeof usage.output_tokens === "number"
        ? usage.input_tokens + usage.output_tokens
        : 0,
  };

  // Add cache metrics if present
  if (typeof usage.cache_creation_input_tokens === "number") {
    normalizedUsage.cache_creation_input_tokens = usage.cache_creation_input_tokens;
  }
  if (typeof usage.cache_read_input_tokens === "number") {
    normalizedUsage.cache_read_input_tokens = usage.cache_read_input_tokens;
  }

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
    usage: normalizedUsage,
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
  onChunk: (content: string) => void,
  onToolCall?: (event: StreamToolCallEvent) => void,
): Promise<LiteLLMHttpResponse> {
  const protocol = getActiveProtocol(settings);
  const baseUrl = getActiveVendor(settings)?.baseUrl || settings.liteLLMBaseUrl;
  const apiKey = settings.apiKey;
  const endpoints = buildProtocolEndpoints(baseUrl, protocol, "invoke");
  const startedAt = nowMs();

  const requestId = `stream-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2, 8)}`;
  const effectiveStreamBody: Record<string, unknown> = {
    ...body,
    stream: true,
  };
  if (protocol === "openai-chat-completions") {
    effectiveStreamBody.stream_options = { include_usage: true };
  }

  logLlmRequest({
    requestId,
    transport: "tauri",
    protocol,
    endpointCandidates: endpoints,
    body: effectiveStreamBody,
  });

  // Listen for streaming events, filtering by request_id
  let unlisten: UnlistenFn | undefined;
  const listenerReady = listen<StreamChunkEvent>(
    "llm-stream-chunk",
    (event) => {
      if (event.payload.request_id !== requestId) {
        return;
      }

      if (
        event.payload.event_type === "tool_call" &&
        event.payload.tool_call_id &&
        event.payload.tool_name
      ) {
        onToolCall?.({
          callId: event.payload.tool_call_id,
          toolName: event.payload.tool_name,
          arguments: event.payload.tool_arguments ?? "",
        });
        return;
      }

      if (!event.payload.done && event.payload.content) {
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
        body: effectiveStreamBody,
        requestId,
        proxy: settings.proxy,
      }
    );
    const durationMs = elapsedMs(startedAt);
    if (response.status >= 200 && response.status < 300) {
      logLlmResponse({
        requestId,
        transport: "tauri",
        protocol,
        endpoint: response.endpoint,
        status: response.status,
        durationMs,
        rawBody: response.body,
      });
    } else {
      logLlmError({
        requestId,
        transport: "tauri",
        protocol,
        endpoint: response.endpoint,
        status: response.status,
        durationMs,
        rawBody: response.body,
      });
    }
    return response;
  } catch (error) {
    logLlmError({
      requestId,
      transport: "tauri",
      protocol,
      endpointCandidates: endpoints,
      durationMs: elapsedMs(startedAt),
      error,
    });
    throw error;
  } finally {
    unlisten?.();
  }
}
