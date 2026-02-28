/**
 * Cofree - AI Programming Cafe
 * File: src/orchestrator/planningService.ts
 * Milestone: 3
 * Task: 3.5
 * Status: In Progress
 * Owner: Codex-GPT-5
 * Last Modified: 2026-02-28
 * Description: Native tool-calling orchestration loop with explicit HITL gate generation.
 */

import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_AGENTS } from "../agents/defaultAgents";
import { recordLLMAudit } from "../lib/auditLog";
import {
  createLiteLLMRequestBody,
  isLocalProvider,
  postLiteLLMChatCompletions,
  type LiteLLMMessage,
  type LiteLLMToolDefinition
} from "../lib/litellm";
import type { AppSettings } from "../lib/settingsStore";
import type { ActionProposal, OrchestrationPlan, PlanStep } from "./types";
const MAX_TOOL_LOOP_TURNS = 15;
const MAX_LIST_ENTRIES = 120;
const MAX_FILE_PREVIEW_CHARS = 4000;
const MAX_TOOL_RESULT_PREVIEW = 400;
const MAX_TOOL_RETRY = 2;

interface ToolCallRecord {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface ToolExecutionResult {
  content: string;
  proposedAction?: ActionProposal;
  errorCategory?: ToolErrorCategory;
  errorMessage?: string;
  success?: boolean;
}

interface ChatCompletionChoiceMessage {
  content?: unknown;
  tool_calls?: unknown;
}

interface ChatCompletionPayload {
  id?: string;
  choices?: Array<{
    message?: ChatCompletionChoiceMessage;
  }>;
}

interface FileEntry {
  name: string;
  is_dir: boolean;
  size: number;
  modified: number;
}

const ASSISTANT_SYSTEM_PROMPT = [
  "你是 Cofree 的服务员。你的目标是作为一名顶级的全栈工程师协助用户。",
  "你必须优先通过可用工具获取事实，再给出答案。必须严格遵守以下工作流原则（Vibe Coding 原则）：",
  "1) **Show, don't tell**：少废话，多干活。直接执行任务，不要在回复中长篇大论解释代码原理、功能特点，除非用户明确要求解释。",
  "2) **信任系统回调**：当系统提示动作成功（如 apply_patch, git_write 等）时，直接信任结果，继续当前任务或简短汇报“已完成”。绝对严禁调用 list_files 或 read_file 进行多余的自我验证！",
  "3) **极简交流**：在报告完成任务时，只需简短回答“已完成”或指明结果位置。绝对不要为了凑字数而列举无关内容。",
  "当用户要求新增/修改/删除文件、执行命令或 git 写操作时：",
  "1) 不要直接执行副作用；",
  "2) 必须通过 propose_apply_patch / propose_run_command / propose_git_write 工具提出待审批动作。",
  "3) 审批动作必须按需提出；如果用户仅询问信息或解释，不要提出任何审批动作。",
  "4) 禁止为了兜底一次性提出三条审批动作，必须最小化且与当前任务直接相关。",
  "当读取文件系统信息时，必须调用 list_files/read_file/git_status/git_diff，而不是伪造结果。不要高频无意义地盲目调用 list_files/read_file，目标必须清晰。",
  "严禁输出伪工具调用标签（如 <tool_call>）。",
  "回复语言与用户保持一致。"
].join("\n");

const TOOL_DEFINITIONS: LiteLLMToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files/directories under workspace relative path.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          relative_path: {
            type: "string",
            description: "Workspace-relative directory path. Empty means workspace root."
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file content by workspace-relative path.",
      parameters: {
        type: "object",
        required: ["relative_path"],
        additionalProperties: false,
        properties: {
          relative_path: {
            type: "string",
            description: "Workspace-relative file path."
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "git_status",
      description: "Get git status summary in workspace repository.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {}
      }
    }
  },
  {
    type: "function",
    function: {
      name: "git_diff",
      description: "Get workspace git diff, optionally filtered to one file.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          file_path: {
            type: "string",
            description: "Optional workspace-relative file path."
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "propose_apply_patch",
      description:
        "Propose a write action by submitting unified diff patch for HITL approval (does not execute).",
      parameters: {
        type: "object",
        required: ["patch"],
        additionalProperties: false,
        properties: {
          patch: {
            type: "string",
            description: "Unified diff patch content."
          },
          description: {
            type: "string",
            description: "Optional short description for reviewers."
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "propose_run_command",
      description:
        "Propose a command execution action for HITL approval (does not execute). Command must be allowlisted at execution time.",
      parameters: {
        type: "object",
        required: ["command"],
        additionalProperties: false,
        properties: {
          command: {
            type: "string"
          },
          timeout_ms: {
            type: "number",
            minimum: 1000,
            maximum: 600000
          },
          description: {
            type: "string"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "propose_git_write",
      description:
        "Propose git write action for HITL approval (does not execute). Supported operations: stage/commit/checkout_branch.",
      parameters: {
        type: "object",
        required: ["operation"],
        additionalProperties: false,
        properties: {
          operation: {
            type: "string",
            enum: ["stage", "commit", "checkout_branch"]
          },
          message: {
            type: "string"
          },
          branch_name: {
            type: "string"
          },
          allow_empty: {
            type: "boolean"
          },
          description: {
            type: "string"
          }
        }
      }
    }
  }
];

export class LocalOnlyPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalOnlyPolicyError";
  }
}

export interface RunPlanningSessionInput {
  prompt: string;
  settings: AppSettings;
  conversationHistory?: Array<{
    role: "user" | "assistant";
    content: string;
  }>;
  signal?: AbortSignal;
  onAssistantChunk?: (chunk: string) => void;
}

export interface PlanningSessionResult {
  assistantReply: string;
  plan: OrchestrationPlan;
  toolTrace: ToolExecutionTrace[];
}

interface RequestRecord {
  requestId: string;
  inputLength: number;
  outputLength: number;
}

export type ToolErrorCategory =
  | "validation"
  | "workspace"
  | "permission"
  | "timeout"
  | "allowlist"
  | "transport"
  | "tool_not_found"
  | "unknown";

export interface ToolExecutionTrace {
  callId: string;
  name: string;
  arguments: string;
  startedAt: string;
  finishedAt: string;
  attempts: number;
  status: "success" | "failed";
  retried: boolean;
  errorCategory?: ToolErrorCategory;
  errorMessage?: string;
  resultPreview?: string;
}

function createRequestId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
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

// 粗略估计 Token 数量：中英文混排时大致 1 个汉字≈1-2 token，英文字符数/4≈token。
// 这里简单使用字符串长度来做保守估算，假设平均 1 token ≈ 2.5 字符。
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2.5);
}

function sanitizeConversationHistory(
  conversationHistory: RunPlanningSessionInput["conversationHistory"],
  maxTokens: number
): LiteLLMMessage[] {
  if (!conversationHistory?.length) {
    return [];
  }

  const validMessages = conversationHistory
    .map((message) => ({
      role: message.role,
      content: message.content.trim()
    }))
    .filter((message) => Boolean(message.content));

  // 如果用户未设置或异常，回退到 128k 默认限制 (128000 * 2.5 = 320000 字符)
  const limitTokens = maxTokens > 0 ? maxTokens : 128000;
  const bufferTokens = 8000; // 留给 System Prompt 和当前回复的空间
  const maxAllowedTokens = limitTokens - bufferTokens;

  let currentTokens = 0;
  const selectedMessages: LiteLLMMessage[] = [];

  // 从新到旧遍历，保留尽可能多的最近消息
  for (let i = validMessages.length - 1; i >= 0; i--) {
    const msg = validMessages[i];
    const tokens = estimateTokens(msg.content);
    if (currentTokens + tokens > maxAllowedTokens) {
      // 如果单条消息就超大，但已经是最新的一条，或者为了防止上下文截断过严：
      // 插入一条系统提示，要求 LLM 注意上下文已被截断或需要压缩。
      selectedMessages.unshift({
        role: "system",
        content: "[系统提示] 之前的对话历史由于达到上下文长度限制已被截断。请基于现有的最新信息继续工作。"
      });
      break;
    }
    selectedMessages.unshift(msg);
    currentTokens += tokens;
  }

  return selectedMessages;
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
  try {
    const parsed = JSON.parse(raw) as ChatCompletionPayload;
    if (!parsed || typeof parsed !== "object") {
      throw new Error("completion payload invalid");
    }
    return parsed;
  } catch (_error) {
    throw new Error("模型响应不是有效 JSON。");
  }
}

function parseToolCalls(raw: unknown): ToolCallRecord[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((item, index) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const record = item as Record<string, unknown>;
      const fn = record.function;
      if (!fn || typeof fn !== "object") {
        return null;
      }
      const fnRecord = fn as Record<string, unknown>;
      if (typeof fnRecord.name !== "string" || typeof fnRecord.arguments !== "string") {
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
          name: fnRecord.name,
          arguments: fnRecord.arguments
        }
      };
    })
    .filter((item): item is ToolCallRecord => Boolean(item));
}

function normalizeRelativePath(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function createActionId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function classifyToolError(message: string): ToolErrorCategory {
  const lower = message.toLowerCase();
  if (lower.includes("不能为空") || lower.includes("invalid json") || lower.includes("arguments")) {
    return "validation";
  }
  if (lower.includes("未选择工作区") || lower.includes("workspace")) {
    return "workspace";
  }
  if (lower.includes("allowlist")) {
    return "allowlist";
  }
  if (lower.includes("timed out") || lower.includes("超时")) {
    return "timeout";
  }
  if (lower.includes("permission") || lower.includes("not permitted")) {
    return "permission";
  }
  if (lower.includes("未知工具")) {
    return "tool_not_found";
  }
  if (lower.includes("fetch") || lower.includes("network") || lower.includes("http")) {
    return "transport";
  }
  return "unknown";
}

function shouldRetryToolCall(category: ToolErrorCategory): boolean {
  return category === "transport" || category === "timeout";
}

function resultPreview(content: string): string {
  return content.slice(0, MAX_TOOL_RESULT_PREVIEW);
}

function renderListEntries(entries: FileEntry[]): string {
  const sorted = [...entries].sort((left, right) => {
    if (left.is_dir !== right.is_dir) {
      return left.is_dir ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
  const preview = sorted.slice(0, MAX_LIST_ENTRIES).map((entry) => {
    if (entry.is_dir) {
      return `[DIR] ${entry.name}/`;
    }
    return `[FILE] ${entry.name} (${entry.size}B)`;
  });
  if (sorted.length > MAX_LIST_ENTRIES) {
    preview.push(`... ${sorted.length - MAX_LIST_ENTRIES} entries omitted`);
  }
  return preview.join("\n");
}

async function executeToolCall(
  call: ToolCallRecord,
  workspacePath: string
): Promise<ToolExecutionResult> {
  const safeWorkspace = workspacePath.trim();
  if (!safeWorkspace) {
    const message = "未选择工作区。";
    return {
      content: JSON.stringify({ error: message }),
      success: false,
      errorCategory: "workspace",
      errorMessage: message
    };
  }

  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.function.arguments) as Record<string, unknown>;
  } catch (_error) {
    const message = "tool arguments 不是合法 JSON";
    return {
      content: JSON.stringify({ error: message }),
      success: false,
      errorCategory: "validation",
      errorMessage: message
    };
  }

  try {
    if (call.function.name === "list_files") {
      const relativePath = normalizeRelativePath(args.relative_path);
      const entries = await invoke<FileEntry[]>("list_workspace_files", {
        workspacePath: safeWorkspace,
        relativePath
      });
      return {
        content: JSON.stringify({
          ok: true,
          relative_path: relativePath,
          entry_count: entries.length,
          entries_preview: renderListEntries(entries)
        }),
        success: true
      };
    }

    if (call.function.name === "read_file") {
      const relativePath = normalizeRelativePath(args.relative_path);
      if (!relativePath) {
        const message = "relative_path 不能为空";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message
        };
      }
      const content = await invoke<string>("read_workspace_file", {
        workspacePath: safeWorkspace,
        relativePath
      });
      const trimmed = content.slice(0, MAX_FILE_PREVIEW_CHARS);
      return {
        content: JSON.stringify({
          ok: true,
          relative_path: relativePath,
          content_preview: trimmed,
          truncated: content.length > trimmed.length
        }),
        success: true
      };
    }

    if (call.function.name === "git_status") {
      const status = await invoke<{
        modified: string[];
        added: string[];
        deleted: string[];
        untracked: string[];
      }>("git_status_workspace", {
        workspacePath: safeWorkspace
      });
      return {
        content: JSON.stringify({
          ok: true,
          ...status
        }),
        success: true
      };
    }

    if (call.function.name === "git_diff") {
      const filePath = normalizeRelativePath(args.file_path);
      const diff = await invoke<string>("git_diff_workspace", {
        workspacePath: safeWorkspace,
        filePath: filePath || null
      });
      return {
        content: JSON.stringify({
          ok: true,
          file_path: filePath || null,
          diff_preview: diff.slice(0, MAX_FILE_PREVIEW_CHARS),
          truncated: diff.length > MAX_FILE_PREVIEW_CHARS
        }),
        success: true
      };
    }

    if (call.function.name === "propose_apply_patch") {
      const patch = asString(args.patch).trim();
      if (!patch) {
        const message = "patch 不能为空";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message
        };
      }
      const action: ActionProposal = {
        id: createActionId("gate-a-apply-patch"),
        type: "apply_patch",
        description: asString(args.description, "Apply generated patch to workspace (Gate A)"),
        gateRequired: true,
        status: "pending",
        executed: false,
        payload: {
          patch
        }
      };
      return {
        content: JSON.stringify({
          ok: true,
          action_type: "apply_patch",
          action_id: action.id,
          patch_length: patch.length
        }),
        success: true,
        proposedAction: action
      };
    }

    if (call.function.name === "propose_run_command") {
      const command = asString(args.command).trim();
      if (!command) {
        const message = "command 不能为空";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message
        };
      }
      const action: ActionProposal = {
        id: createActionId("gate-b-run-command"),
        type: "run_command",
        description: asString(args.description, "Run allowlisted validation command (Gate B)"),
        gateRequired: true,
        status: "pending",
        executed: false,
        payload: {
          command,
          timeoutMs: Math.max(1000, Math.min(600000, asNumber(args.timeout_ms, 120000)))
        }
      };
      return {
        content: JSON.stringify({
          ok: true,
          action_type: "run_command",
          action_id: action.id,
          command
        }),
        success: true,
        proposedAction: action
      };
    }

    if (call.function.name === "propose_git_write") {
      const operation = asString(args.operation, "stage");
      const normalizedOperation =
        operation === "commit" || operation === "checkout_branch" ? operation : "stage";
      const action: ActionProposal = {
        id: createActionId("gate-c-git-write"),
        type: "git_write",
        description: asString(args.description, "Stage/commit approved changes (Gate C)"),
        gateRequired: true,
        status: "pending",
        executed: false,
        payload: {
          operation: normalizedOperation,
          message: asString(args.message, "chore: apply approved changes"),
          branchName: asString(args.branch_name, "cofree/m3-approved"),
          allowEmpty: asBoolean(args.allow_empty, false)
        }
      };
      return {
        content: JSON.stringify({
          ok: true,
          action_type: "git_write",
          action_id: action.id,
          operation: normalizedOperation
        }),
        success: true,
        proposedAction: action
      };
    }

    return {
      content: JSON.stringify({ error: `未知工具: ${call.function.name}` }),
      success: false,
      errorCategory: "tool_not_found",
      errorMessage: `未知工具: ${call.function.name}`
    };
  } catch (error) {
    const message = String(error || "Unknown error");
    return {
      content: JSON.stringify({ error: message }),
      success: false,
      errorCategory: classifyToolError(message),
      errorMessage: message
    };
  }
}

async function executeToolCallWithRetry(
  call: ToolCallRecord,
  workspacePath: string
): Promise<{
  result: ToolExecutionResult;
  trace: ToolExecutionTrace;
}> {
  const startedAt = nowIso();
  let attempts = 0;
  let lastResult: ToolExecutionResult = {
    content: JSON.stringify({ error: "工具调用未执行" }),
    success: false,
    errorCategory: "unknown",
    errorMessage: "工具调用未执行"
  };

  while (attempts < MAX_TOOL_RETRY) {
    attempts += 1;
    const current = await executeToolCall(call, workspacePath);
    const success = current.success !== false;
    const errorCategory = current.errorCategory ?? (success ? undefined : "unknown");
    const errorMessage = current.errorMessage ?? (success ? undefined : "工具调用失败");
    lastResult = {
      ...current,
      success,
      errorCategory,
      errorMessage
    };

    if (success) {
      return {
        result: lastResult,
        trace: {
          callId: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
          startedAt,
          finishedAt: nowIso(),
          attempts,
          status: "success",
          retried: attempts > 1,
          resultPreview: resultPreview(current.content)
        }
      };
    }

    if (!shouldRetryToolCall(errorCategory ?? "unknown")) {
      break;
    }
  }

  return {
    result: lastResult,
    trace: {
      callId: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
      startedAt,
      finishedAt: nowIso(),
      attempts,
      status: "failed",
      retried: attempts > 1,
      errorCategory: lastResult.errorCategory,
      errorMessage: lastResult.errorMessage,
      resultPreview: resultPreview(lastResult.content)
    }
  };
}

async function requestToolCompletion(
  messages: LiteLLMMessage[],
  settings: AppSettings,
  signal?: AbortSignal
): Promise<{
  assistantMessage: LiteLLMMessage;
  toolCalls: ToolCallRecord[];
  requestRecord: RequestRecord;
}> {
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }

  const body = createLiteLLMRequestBody(messages, settings, {
    stream: false,
    temperature: 0.1,
    tools: TOOL_DEFINITIONS,
    toolChoice: "auto"
  });

  const response = await postLiteLLMChatCompletions(settings, body);
  if (response.status < 200 || response.status >= 300) {
    const detail = parseErrorMessage(response.body, response.status);
    throw new Error(`服务员响应失败: ${detail}`);
  }

  const payload = parseCompletionPayload(response.body);
  const requestId =
    typeof payload.id === "string" && payload.id.trim() ? payload.id : createRequestId("chat");

  const firstChoice = payload.choices?.[0];
  const rawMessage = firstChoice?.message;
  if (!rawMessage) {
    throw new Error("模型响应缺少 message。");
  }

  const toolCalls = parseToolCalls(rawMessage.tool_calls);
  const assistantMessage: LiteLLMMessage = {
    role: "assistant",
    content: normalizeMessageContent(rawMessage.content),
    tool_calls: toolCalls.length ? toolCalls : undefined
  };

  return {
    assistantMessage,
    toolCalls,
    requestRecord: {
      requestId,
      inputLength: inputLengthOf(messages),
      outputLength: response.body.length
    }
  };
}

async function runNativeToolCallingLoop(
  prompt: string,
  settings: AppSettings,
  conversationHistory: LiteLLMMessage[],
  signal?: AbortSignal,
  onAssistantChunk?: (chunk: string) => void
): Promise<{
  assistantReply: string;
  requestRecords: RequestRecord[];
  proposedActions: ActionProposal[];
  toolTrace: ToolExecutionTrace[];
}> {
  const runtimeContext = createRuntimeContextPrompt(settings);
  const messages: LiteLLMMessage[] = [
    { role: "system", content: ASSISTANT_SYSTEM_PROMPT },
    { role: "system", content: runtimeContext },
    ...conversationHistory,
    { role: "user", content: prompt }
  ];

  const requestRecords: RequestRecord[] = [];
  const proposedActions: ActionProposal[] = [];
  const toolTrace: ToolExecutionTrace[] = [];

  for (let turn = 0; turn < MAX_TOOL_LOOP_TURNS; turn += 1) {
    const completion = await requestToolCompletion(messages, settings, signal);
    requestRecords.push(completion.requestRecord);
    messages.push(completion.assistantMessage);

    if (!completion.toolCalls.length) {
      const finalText = completion.assistantMessage.content.trim();
      onAssistantChunk?.(finalText);
      return {
        assistantReply: finalText,
        requestRecords,
        proposedActions,
        toolTrace
      };
    }

    for (const toolCall of completion.toolCalls) {
      const { result: toolResult, trace } = await executeToolCallWithRetry(
        toolCall,
        settings.workspacePath
      );
      toolTrace.push(trace);
      if (toolResult.proposedAction) {
        proposedActions.push(toolResult.proposedAction);
      }
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        name: toolCall.function.name,
        content: toolResult.content
      });
    }

    if (proposedActions.length > 0) {
      return {
        assistantReply: completion.assistantMessage.content.trim(),
        requestRecords,
        proposedActions,
        toolTrace
      };
    }
  }

  return {
    assistantReply: "已达到工具调用轮次上限，请缩小任务范围后重试。",
    requestRecords,
    proposedActions,
    toolTrace
  };
}

function sanitizeStepsFromPrompt(prompt: string): PlanStep[] {
  const normalized = prompt.trim() || "实现用户提出的功能";
  return [
    {
      id: "step-plan",
      owner: "planner",
      summary: `分析需求并拆解执行步骤: ${normalized}`
    },
    {
      id: "step-implement",
      owner: "coder",
      summary: "基于任务生成实现或回答"
    },
    {
      id: "step-verify",
      owner: "tester",
      summary: "补充验证建议并总结风险"
    }
  ];
}

function buildProposedActions(prompt: string, fromTools: ActionProposal[]): ActionProposal[] {
  const uniqueActions: ActionProposal[] = [];
  const seen = new Set<string>();

  for (const action of fromTools) {
    const validationError = validateProposedAction(action, prompt);
    if (validationError) {
      continue;
    }

    const fingerprint = actionFingerprint(action);
    if (seen.has(fingerprint)) {
      continue;
    }
    seen.add(fingerprint);
    uniqueActions.push(action);
  }

  return uniqueActions;
}

function initializePlan(
  prompt: string,
  settings: AppSettings,
  proposedActions: ActionProposal[]
): OrchestrationPlan {
  const steps = sanitizeStepsFromPrompt(prompt);
  return {
    state: proposedActions.length ? "human_review" : "done",
    prompt: prompt.trim() || "实现用户提出的功能",
    steps,
    proposedActions,
    workspacePath: settings.workspacePath.trim()
  };
}

function hasExplicitGitIntent(prompt: string): boolean {
  const corpus = prompt.toLowerCase();
  return (
    corpus.includes("git") ||
    corpus.includes("commit") ||
    corpus.includes("branch") ||
    corpus.includes("checkout") ||
    corpus.includes("提交") ||
    corpus.includes("分支") ||
    corpus.includes("暂存")
  );
}

function actionFingerprint(action: ActionProposal): string {
  if (action.type === "apply_patch") {
    return `${action.type}:${action.payload.patch.trim()}`;
  }
  if (action.type === "run_command") {
    return `${action.type}:${action.payload.command.trim()}:${action.payload.timeoutMs}`;
  }
  return `${action.type}:${action.payload.operation}:${action.payload.branchName}:${action.payload.message}:${action.payload.allowEmpty}`;
}

function validateProposedAction(action: ActionProposal, prompt: string): string | null {
  if (action.type === "apply_patch") {
    if (!action.payload.patch.trim()) {
      return "patch 不能为空";
    }
    return null;
  }

  if (action.type === "run_command") {
    if (!action.payload.command.trim()) {
      return "command 不能为空";
    }
    if (action.payload.timeoutMs < 1000 || action.payload.timeoutMs > 600000) {
      return "timeout 超出范围";
    }
    return null;
  }

  if (!hasExplicitGitIntent(prompt)) {
    return "未检测到明确 git 意图";
  }
  if (!action.payload.message.trim()) {
    return "git message 不能为空";
  }
  if (!action.payload.branchName.trim()) {
    return "branch 不能为空";
  }
  return null;
}

function createRuntimeContextPrompt(settings: AppSettings): string {
  const workspacePath = settings.workspacePath.trim();
  const workspaceLine = workspacePath
    ? `当前工作区: ${workspacePath}`
    : "当前工作区: 未选择";
  const agentLines = DEFAULT_AGENTS.map(
    (agent) =>
      `- ${agent.role}: tools=[${agent.tools.join(", ")}], sensitiveActionAllowed=${agent.sensitiveActionAllowed}`
  );

  return [
    "运行时上下文：",
    workspaceLine,
    "可用角色与能力：",
    ...agentLines,
    "Guardrails: 默认只读；未经审批不得执行写盘/命令/git 写操作。",
    "如需文件系统信息，必须通过已定义工具调用，不得臆测。"
  ].join("\n");
}

function assertLocalOnlyPolicy(settings: AppSettings): void {
  if (settings.allowCloudModels) {
    return;
  }

  if (isLocalProvider(settings.provider)) {
    return;
  }

  throw new LocalOnlyPolicyError("Local-only 已开启，请切换到本地 Provider（如 Ollama）后再发起请求。");
}

export async function runPlanningSession(
  input: RunPlanningSessionInput
): Promise<PlanningSessionResult> {
  const normalizedPrompt = input.prompt.trim();
  if (!normalizedPrompt) {
    throw new Error("请输入任务描述后再发送。");
  }

  assertLocalOnlyPolicy(input.settings);
  const maxTokens = input.settings.maxContextTokens || 128000;
  const historyMessages = sanitizeConversationHistory(input.conversationHistory, maxTokens);

  try {
    const loopResult = await runNativeToolCallingLoop(
      normalizedPrompt,
      input.settings,
      historyMessages,
      input.signal,
      input.onAssistantChunk
    );

    for (const record of loopResult.requestRecords) {
      recordLLMAudit({
        requestId: record.requestId,
        provider: input.settings.provider,
        model: input.settings.model,
        timestamp: new Date().toISOString(),
        inputLength: record.inputLength,
        outputLength: record.outputLength
      });
    }

    const proposedActions = buildProposedActions(normalizedPrompt, loopResult.proposedActions);
    const plan = initializePlan(normalizedPrompt, input.settings, proposedActions);

    return {
      assistantReply: loopResult.assistantReply,
      plan,
      toolTrace: loopResult.toolTrace
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    console.error("runPlanningSession failed:", error);
    const errorMessage = String(error || "Unknown error");
    const fallbackPlan = initializePlan(normalizedPrompt, input.settings, []);
    return {
      assistantReply: `服务员暂时无法完成本轮工具调用，请稍后重试。\n\n**错误详情**：\n\`\`\`\n${errorMessage}\n\`\`\``,
      plan: fallbackPlan,
      toolTrace: []
    };
  }
}
