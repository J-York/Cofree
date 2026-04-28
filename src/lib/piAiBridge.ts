/**
 * Cofree - AI Programming Cafe
 * File: src/lib/piAiBridge.ts
 * Description: Adapter layer between Cofree's internal types and @mariozechner/pi-ai.
 *
 * This module translates Cofree's LiteLLMMessage / LiteLLMToolDefinition into
 * pi-ai's Context / Tool types, executes LLM calls via pi-ai's unified API,
 * and converts pi-ai's AssistantMessage back into the OpenAI-normalized
 * response format that planningService.ts expects.
 */

import {
  stream as piStream,
  complete as piComplete,
  getProviders as piGetProviders,
  getModels as piGetModels,
  type Model,
  type Api,
  type Context,
  type Tool,
  type Message,
  type AssistantMessage,
  type ToolCall,
} from "@mariozechner/pi-ai";

import {
  getActiveVendor,
  getActiveManagedModel,
  type VendorProtocol,
  type VendorConfig,
  type ManagedModel,
  type AppSettings,
  type ManagedModelThinkingLevel,
} from "./settingsStore";
import { cancelHttpRequest, performHttpRequest } from "./tauriBridge";

function resolveFetchUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (typeof URL !== "undefined" && input instanceof URL) {
    return input.toString();
  }
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.url;
  }
  return String(input);
}

function shouldBypassTauriHttpForUrl(url: string): boolean {
  return url.startsWith("ipc://");
}

function sanitizeSdkFingerprintHeaders(headers: Headers): Headers {
  const sanitized = new Headers();

  for (const [name, value] of headers.entries()) {
    const lowerName = name.toLowerCase();
    const isOpenAiSdkUserAgent =
      lowerName === "user-agent" && /^OpenAI\/JS\b/i.test(value);
    const isStainlessHeader = lowerName.startsWith("x-stainless-");

    if (isOpenAiSdkUserAgent || isStainlessHeader) {
      continue;
    }
    sanitized.append(name, value);
  }

  return sanitized;
}

function createAbortError(message = "The operation was aborted."): DOMException {
  return new DOMException(message, "AbortError");
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return String(error);
}

function isRustHttpCancellationError(error: unknown): boolean {
  const message = stringifyError(error);
  return (
    message.includes("请求已取消") ||
    /\babort(ed)?\b/i.test(message) ||
    /\bcancel(l?ed|lation)?\b/i.test(message)
  );
}

function createHttpRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `pi-http-${crypto.randomUUID()}`;
  }
  return `pi-http-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function performRustBackedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  proxy?: AppSettings["proxy"],
): Promise<Response> {
  const headers = init?.headers
    ? init.headers instanceof Headers
      ? init.headers
      : new Headers(init.headers)
    : new Headers();
  const req = new Request(input, init);
  const requestId = createHttpRequestId();

  let cancelIssued = false;
  const issueCancel = () => {
    if (cancelIssued) {
      return;
    }
    cancelIssued = true;
    void cancelHttpRequest(requestId).catch(() => {});
  };

  if (req.signal.aborted) {
    issueCancel();
    throw createAbortError();
  }

  const abortHandler = () => {
    issueCancel();
  };
  req.signal.addEventListener("abort", abortHandler, { once: true });

  try {
    const buffer = await req.arrayBuffer();
    const body =
      buffer.byteLength !== 0 ? new TextDecoder().decode(new Uint8Array(buffer)) : null;

    // Preserve browser-normalized headers like content-type when Request adds them.
    for (const [key, value] of req.headers) {
      if (!headers.get(key)) {
        headers.set(key, value);
      }
    }

    const sanitizedHeaders = sanitizeSdkFingerprintHeaders(headers);
    const response = await performHttpRequest({
      requestId,
      method: req.method,
      url: req.url,
      headers: Array.from(sanitizedHeaders.entries()),
      body,
      proxy,
    });

    if (req.signal.aborted) {
      throw createAbortError();
    }

    const res = new Response(response.body, {
      status: response.status,
      statusText: response.status_text,
    });
    Object.defineProperty(res, "url", { value: response.url });
    Object.defineProperty(res, "headers", {
      value: new Headers(response.headers),
    });
    return res;
  } catch (error) {
    if (req.signal.aborted || isRustHttpCancellationError(error)) {
      throw createAbortError();
    }
    throw error;
  } finally {
    req.signal.removeEventListener("abort", abortHandler);
  }
}

// ── Re-exported Cofree internal types ────────────────────────────────────────
// These remain unchanged so existing consumers (planningService, contextBudget,
// toolPolicy, etc.) keep compiling without modification.

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

export interface LiteLLMToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface LiteLLMHttpResponse {
  status: number;
  body: string;
  endpoint: string;
}

export interface StreamToolCallEvent {
  callId: string;
  toolName: string;
  arguments: string;
}

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

// ── Protocol / vendor helpers ────────────────────────────────────────────────

export interface VendorProtocolOption {
  id: VendorProtocol;
  label: string;
  piAiApi: string;
}

export const VENDOR_PROTOCOLS: VendorProtocolOption[] = [
  { id: "openai-chat-completions", label: "OpenAI Chat Completions", piAiApi: "openai-completions" },
  { id: "openai-responses",        label: "OpenAI Responses",        piAiApi: "openai-responses" },
  { id: "anthropic-messages",      label: "Anthropic Messages",      piAiApi: "anthropic-messages" },
];

export function getProtocolLabel(protocol: VendorProtocol): string {
  return VENDOR_PROTOCOLS.find((p) => p.id === protocol)?.label ?? protocol;
}

function mapProtocolToPiAiApi(protocol: VendorProtocol): string {
  return VENDOR_PROTOCOLS.find((p) => p.id === protocol)?.piAiApi ?? "openai-completions";
}

// ── Model construction ───────────────────────────────────────────────────────

/**
 * Normalize a vendor base URL for pi-ai consumption.
 * - OpenAI-compatible APIs (openai-completions, openai-responses, mistral):
 *   The OpenAI SDK appends `/chat/completions` to `baseURL`, so the URL must
 *   end with `/v1` (e.g. `https://api.openai.com/v1`).
 * - Anthropic / Google APIs: pi-ai handles these internally; no `/v1` suffix.
 */
function normalizeBaseUrl(rawUrl: string, piAiApi: string): string {
  let url = rawUrl.replace(/\/+$/, "").trim();
  if (url.endsWith("#")) {
    url = url.slice(0, -1).trim();
  }

  const needsV1Suffix =
    piAiApi === "openai-completions" ||
    piAiApi === "openai-responses" ||
    piAiApi === "mistral-conversations";

  if (needsV1Suffix && !url.endsWith("/v1")) {
    url = `${url}/v1`;
  }

  return url;
}

/**
 * Build a pi-ai Model object from Cofree's vendor + managed-model config.
 * This produces a "custom model" that pi-ai can use with any supported API.
 */
export function buildPiAiModel(
  vendor: VendorConfig,
  managedModel: ManagedModel,
): Model<Api> {
  const api = mapProtocolToPiAiApi(vendor.protocol);
  let baseUrl = normalizeBaseUrl(vendor.baseUrl, api);
  return {
    id: managedModel.name,
    name: managedModel.name,
    api,
    provider: vendor.name.toLowerCase().replace(/\s+/g, "-"),
    baseUrl,
    reasoning: managedModel.supportsThinking,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: managedModel.metaSettings.contextWindowTokens || 128_000,
    maxTokens: managedModel.metaSettings.maxOutputTokens || 16_384,
  } as Model<Api>;
}

// ── Message conversion: Cofree → pi-ai ───────────────────────────────────────

function buildToolNameMap(messages: LiteLLMMessage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        map.set(tc.id, tc.function.name);
      }
    }
  }
  return map;
}

export function toPiAiContext(
  messages: LiteLLMMessage[],
  tools?: LiteLLMToolDefinition[],
): Context {
  const systemParts: string[] = [];
  const piMessages: Message[] = [];
  let seenNonSystem = false;
  const toolNameMap = buildToolNameMap(messages);

  const now = Date.now();

  for (const msg of messages) {
    if (msg.role === "system") {
      if (msg.content.trim()) {
        if (!seenNonSystem) {
          systemParts.push(msg.content.trim());
        } else {
          piMessages.push({
            role: "user",
            content: `[System] ${msg.content.trim()}`,
            timestamp: now,
          } satisfies Message);
        }
      }
      continue;
    }

    seenNonSystem = true;

    if (msg.role === "user") {
      piMessages.push({ role: "user", content: msg.content, timestamp: now } satisfies Message);
      continue;
    }

    if (msg.role === "assistant") {
      const contentBlocks: (AssistantMessage["content"][number])[] = [];
      if (msg.content.trim()) {
        contentBlocks.push({ type: "text", text: msg.content });
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          let parsedArgs: Record<string, unknown> = {};
          try {
            parsedArgs = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          } catch {
            parsedArgs = { _raw: tc.function.arguments };
          }
          contentBlocks.push({
            type: "toolCall",
            id: tc.id,
            name: tc.function.name,
            arguments: parsedArgs,
          } as ToolCall);
        }
      }
      piMessages.push({
        role: "assistant",
        content: contentBlocks,
        api: "openai-completions",
        provider: "cofree-replay",
        model: "",
        stopReason: msg.tool_calls?.length ? "toolUse" : "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        timestamp: now,
      } satisfies AssistantMessage);
      continue;
    }

    if (msg.role === "tool" && msg.tool_call_id) {
      piMessages.push({
        role: "toolResult",
        toolCallId: msg.tool_call_id,
        toolName: msg.name || toolNameMap.get(msg.tool_call_id) || "unknown",
        content: [{ type: "text", text: msg.content }],
        isError: false,
        timestamp: now,
      } satisfies Message);
    }
  }

  const piTools: Tool[] | undefined = tools?.map((t) => ({
    name: t.function.name,
    description: t.function.description ?? "",
    parameters: t.function.parameters,
  })) as unknown as Tool[] | undefined;

  return {
    systemPrompt: systemParts.length ? systemParts.join("\n\n") : undefined,
    messages: piMessages,
    tools: piTools,
  };
}

// ── Response conversion: pi-ai → Cofree normalized format ────────────────────

function mapStopReason(reason: AssistantMessage["stopReason"]): string {
  switch (reason) {
    case "stop": return "stop";
    case "toolUse": return "tool_calls";
    case "length": return "length";
    case "error": return "error";
    case "aborted": return "stop";
    default: return "stop";
  }
}

/**
 * Convert a pi-ai result into an LiteLLMHttpResponse.
 * When stopReason is "error", return a proper `{ error: { message } }` body
 * so that planningService.parseErrorMessage can extract it.
 */
function resultToHttpResponse(
  result: AssistantMessage,
  model: Model<Api>,
): LiteLLMHttpResponse {
  if (result.stopReason === "error" || result.stopReason === "aborted") {
    const errMsg = result.errorMessage || `LLM request failed (${result.stopReason})`;
    console.error(`[piAiBridge] LLM error: ${errMsg}`);
    return {
      status: 500,
      body: JSON.stringify({ error: { message: errMsg } }),
      endpoint: `pi-ai://${model.provider}/${model.id}`,
    };
  }
  return {
    status: 200,
    body: assistantMessageToNormalizedBody(result),
    endpoint: `pi-ai://${model.provider}/${model.id}`,
  };
}

function assistantMessageToNormalizedBody(msg: AssistantMessage): string {
  const textParts: string[] = [];
  const toolCalls: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }> = [];

  for (const block of msg.content) {
    if (block.type === "text") {
      textParts.push(block.text);
    } else if (block.type === "toolCall") {
      const tc = block as ToolCall;
      toolCalls.push({
        id: tc.id,
        type: "function",
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        },
      });
    }
  }

  const cacheRead = msg.usage.cacheRead ?? 0;
  const cacheWrite = msg.usage.cacheWrite ?? 0;

  return JSON.stringify({
    choices: [{
      message: {
        role: "assistant",
        content: textParts.join(""),
        tool_calls: toolCalls.length ? toolCalls : undefined,
      },
      finish_reason: mapStopReason(msg.stopReason),
    }],
    usage: {
      prompt_tokens: msg.usage.input,
      completion_tokens: msg.usage.output,
      total_tokens: msg.usage.input + msg.usage.output,
      // Surface cache token counts in both vendor-native shapes so downstream
      // audit (auditLog.ts) can read either without protocol-specific code.
      cache_creation_input_tokens: cacheWrite,
      cache_read_input_tokens: cacheRead,
      prompt_tokens_details: { cached_tokens: cacheRead },
    },
  });
}


function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && Boolean((window as unknown as Record<string, unknown>).__TAURI_INTERNALS__);
}

async function withTauriHttpFetch<T>(
  operation: () => Promise<T>,
  proxy?: AppSettings["proxy"],
): Promise<T> {
  if (!isTauriRuntime()) {
    return operation();
  }

  const originalFetch = globalThis.fetch;
  const tauriFetch: typeof fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = resolveFetchUrl(input);
    const bypassTauriHttp = shouldBypassTauriHttpForUrl(url);
    if (bypassTauriHttp && typeof originalFetch === "function") {
      return originalFetch.bind(globalThis)(input, init);
    }
    return performRustBackedFetch(input, init, proxy);
  }) as typeof fetch;

  try {
    globalThis.fetch = tauriFetch;
    return await operation();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ── Core LLM execution ──────────────────────────────────────────────────────

export async function piAiChatComplete(
  model: Model<Api>,
  messages: LiteLLMMessage[],
  apiKey: string,
  options?: {
    tools?: LiteLLMToolDefinition[];
    toolChoice?: "auto" | "none" | { type: "function"; function: { name: string } };
    temperature?: number;
    signal?: AbortSignal;
  },
): Promise<LiteLLMHttpResponse> {
  const context = toPiAiContext(messages, options?.tools);

  try {
    const result = await withTauriHttpFetch(() => piComplete(model, context, {
      apiKey,
      signal: options?.signal,
    }));

    return resultToHttpResponse(result, model);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[piAiBridge] piAiChatComplete threw: ${errorMsg}`);
    return {
      status: 500,
      body: JSON.stringify({ error: { message: errorMsg } }),
      endpoint: `pi-ai://${model.provider}/${model.id}`,
    };
  }
}

export async function piAiChatStream(
  model: Model<Api>,
  messages: LiteLLMMessage[],
  apiKey: string,
  onChunk: (content: string) => void,
  onToolCall?: (event: StreamToolCallEvent) => void,
  options?: {
    tools?: LiteLLMToolDefinition[];
    toolChoice?: "auto" | "none" | { type: "function"; function: { name: string } };
    temperature?: number;
    signal?: AbortSignal;
  },
): Promise<LiteLLMHttpResponse> {
  const context = toPiAiContext(messages, options?.tools);

  try {
    const s = piStream(model, context, {
      apiKey,
      signal: options?.signal,
    });

    for await (const event of s) {
      switch (event.type) {
        case "text_delta":
          onChunk(event.delta);
          break;
        case "toolcall_end": {
          const tc = event.toolCall;
          onToolCall?.({
            callId: tc.id,
            toolName: tc.name,
            arguments: JSON.stringify(tc.arguments),
          });
          break;
        }
      }
    }

    const result = await s.result();
    return resultToHttpResponse(result, model);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[piAiBridge] piAiChatStream threw: ${errorMsg}`);
    return {
      status: 500,
      body: JSON.stringify({ error: { message: errorMsg } }),
      endpoint: `pi-ai://${model.provider}/${model.id}`,
    };
  }
}

// ── Model discovery ──────────────────────────────────────────────────────────

export function getPiAiProviders(): string[] {
  return piGetProviders();
}

export function getPiAiModels(provider: string): Array<{ id: string; name: string; contextWindow: number; reasoning: boolean }> {
  try {
    const models = piGetModels(provider as Parameters<typeof piGetModels>[0]);
    return models.map((m) => ({
      id: m.id,
      name: m.name,
      contextWindow: m.contextWindow,
      reasoning: m.reasoning,
    }));
  } catch {
    return [];
  }
}

// ── Legacy format helpers (used by ModelTab, SettingsPage) ────────────────────

export function formatModelRef(providerId: string, model: string): string {
  return providerId ? `${providerId}/${model}` : model;
}

export function parseModelRef(modelRef: string): { provider: string; model: string } {
  const trimmed = modelRef.trim();
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex > 0) {
    return {
      provider: trimmed.substring(0, slashIndex),
      model: trimmed.substring(slashIndex + 1),
    };
  }
  return { provider: "", model: trimmed };
}

/**
 * Fetch model IDs for a vendor. For vendors that correspond to a known pi-ai
 * provider we return models from the in-memory registry (instant). Otherwise
 * we fall back to an HTTP fetch via the Tauri `fetch_litellm_models` command
 * for backwards compatibility with self-hosted LiteLLM proxies.
 */
export async function fetchVendorModelIds(params: {
  baseUrl: string;
  apiKey: string;
  protocol: VendorProtocol;
  piAiProvider?: string;
  proxy?: unknown;
}): Promise<string[]> {
  if (params.piAiProvider) {
    const models = getPiAiModels(params.piAiProvider);
    if (models.length) {
      return models.map((m) => m.id);
    }
  }

  // Fallback: HTTP fetch for custom / LiteLLM proxy endpoints
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    const ids = await invoke<string[]>("fetch_litellm_models", {
      baseUrl: params.baseUrl,
      apiKey: params.apiKey,
      protocol: params.protocol,
      proxy: params.proxy,
    });
    return Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean))).sort();
  } catch (error) {
    throw new Error(`拉取模型失败: ${error}`);
  }
}

// ── LiteLLMClientConfig compat (used by SettingsPage UI) ─────────────────────

export interface LiteLLMClientConfig {
  endpoint: string;
  headers: Record<string, string>;
  modelRef: string;
  protocol: VendorProtocol;
}

export function createLiteLLMClientConfig(settings: AppSettings): LiteLLMClientConfig {
  const activeVendor = getActiveVendor(settings);
  const activeModel = getActiveManagedModel(settings);
  const protocol = activeVendor?.protocol ?? "openai-chat-completions";
  const modelRef = activeModel?.name || settings.model;
  const baseUrl = activeVendor?.baseUrl || settings.liteLLMBaseUrl;

  return {
    endpoint: `${baseUrl.replace(/\/+$/, "")} (via pi-ai)`,
    headers: {},
    modelRef,
    protocol,
  };
}

// ── Gateway-level wrappers ───────────────────────────────────────────────────
// These replace the two-step "build body → post body" pattern. They accept the
// same high-level inputs that planningService.ts already has (messages, settings,
// runtime, options) and internally route through pi-ai.

import type { ResolvedAgentRuntime } from "../agents/types";

function resolveModelFromSettings(
  settings: AppSettings,
  runtime: ResolvedAgentRuntime | null,
): { model: Model<Api>; apiKey: string; protocol: VendorProtocol } {
  const effectiveVendorId = runtime?.vendorId || settings.activeVendorId;
  const effectiveModelId = runtime?.modelId || settings.activeModelId;

  const vendor = effectiveVendorId
    ? settings.vendors.find((v) => v.id === effectiveVendorId)
    : getActiveVendor(settings);
  const managedModel = effectiveModelId
    ? settings.managedModels.find((m) => m.id === effectiveModelId)
    : getActiveManagedModel(settings);

  const protocol = (vendor?.protocol || runtime?.vendorProtocol || "openai-chat-completions") as VendorProtocol;
  const apiKey = runtime?.apiKey || settings.apiKey;

  if (vendor && managedModel) {
    return { model: buildPiAiModel(vendor, managedModel), apiKey, protocol };
  }

  const modelName = runtime?.modelRef || settings.model;
  const rawBaseUrl = runtime?.baseUrl || vendor?.baseUrl || settings.liteLLMBaseUrl;
  const api = mapProtocolToPiAiApi(protocol);

  return {
    model: {
      id: modelName,
      name: modelName,
      api,
      provider: "custom",
      baseUrl: normalizeBaseUrl(rawBaseUrl, api),
      reasoning: false,
      input: ["text"] as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_384,
    } as Model<Api>,
    apiKey,
    protocol,
  };
}

const THINKING_LEVEL_MAP: Record<ManagedModelThinkingLevel, string> = {
  low: "low",
  medium: "medium",
  high: "high",
};

function resolveManagedModelForRuntime(
  settings: AppSettings,
  runtime: ResolvedAgentRuntime | null,
): ManagedModel | null {
  const effectiveModelId = runtime?.modelId || settings.activeModelId;
  return (
    (effectiveModelId
      ? settings.managedModels.find((m) => m.id === effectiveModelId)
      : getActiveManagedModel(settings)) ?? null
  );
}

function resolveThinkingLevel(
  settings: AppSettings,
  runtime: ResolvedAgentRuntime | null,
): string | undefined {
  const managedModel = resolveManagedModelForRuntime(settings, runtime);
  if (!managedModel?.supportsThinking) return undefined;
  return THINKING_LEVEL_MAP[managedModel.thinkingLevel] ?? undefined;
}

function resolveEffectiveTemperature(
  settings: AppSettings,
  runtime: ResolvedAgentRuntime | null,
  overrideTemperature?: number,
): number | undefined {
  if (overrideTemperature !== undefined) {
    return overrideTemperature;
  }
  const managedModel = resolveManagedModelForRuntime(settings, runtime);
  return managedModel?.metaSettings.temperature ?? undefined;
}

function resolveEffectiveMaxTokens(
  settings: AppSettings,
  runtime: ResolvedAgentRuntime | null,
): number | undefined {
  const managedModel = resolveManagedModelForRuntime(settings, runtime);
  const maxTokens = managedModel?.metaSettings.maxOutputTokens ?? 0;
  return maxTokens > 0 ? maxTokens : undefined;
}

const EPHEMERAL_CACHE: Readonly<{ type: "ephemeral" }> = Object.freeze({ type: "ephemeral" });

function setEphemeralCacheControl(target: Record<string, unknown>): void {
  target.cache_control = { type: "ephemeral" };
}

function markLastTool(tools: unknown): boolean {
  if (!Array.isArray(tools) || tools.length === 0) return false;
  const last = tools[tools.length - 1];
  if (typeof last !== "object" || last === null) return false;
  setEphemeralCacheControl(last as Record<string, unknown>);
  return true;
}

function markSystem(payload: Record<string, unknown>): boolean {
  const system = payload.system;
  if (system == null || system === "") return false;
  if (typeof system === "string") {
    payload.system = [{ type: "text", text: system, cache_control: { ...EPHEMERAL_CACHE } }];
    return true;
  }
  if (Array.isArray(system) && system.length > 0) {
    const last = system[system.length - 1];
    if (typeof last === "object" && last !== null) {
      setEphemeralCacheControl(last as Record<string, unknown>);
      return true;
    }
  }
  return false;
}


/**
 * Inject Anthropic prompt-cache breakpoints.
 *
 * Anthropic supports up to 4 `cache_control` breakpoints per request; each
 * one marks "cache the prefix up to and including this point". A future
 * request whose prefix matches up to that point reads cached input tokens
 * (90% discount). This function spends the budget on STABLE positions only:
 *
 *   1. tools (last entry)         — tool schemas are large and rarely change
 *   2. system (last text block)   — system prompt rarely changes
 *
 * Tail message breakpoints (messages[len-1], messages[len-2]) were REMOVED
 * because intermediate context notes and tool results make the message tail
 * unstable across turns — those breakpoints never hit cache. Only the
 * prefix (system + tools) is byte-stable enough to benefit from caching.
 *
 * pi-ai's anthropic adapter may inject additional cache_control markers
 * automatically when `cacheRetention !== "none"` (default "short"). Our
 * markers are idempotent — same `{type:"ephemeral"}` value — and provide
 * defense-in-depth.
 *
 * OpenAI uses automatic prefix caching (no explicit markers required); the
 * byte-stable head prefix is all it needs.
 */
export function applyAnthropicCacheBreakpoints(payload: Record<string, unknown>): void {
  const MAX_BREAKPOINTS = 4;
  let used = 0;

  // Only mark stable prefix positions: tools and system.
  // Message-tail breakpoints removed — they change every turn and never hit cache.
  if (used < MAX_BREAKPOINTS && markLastTool(payload.tools)) used++;
  if (used < MAX_BREAKPOINTS && markSystem(payload)) used++;
}

/** @deprecated Use {@link applyAnthropicCacheBreakpoints}. Kept for callers that imported the M1 name. */
export const applyAnthropicCacheAnchor = applyAnthropicCacheBreakpoints;

function normalizeToolChoiceForProtocol(
  protocol: VendorProtocol,
  toolChoice: GatewayRequestOptions["toolChoice"],
): unknown {
  if (toolChoice === undefined) {
    return undefined;
  }
  if (protocol !== "anthropic-messages") {
    return toolChoice;
  }
  if (toolChoice === "auto") {
    return { type: "auto" };
  }
  if (toolChoice === "none") {
    return { type: "none" };
  }
  return typeof toolChoice === "object"
    ? { type: "tool", name: toolChoice.function.name }
    : { type: "auto" };
}

export interface GatewayRequestOptions {
  stream?: boolean;
  temperature?: number;
  tools?: LiteLLMToolDefinition[];
  toolChoice?: "auto" | "none" | { type: "function"; function: { name: string } };
  signal?: AbortSignal;
  /**
   * Stable session identifier forwarded to providers as `prompt_cache_key`.
   * For OpenAI Responses API (`openai-responses`), pi-ai turns this into the
   * `prompt_cache_key` request field, which pins the request to a specific
   * cache shard so identical prefixes hit the same cache. Without it, OpenAI
   * routes via default hashing and same-prefix requests can land on different
   * shards — the dominant cause of low hit rates in multi-instance gateways.
   * Chat-Completions API ignores this (no API support).
   */
  sessionId?: string;
}

/**
 * Non-streaming LLM call via pi-ai gateway.
 * Replaces: createGatewayRequestBody() + postLiteLLMChatCompletions()
 */
export async function gatewayComplete(
  messages: LiteLLMMessage[],
  settings: AppSettings,
  runtime: ResolvedAgentRuntime | null,
  options?: GatewayRequestOptions,
): Promise<LiteLLMHttpResponse> {
  const { model, apiKey, protocol } = resolveModelFromSettings(settings, runtime);
  const hasTools = (options?.tools?.length ?? 0) > 0;
  const effectiveTemp = resolveEffectiveTemperature(settings, runtime, options?.temperature);
  const effectiveMaxTokens = resolveEffectiveMaxTokens(settings, runtime);
  const effectiveToolChoice = options?.toolChoice;
  const normalizedToolChoice = hasTools
    ? normalizeToolChoiceForProtocol(protocol, effectiveToolChoice)
    : undefined;
  const thinking = resolveThinkingLevel(settings, runtime);

  const context = toPiAiContext(messages, hasTools ? options?.tools : undefined);

  try {
    const result = await withTauriHttpFetch(() => piComplete(model, context, {
      apiKey,
      temperature: effectiveTemp,
      maxTokens: effectiveMaxTokens,
      signal: options?.signal,
      sessionId: options?.sessionId,
      reasoning: thinking as Parameters<typeof piComplete>[2] extends { reasoning?: infer R } ? R : never,
      onPayload: (payload: unknown) => {
        if (payload && typeof payload === "object") {
          const p = payload as Record<string, unknown>;
          if (normalizedToolChoice !== undefined && hasTools) {
            p.tool_choice = normalizedToolChoice;
          }
          if (protocol === "anthropic-messages") {
            applyAnthropicCacheBreakpoints(p);
          }
        }
        return undefined;
      },
    }), settings.proxy);
    return resultToHttpResponse(result, model);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    const errorMsg = error instanceof Error ? error.message : String(error);

    console.error(`[piAiBridge] gatewayComplete threw: ${errorMsg}`);
    return {
      status: 500,
      body: JSON.stringify({ error: { message: errorMsg } }),
      endpoint: `pi-ai://${model.provider}/${model.id}`,
    };
  }
}

/**
 * Streaming LLM call via pi-ai gateway.
 * Replaces: createGatewayRequestBody() + postLiteLLMChatCompletionsStream()
 */
export async function gatewayStream(
  messages: LiteLLMMessage[],
  settings: AppSettings,
  runtime: ResolvedAgentRuntime | null,
  options: GatewayRequestOptions | undefined,
  onChunk: (content: string) => void,
  onToolCall?: (event: StreamToolCallEvent) => void,
): Promise<LiteLLMHttpResponse> {
  const { model, apiKey, protocol } = resolveModelFromSettings(settings, runtime);
  const hasTools = (options?.tools?.length ?? 0) > 0;
  const effectiveTemp = resolveEffectiveTemperature(settings, runtime, options?.temperature);
  const effectiveMaxTokens = resolveEffectiveMaxTokens(settings, runtime);
  const effectiveToolChoice = options?.toolChoice;
  const normalizedToolChoice = hasTools
    ? normalizeToolChoiceForProtocol(protocol, effectiveToolChoice)
    : undefined;
  const thinking = resolveThinkingLevel(settings, runtime);

  const context = toPiAiContext(messages, hasTools ? options?.tools : undefined);

  try {
    const result = await withTauriHttpFetch(async () => {
      const s = piStream(model, context, {
        apiKey,
        temperature: effectiveTemp,
        maxTokens: effectiveMaxTokens,
        signal: options?.signal,
        sessionId: options?.sessionId,
        reasoning: thinking as Parameters<typeof piStream>[2] extends { reasoning?: infer R } ? R : never,
        onPayload: (payload: unknown) => {
          if (payload && typeof payload === "object") {
            const p = payload as Record<string, unknown>;
            if (normalizedToolChoice !== undefined && hasTools) {
              p.tool_choice = normalizedToolChoice;
            }
            if (protocol === "anthropic-messages") {
              applyAnthropicCacheBreakpoints(p);
            }
          }
          return undefined;
        },
      });

      for await (const event of s) {
        if (event.type === "text_delta") {
          onChunk(event.delta);
        } else if (event.type === "toolcall_end") {
          const tc = event as { type: "toolcall_end"; toolCall: { id: string; name: string; arguments: Record<string, unknown> }; [k: string]: unknown };
          onToolCall?.({
            callId: tc.toolCall.id,
            toolName: tc.toolCall.name,
            arguments: JSON.stringify(tc.toolCall.arguments),
          });
        }
      }

      return s.result();
    }, settings.proxy);

    return resultToHttpResponse(result, model);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    const errorMsg = error instanceof Error ? error.message : String(error);

    console.error(`[piAiBridge] gatewayStream threw: ${errorMsg}`);
    return {
      status: 500,
      body: JSON.stringify({ error: { message: errorMsg } }),
      endpoint: `pi-ai://${model.provider}/${model.id}`,
    };
  }
}

/**
 * Lightweight non-streaming call for internal summarization (no tools, no
 * runtime). Replaces: createLiteLLMRequestBody({}) + postLiteLLMChatCompletions()
 * for the summarization call in planningService.ts.
 */
export async function gatewaySummarize(
  messages: LiteLLMMessage[],
  settings: AppSettings,
): Promise<LiteLLMHttpResponse> {
  return gatewayComplete(messages, settings, null, {});
}
