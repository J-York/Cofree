/**
 * Conversation-history summarization used to compress tool-loop context
 * when it grows past budget.
 *
 * Single-pass map-style summarization:
 *   - Messages are joined into one body (bounded to SUMMARY_CHUNK_MAX_CHARS,
 *     tail-preserved when oversize).
 *   - One LLM call produces a structured Chinese summary.
 *   - Results are cached by stable message-hash key so repeated runs in the
 *     same workspace hit the cache.
 *
 * `hashText` is exported because planningService also uses it for apply-patch
 * fingerprinting — avoids a cross-module circular dependency.
 */

import { gatewaySummarize, type LiteLLMMessage } from "../lib/piAiBridge";
import type { AppSettings } from "../lib/settingsStore";
import { SummaryCache } from "../lib/summaryCache";
import {
  SUMMARY_CACHE_MAX_ENTRIES,
  SUMMARY_CACHE_TTL_MS,
  SUMMARY_CHUNK_MAX_CHARS,
} from "./contextPolicy";

const SUMMARY_SYSTEM_PROMPT = [
  "你是一个代码助手内置的上下文压缩引擎。你的任务是将冗长的对话历史压缩为高密度的摘要，保留对后续工作至关重要的事实与技术上下文。",
  "请使用高度结构化、简明扼要的语言（中文）输出，严格控制在 800 字以内，并包含以下部分：",
  "【核心目标】用户最初的需求是什么？",
  "【已完成变更】涉及哪些文件的修改？具体做了什么（给出关键函数或组件名）？",
  "【收集到的事实】发现的重要错误信息、项目的架构约束、特殊的配置结构等。",
  "【当前进展与下一步】任务停在哪里？接下来立即需要解决的是什么？",
].join("\n");

const summaryCache = new SummaryCache({
  ttlMs: SUMMARY_CACHE_TTL_MS,
  maxEntries: SUMMARY_CACHE_MAX_ENTRIES,
});

export function hashText(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function stableMessageHashKey(
  messages: LiteLLMMessage[],
  workspacePath?: string,
): string {
  const normalized = messages
    .map((m) => {
      const toolCalls = m.tool_calls ? JSON.stringify(m.tool_calls) : "";
      const toolCallId = (m as any).tool_call_id
        ? String((m as any).tool_call_id)
        : "";
      const name = (m as any).name ? String((m as any).name) : "";
      return [m.role, m.content ?? "", toolCalls, toolCallId, name].join(
        "",
      );
    })
    .join("");
  const scope = workspacePath?.trim() ? `ws:${workspacePath.trim()}` : "ws:";
  return `${scope}:${hashText(normalized)}`;
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

function formatMessagesForSummary(msgs: LiteLLMMessage[]): string {
  return msgs
    .map((msg) => {
      const roleLabel =
        msg.role === "user"
          ? "用户"
          : msg.role === "assistant"
            ? "助手"
            : msg.role;
      // Safely extract text from multimodal content (content may be an array
      // of {type:"text", text:"..."} objects in some providers).
      const text = normalizeMessageContent(msg.content);
      return `[${roleLabel}] ${text}`;
    })
    .join("\n---\n");
}

async function summarizeSingleChunk(
  content: string,
  settings: AppSettings,
  systemPrompt: string,
): Promise<string | null> {
  const messages: LiteLLMMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content },
  ];

  try {
    const response = await gatewaySummarize(messages, settings);
    const payload = JSON.parse(response.body) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return payload.choices?.[0]?.message?.content?.trim() ?? null;
  } catch (error) {
    console.warn(
      `[Context] summarizeSingleChunk 失败 | content.length=${content.length}`,
      error,
    );
    return null;
  }
}

export async function requestSummary(
  messagesToSummarize: LiteLLMMessage[],
  settings: AppSettings,
  options?: {
    workspacePath?: string;
  },
): Promise<string> {
  const cacheKey = stableMessageHashKey(
    messagesToSummarize,
    options?.workspacePath,
  );
  const cached = summaryCache.get(cacheKey);
  if (cached) {
    console.log(`[Context] 摘要命中缓存 (${messagesToSummarize.length} messages)`);
    return cached;
  }

  console.log(`[Context] 开始上下文摘要压缩 | ${messagesToSummarize.length} messages`);
  const sumT0 = performance.now();

  const combinedContent = formatMessagesForSummary(messagesToSummarize);

  // Single-pass summarization: truncate to fit budget, then one LLM call.
  // For long content, keep the tail (most recent context is most relevant).
  const contentForSummary =
    combinedContent.length <= SUMMARY_CHUNK_MAX_CHARS
      ? combinedContent
      : "(早期对话已省略)...\n" + combinedContent.slice(-SUMMARY_CHUNK_MAX_CHARS);

  const result = await summarizeSingleChunk(
    contentForSummary,
    settings,
    SUMMARY_SYSTEM_PROMPT,
  );
  if (result) {
    const elapsed = ((performance.now() - sumT0) / 1000).toFixed(2);
    console.log(`[Context] 摘要完成 | ${elapsed}s | ${result.length} chars`);
    summaryCache.set(cacheKey, result);
    return result;
  }

  // Fallback when summarization fails
  const userMessages = messagesToSummarize.filter((m) => m.role === "user");
  const fallbackLines = userMessages
    .map((m) => m.content.slice(0, 100))
    .slice(0, 5);
  const fallback = `[自动摘要] 之前的对话包含 ${messagesToSummarize.length
    } 条消息。用户主要请求：${fallbackLines.join("；")}`;
  summaryCache.set(cacheKey, fallback);
  return fallback;
}
