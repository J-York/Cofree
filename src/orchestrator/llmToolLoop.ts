import {
  gatewayComplete,
  gatewayStream,
  type LiteLLMMessage,
  type LiteLLMToolDefinition,
} from "../lib/piAiBridge";
import type { AppSettings } from "../lib/settingsStore";
import type { ResolvedAgentRuntime } from "../agents/types";

import { summarizeToolArgs } from "./toolCallAnalysis";

export interface ToolCallRecord {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface RequestRecord {
  requestId: string;
  inputLength: number;
  outputLength: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
}

export interface ToolCallEvent {
  type: "start" | "end";
  callId: string;
  toolName: string;
  argsPreview?: string;
  result?: "success" | "failed" | "pending_approval" | "waiting_for_user";
  resultPreview?: string;
}

interface ChatCompletionChoiceMessage {
  content?: unknown;
  tool_calls?: unknown;
  reasoning_content?: unknown;
}

interface ChatCompletionPayload {
  id?: string;
  choices?: Array<{
    message?: ChatCompletionChoiceMessage;
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    /** Anthropic-style cache fields, surfaced by piAiBridge for both protocols. */
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    /** OpenAI-style nested cache field; piAiBridge mirrors cacheRead here too. */
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

function consolidateSystemMessages(
  systemMsgs: LiteLLMMessage[],
): LiteLLMMessage[] {
  if (systemMsgs.length <= 1) {
    return systemMsgs;
  }
  const merged = systemMsgs.map((m) => m.content.trim()).filter(Boolean).join("\n\n");
  return [{ role: "system", content: merged }];
}

/**
 * Sanitize messages before sending to the LLM API.
 *
 * This function ensures that the tool-call → tool-result sequence is never
 * broken by interleaved system messages, which is a common cause of GPT
 * models "forgetting" to use native tool calling after many turns.
 *
 * It also consolidates consecutive system messages to reduce noise.
 *
 * For Anthropic protocol this is a no-op: Anthropic handles interleaved system
 * messages natively, and rearranging the message order breaks prefix cache.
 */
export function sanitizeMessagesForToolCalling(
  messages: LiteLLMMessage[],
  protocol?: string,
): LiteLLMMessage[] {
  // Anthropic handles system messages natively; rearranging breaks prefix cache.
  if (protocol === "anthropic-messages") {
    return messages;
  }

  const result: LiteLLMMessage[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];

    if (msg.role === "assistant" && msg.tool_calls?.length) {
      result.push(msg);
      i++;

      const expectedCallIds = new Set(msg.tool_calls.map((tc) => tc.id));
      const deferredSystemMessages: LiteLLMMessage[] = [];

      while (i < messages.length && expectedCallIds.size > 0) {
        const next = messages[i];
        if (
          next.role === "tool" &&
          next.tool_call_id &&
          expectedCallIds.has(next.tool_call_id)
        ) {
          result.push(next);
          expectedCallIds.delete(next.tool_call_id);
          i++;
          continue;
        }
        if (next.role === "tool" && next.tool_call_id) {
          result.push(next);
          i++;
          continue;
        }
        if (next.role === "system") {
          deferredSystemMessages.push(next);
          i++;
          continue;
        }
        break;
      }

      if (deferredSystemMessages.length > 0) {
        const consolidated = consolidateSystemMessages(deferredSystemMessages);
        result.push(...consolidated);
      }
      continue;
    }

    result.push(msg);
    i++;
  }

  return result;
}

function createRequestId(prefix: string): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function normalizeMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (
          item &&
          typeof item === "object" &&
          "type" in item &&
          (item as Record<string, unknown>).type === "text" &&
          "text" in item &&
          typeof (item as Record<string, unknown>).text === "string"
        ) {
          return (item as Record<string, string>).text;
        }
        return "";
      })
      .join("");
  }

  return "";
}

function buildAssistantDisplayContent(message: ChatCompletionChoiceMessage): string {
  const content = normalizeMessageContent(message.content);
  const reasoning = normalizeMessageContent(message.reasoning_content);

  if (!reasoning.trim()) {
    return content;
  }
  if (content.includes("<think>")) {
    return content;
  }
  return `<think>${reasoning}</think>${content}`;
}

function inputLengthOf(messages: LiteLLMMessage[]): number {
  return messages.reduce((total, message) => total + message.content.length, 0);
}

function parseErrorMessage(raw: string, status: number): string {
  if (!raw.trim()) {
    return `${status}`;
  }

  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } };
    return parsed.error?.message ?? raw.slice(0, 240);
  } catch (_error) {
    return raw.slice(0, 240);
  }
}

function parseCompletionPayload(raw: string): ChatCompletionPayload {
  const trimmed = raw.trim();

  // Handle empty response
  if (!trimmed) {
    throw new Error("模型响应为空。");
  }

  try {
    const parsed = JSON.parse(trimmed) as ChatCompletionPayload;
    if (!parsed || typeof parsed !== "object") {
      throw new Error("completion payload invalid");
    }
    return parsed;
  } catch (primaryError) {
    // Some streaming responses may have trailing garbage after the JSON object.
    // Try to extract the first valid JSON object from the response.
    const firstBrace = trimmed.indexOf("{");
    if (firstBrace >= 0) {
      let depth = 0;
      let inStr = false;
      let escape = false;
      for (let i = firstBrace; i < trimmed.length; i++) {
        const char = trimmed[i];
        if (escape) { escape = false; continue; }
        if (char === "\\") { escape = true; continue; }
        if (char === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (char === "{") depth++;
        else if (char === "}") {
          depth--;
          if (depth === 0) {
            try {
              const extracted = JSON.parse(trimmed.slice(firstBrace, i + 1)) as ChatCompletionPayload;
              if (extracted && typeof extracted === "object") {
                console.warn("[parseCompletionPayload] Recovered valid JSON from partial response");
                return extracted;
              }
            } catch {
              // Continue to throw original error
            }
            break;
          }
        }
      }
    }

    throw new Error("模型响应不是有效 JSON。");
  }
}

/**
 * Attempt to repair truncated or malformed JSON arguments from streaming responses.
 * Some models (especially during streaming) may produce incomplete JSON that can be
 * salvaged by closing open brackets/braces.
 */
function tryRepairJsonArguments(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Already valid JSON
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // Continue to repair attempts
  }

  // Count unmatched brackets/braces and try to close them
  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;
  let escapeNext = false;

  for (const char of trimmed) {
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (char === "\\") {
      escapeNext = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === "{") openBraces++;
    else if (char === "}") openBraces--;
    else if (char === "[") openBrackets++;
    else if (char === "]") openBrackets--;
  }

  // If we're inside a string, close it first
  let repaired = trimmed;
  if (inString) {
    repaired += '"';
  }

  // Close any remaining open brackets/braces
  while (openBrackets > 0) {
    repaired += "]";
    openBrackets--;
  }
  while (openBraces > 0) {
    repaired += "}";
    openBraces--;
  }

  // Validate the repaired JSON
  try {
    JSON.parse(repaired);
    console.warn(`[parseToolCalls] Repaired truncated JSON arguments: "${trimmed.slice(0, 60)}..." → valid`);
    return repaired;
  } catch {
    return null;
  }
}

function parseToolCalls(raw: unknown): { parsed: ToolCallRecord[]; droppedCount: number } {
  if (!Array.isArray(raw)) {
    return { parsed: [], droppedCount: 0 };
  }

  let dropped = 0;
  const parsed = raw
    .map((item, index) => {
      if (!item || typeof item !== "object") {
        dropped += 1;
        return null;
      }
      const record = item as Record<string, unknown>;
      const fn = record.function;
      if (!fn || typeof fn !== "object") {
        dropped += 1;
        return null;
      }
      const fnRecord = fn as Record<string, unknown>;

      // Validate tool name
      if (typeof fnRecord.name !== "string" || !fnRecord.name.trim()) {
        dropped += 1;
        return null;
      }

      // Handle arguments: allow empty object "{}" as valid (some models send this for no-arg tools)
      let argsStr = typeof fnRecord.arguments === "string"
        ? fnRecord.arguments.trim()
        : "";

      // If arguments is an object (some providers return parsed JSON instead of string)
      if (!argsStr && fnRecord.arguments && typeof fnRecord.arguments === "object") {
        argsStr = JSON.stringify(fnRecord.arguments);
      }

      // Default to empty object for tools with no required parameters
      if (!argsStr) {
        argsStr = "{}";
      }

      // Attempt to repair truncated JSON from streaming responses
      const repairedArgs = tryRepairJsonArguments(argsStr);
      if (!repairedArgs) {
        console.warn(
          `[parseToolCalls] Dropping tool call "${fnRecord.name}" with unparseable arguments: "${argsStr.slice(0, 100)}"`
        );
        dropped += 1;
        return null;
      }

      const id =
        typeof record.id === "string" && record.id.trim()
          ? record.id
          : `toolcall-${index + 1}-${Date.now()}`;
      return {
        id,
        type: "function" as const,
        function: {
          name: fnRecord.name.trim(),
          arguments: repairedArgs,
        },
      };
    })
    .filter((item): item is ToolCallRecord => Boolean(item));
  return { parsed, droppedCount: dropped };
}





/* requestToolCompletion: Non-streaming variant (retained for local-only fallback) */
export async function requestToolCompletion(
  messages: LiteLLMMessage[],
  settings: AppSettings,
  activeTools: LiteLLMToolDefinition[],
  signal?: AbortSignal,
  toolChoiceOverride?: "auto" | "none",
  runtime?: ResolvedAgentRuntime | null,
  sessionId?: string,
): Promise<{
  assistantMessage: LiteLLMMessage;
  toolCalls: ToolCallRecord[];
  droppedToolCalls: number;
  requestRecord: RequestRecord;
  finishReason?: string;
}> {
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }

  const sanitizedMessages = sanitizeMessagesForToolCalling(messages, runtime?.vendorProtocol);
  const effectiveToolChoice = toolChoiceOverride ?? "model-adapted";
  const requestModel = runtime?.modelRef || settings.model;

  const t0 = performance.now();
  console.log(
    `[LLM] 发送请求 (非流式) | model=${requestModel} | messages=${sanitizedMessages.length} | tools=${activeTools.length} | toolChoice=${effectiveToolChoice}`
  );

  const response = await gatewayComplete(sanitizedMessages, settings, runtime ?? null, {
    stream: false,
    temperature: 0.1,
    tools: effectiveToolChoice === "none" ? undefined : activeTools,
    toolChoice:
      toolChoiceOverride === undefined || toolChoiceOverride === "none"
        ? undefined
        : toolChoiceOverride,
    signal,
    sessionId,
  });
  const elapsed = ((performance.now() - t0) / 1000).toFixed(2);

  if (response.status < 200 || response.status >= 300) {
    console.warn(`[LLM] 请求失败 | status=${response.status} | ${elapsed}s`);
    const detail = parseErrorMessage(response.body, response.status);
    throw new Error(`服务员响应失败: ${detail}`);
  }

  const payload = parseCompletionPayload(response.body);
  const requestId =
    typeof payload.id === "string" && payload.id.trim()
      ? payload.id
      : createRequestId("chat");

  const firstChoice = payload.choices?.[0];
  const rawMessage = firstChoice?.message;
  if (!rawMessage) {
    throw new Error("模型响应缺少 message。");
  }

  const finishReason = firstChoice?.finish_reason ?? undefined;
  const { parsed: toolCalls, droppedCount } = parseToolCalls(rawMessage.tool_calls);
  const assistantContent = buildAssistantDisplayContent(rawMessage);

  const inTok = payload.usage?.prompt_tokens;
  const outTok = payload.usage?.completion_tokens;
  const cacheCreate = payload.usage?.cache_creation_input_tokens;
  const cacheReadFromAnthropic = payload.usage?.cache_read_input_tokens;
  const cacheReadFromOpenAI = payload.usage?.prompt_tokens_details?.cached_tokens;
  const cacheRead = cacheReadFromAnthropic ?? cacheReadFromOpenAI;
  console.log(
    `[LLM] 收到响应 | ${elapsed}s | toolCalls=${toolCalls.length}` +
    (droppedCount > 0 ? ` dropped=${droppedCount}` : "") +
    (finishReason ? ` | finish_reason=${finishReason}` : "") +
    (inTok != null || outTok != null ? ` | in=${inTok ?? "?"} out=${outTok ?? "?"}` : "") +
    (cacheRead != null || cacheCreate != null
      ? ` | cacheRead=${cacheRead ?? 0} cacheCreate=${cacheCreate ?? 0}`
      : "") +
    ` | id=${requestId}`
  );

  if (finishReason === "length") {
    console.warn(
      `[LLM] 响应被截断 (finish_reason=length) | 工具调用可能不完整 | id=${requestId}`
    );
  }

  const assistantMessage: LiteLLMMessage = {
    role: "assistant",
    content: assistantContent,
    tool_calls: toolCalls.length ? toolCalls : undefined,
  };

  return {
    assistantMessage,
    toolCalls,
    droppedToolCalls: droppedCount,
    finishReason,
    requestRecord: {
      requestId,
      inputLength: inputLengthOf(messages),
      outputLength: response.body.length,
      inputTokens: inTok ?? undefined,
      outputTokens: outTok ?? undefined,
      cacheCreationTokens: cacheCreate ?? undefined,
      cacheReadTokens: cacheRead ?? undefined,
    },
  };
}

async function requestToolCompletionWithStream(
  messages: LiteLLMMessage[],
  settings: AppSettings,
  activeTools: LiteLLMToolDefinition[],
  signal?: AbortSignal,
  onChunk?: (content: string) => void,
  onToolCallEvent?: (event: ToolCallEvent) => void,
  toolChoiceOverride?: "auto" | "none",
  runtime?: ResolvedAgentRuntime | null,
  sessionId?: string,
): Promise<{
  assistantMessage: LiteLLMMessage;
  toolCalls: ToolCallRecord[];
  droppedToolCalls: number;
  requestRecord: RequestRecord;
  finishReason?: string;
}> {
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }

  const sanitizedMessages = sanitizeMessagesForToolCalling(messages, runtime?.vendorProtocol);
  const effectiveToolChoice = toolChoiceOverride ?? "model-adapted";
  const requestModel = runtime?.modelRef || settings.model;

  const t0 = performance.now();
  console.log(
    `[LLM] 发送请求 (流式) | model=${requestModel} | messages=${sanitizedMessages.length} | tools=${activeTools.length} | toolChoice=${effectiveToolChoice}`
  );

  const response = await gatewayStream(
    sanitizedMessages,
    settings,
    runtime ?? null,
    {
      stream: true,
      temperature: 0.1,
      tools: effectiveToolChoice === "none" ? undefined : activeTools,
      toolChoice:
        toolChoiceOverride === undefined || toolChoiceOverride === "none"
          ? undefined
          : toolChoiceOverride,
      signal,
      sessionId,
    },
    (content) => {
      onChunk?.(content);
    },
    (toolCall) => {
      onToolCallEvent?.({
        type: "start",
        callId: toolCall.callId,
        toolName: toolCall.toolName,
        argsPreview: summarizeToolArgs(toolCall.toolName, toolCall.arguments),
      });
    },
  );

  const elapsed = ((performance.now() - t0) / 1000).toFixed(2);

  if (response.status < 200 || response.status >= 300) {
    console.warn(`[LLM] 请求失败 | status=${response.status} | ${elapsed}s`);
    const detail = parseErrorMessage(response.body, response.status);
    throw new Error(`服务员响应失败: ${detail}`);
  }

  const payload = parseCompletionPayload(response.body);
  const requestId =
    typeof payload.id === "string" && payload.id.trim()
      ? payload.id
      : createRequestId("chat");

  const firstChoice = payload.choices?.[0];
  const rawMessage = firstChoice?.message;
  if (!rawMessage) {
    throw new Error("模型响应缺少 message。");
  }

  const finishReason = firstChoice?.finish_reason ?? undefined;
  const { parsed: toolCalls, droppedCount } = parseToolCalls(rawMessage.tool_calls);
  const assistantContent = buildAssistantDisplayContent(rawMessage);

  const inTok = payload.usage?.prompt_tokens;
  const outTok = payload.usage?.completion_tokens;
  const cacheCreate = payload.usage?.cache_creation_input_tokens;
  const cacheReadFromAnthropic = payload.usage?.cache_read_input_tokens;
  const cacheReadFromOpenAI = payload.usage?.prompt_tokens_details?.cached_tokens;
  const cacheRead = cacheReadFromAnthropic ?? cacheReadFromOpenAI;
  console.log(
    `[LLM] 收到响应 | ${elapsed}s | toolCalls=${toolCalls.length}` +
    (droppedCount > 0 ? ` dropped=${droppedCount}` : "") +
    (finishReason ? ` | finish_reason=${finishReason}` : "") +
    (inTok != null || outTok != null ? ` | in=${inTok ?? "?"} out=${outTok ?? "?"}` : "") +
    (cacheRead != null || cacheCreate != null
      ? ` | cacheRead=${cacheRead ?? 0} cacheCreate=${cacheCreate ?? 0}`
      : "") +
    ` | id=${requestId}`
  );

  if (finishReason === "length") {
    console.warn(
      `[LLM] 响应被截断 (finish_reason=length) | 工具调用可能不完整 | id=${requestId}`
    );
  }

  if (!assistantContent.trim() && toolCalls.length === 0) {
    console.warn("[LLM] 流式响应未解析出文本或工具调用，触发非流式回退");
    throw new Error("stream returned empty assistant response");
  }

  const assistantMessage: LiteLLMMessage = {
    role: "assistant",
    content: assistantContent,
    tool_calls: toolCalls.length ? toolCalls : undefined,
  };

  return {
    assistantMessage,
    toolCalls,
    droppedToolCalls: droppedCount,
    finishReason,
    requestRecord: {
      requestId,
      inputLength: inputLengthOf(messages),
      outputLength: response.body.length,
      inputTokens: inTok ?? undefined,
      outputTokens: outTok ?? undefined,
      cacheCreationTokens: cacheCreate ?? undefined,
      cacheReadTokens: cacheRead ?? undefined,
    },
  };
}

function hasPreviousAssistantToolCalls(messages: LiteLLMMessage[]): boolean {
  return messages.some(
    (message) => message.role === "assistant" && (message.tool_calls?.length ?? 0) > 0,
  );
}

function shouldFallbackToNonStreamingForToolTurn(error: unknown): boolean {
  const raw = error instanceof Error ? error.message : String(error);
  const normalized = raw.toLowerCase();

  // Gateway / server errors (streaming infrastructure failure)
  if (
    /(?:^|\D)(502|503|504)(?:\D|$)/.test(normalized) ||
    normalized.includes("bad gateway") ||
    normalized.includes("gateway") ||
    normalized.includes("server error") ||
    normalized.includes("upstream")
  ) {
    return true;
  }

  // Network / transport errors from browser-side streaming fetches. In the
  // desktop app, non-streaming uses the Rust HTTP bridge and is often able to
  // recover from these transport-specific failures.
  if (
    normalized.includes("connection error") ||
    normalized.includes("network error") ||
    normalized.includes("fetch failed") ||
    normalized.includes("failed to fetch") ||
    normalized.includes("econn") ||
    normalized.includes("socket") ||
    normalized.includes("tls") ||
    normalized.includes("dns")
  ) {
    return true;
  }

  // JSON parse errors from streamed response assembly
  if (
    normalized.includes("json") ||
    normalized.includes("unexpected token") ||
    normalized.includes("unexpected end") ||
    normalized.includes("不是有效 json") ||
    normalized.includes("模型响应不是有效") ||
    normalized.includes("invalid json")
  ) {
    return true;
  }

  // Stream-specific errors
  if (
    normalized.includes("stream") ||
    normalized.includes("sse") ||
    normalized.includes("event source") ||
    normalized.includes("chunk") ||
    normalized.includes("incomplete")
  ) {
    return true;
  }

  // Missing message in response (can happen when streaming drops data)
  if (
    normalized.includes("缺少 message") ||
    normalized.includes("missing message") ||
    normalized.includes("模型响应缺少")
  ) {
    return true;
  }

  return false;
}

export async function executeToolCompletionForTurn(
  messages: LiteLLMMessage[],
  settings: AppSettings,
  runtime: ResolvedAgentRuntime,
  activeTools: LiteLLMToolDefinition[],
  turn: number,
  signal?: AbortSignal,
  onChunk?: (content: string) => void,
  onToolCallEvent?: (event: ToolCallEvent) => void,
  toolChoiceOverride?: "auto" | "none",
  sessionId?: string,
): Promise<{
  completion: {
    assistantMessage: LiteLLMMessage;
    toolCalls: ToolCallRecord[];
    droppedToolCalls: number;
    requestRecord: RequestRecord;
    finishReason?: string;
  };
  requestMode: "stream" | "nonstream";
  fallbackTriggered: boolean;
}> {
  const hadPreviousAssistantToolCalls = hasPreviousAssistantToolCalls(messages);

  console.log(
    `[Loop][Mode] turn=${turn + 1} | mode=stream | previousAssistantToolCalls=${hadPreviousAssistantToolCalls ? "yes" : "no"}`,
  );

  try {
    const completion = await requestToolCompletionWithStream(
      messages,
      settings,
      activeTools,
      signal,
      onChunk,
      onToolCallEvent,
      toolChoiceOverride,
      runtime,
      sessionId,
    );
    return {
      completion,
      requestMode: "stream",
      fallbackTriggered: false,
    };
  } catch (error) {
    if (!shouldFallbackToNonStreamingForToolTurn(error)) {
      throw error;
    }
    console.warn(
      `[Loop][Fallback] turn=${turn + 1} | from=stream | to=nonstream | reason=${error instanceof Error ? error.message : String(error)}`,
    );
    const completion = await requestToolCompletion(
      messages,
      settings,
      activeTools,
      signal,
      toolChoiceOverride,
      runtime,
      sessionId,
    );
    return {
      completion,
      requestMode: "nonstream",
      fallbackTriggered: true,
    };
  }
}
