/**
 * Cofree - AI Programming Cafe
 * File: src/orchestrator/planningService.ts
 * Milestone: 2
 * Task: 2.1
 * Status: Completed
 * Owner: Codex-GPT-5
 * Last Modified: 2026-02-27
 * Description: Streaming planning pipeline with local-only policy and structured plan output.
 */

import { DEFAULT_AGENTS, type AgentRole } from "../agents/defaultAgents";
import { recordLLMAudit } from "../lib/auditLog";
import {
  createLiteLLMClientConfig,
  createLiteLLMRequestBody,
  isLocalProvider,
  type LiteLLMMessage
} from "../lib/litellm";
import type { AppSettings } from "../lib/settingsStore";
import { draftPlanFromPrompt } from "./mockOrchestrator";
import type { ActionProposal, OrchestrationPlan, SensitiveActionType } from "./types";

const PLAN_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["state", "prompt", "steps"],
  properties: {
    state: {
      type: "string",
      enum: ["planning"]
    },
    prompt: {
      type: "string"
    },
    steps: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "summary", "owner"],
        properties: {
          id: { type: "string" },
          summary: { type: "string" },
          owner: {
            type: "string",
            enum: ["planner", "coder", "tester"]
          }
        }
      }
    }
  }
} as const;

const ASSISTANT_SYSTEM_PROMPT = [
  "你是 Cofree 的服务员。",
  "先给用户一个简洁、可执行的回复，解释你将如何规划任务。",
  "不要声称已经执行写盘、命令或 git 写操作。",
  "回复语言与用户保持一致。"
].join("\n");

const PLAN_SYSTEM_PROMPT = [
  "你是 Cofree Planner。",
  "请根据用户需求与已有服务员回复，输出严格 JSON。",
  "只输出 JSON，不要额外解释。",
  "state 必须是 planning，steps owner 仅可用 planner/coder/tester。"
].join("\n");

const AGENT_ROLE_SEQUENCE: AgentRole[] = ["planner", "coder", "tester"];

export class LocalOnlyPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalOnlyPolicyError";
  }
}

export interface RunPlanningSessionInput {
  prompt: string;
  settings: AppSettings;
  signal?: AbortSignal;
  onAssistantChunk?: (chunk: string) => void;
}

export interface PlanningSessionResult {
  assistantReply: string;
  plan: OrchestrationPlan;
}

interface StreamResult {
  text: string;
  requestId: string;
}

interface JsonCompletionResult {
  rawContent: string;
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

function extractJsonCandidate(raw: string): string {
  const trimmed = raw.trim();
  const fencedMatch = trimmed.match(/^```json\s*([\s\S]*?)\s*```$/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  return trimmed;
}

function sanitizeSteps(rawSteps: unknown): OrchestrationPlan["steps"] {
  if (!Array.isArray(rawSteps)) {
    return [];
  }

  const normalizedSteps = rawSteps
    .map((step, index) => {
      if (!step || typeof step !== "object") {
        return null;
      }

      const record = step as Record<string, unknown>;
      const summary = typeof record.summary === "string" ? record.summary.trim() : "";
      if (!summary) {
        return null;
      }

      const ownerCandidate = typeof record.owner === "string" ? record.owner : "";
      const owner = AGENT_ROLE_SEQUENCE.includes(ownerCandidate as AgentRole)
        ? (ownerCandidate as AgentRole)
        : AGENT_ROLE_SEQUENCE[index % AGENT_ROLE_SEQUENCE.length];

      const id = typeof record.id === "string" && record.id.trim() ? record.id : `step-${index + 1}`;

      return {
        id,
        owner,
        summary
      };
    })
    .filter((step): step is OrchestrationPlan["steps"][number] => Boolean(step));

  return normalizedSteps.slice(0, 8);
}

function createPendingActions(): ActionProposal[] {
  const gates: Array<{ id: string; type: SensitiveActionType; description: string }> = [
    {
      id: "gate-a-apply-patch",
      type: "apply_patch",
      description: "Apply generated patch to workspace (Gate A)"
    },
    {
      id: "gate-b-run-command",
      type: "run_command",
      description: "Run allowlisted validation command (Gate B)"
    },
    {
      id: "gate-c-git-write",
      type: "git_write",
      description: "Stage/commit approved changes (Gate C)"
    }
  ];

  return gates.map((gate) => ({
    ...gate,
    gateRequired: true,
    status: "pending",
    executed: false
  }));
}

function buildPlanFromJson(rawJson: string, prompt: string): OrchestrationPlan {
  try {
    const parsed = JSON.parse(extractJsonCandidate(rawJson)) as Record<string, unknown>;
    const normalizedPrompt =
      typeof parsed.prompt === "string" && parsed.prompt.trim() ? parsed.prompt.trim() : prompt.trim();
    const normalizedSteps = sanitizeSteps(parsed.steps);

    if (!normalizedSteps.length) {
      return draftPlanFromPrompt(prompt);
    }

    return {
      state: "planning",
      prompt: normalizedPrompt || "实现用户提出的功能",
      steps: normalizedSteps,
      proposedActions: createPendingActions()
    };
  } catch (_error) {
    return draftPlanFromPrompt(prompt);
  }
}

function inputLengthOf(messages: LiteLLMMessage[]): number {
  return messages.reduce((total, message) => total + message.content.length, 0);
}

async function parseJsonResponse(response: Response): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (_error) {
    throw new Error("模型响应不是有效 JSON。");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("模型响应结构异常。");
  }

  return parsed as Record<string, unknown>;
}

async function parseErrorMessage(response: Response): Promise<string> {
  const raw = await response.text();
  if (!raw.trim()) {
    return `${response.status} ${response.statusText}`;
  }

  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } };
    return parsed.error?.message ?? raw.slice(0, 240);
  } catch (_error) {
    return raw.slice(0, 240);
  }
}

function extractDeltaContent(choice: unknown): string {
  if (!choice || typeof choice !== "object") {
    return "";
  }

  const delta = (choice as { delta?: { content?: unknown } }).delta;
  const rawContent = delta?.content;
  return normalizeMessageContent(rawContent);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function consumeSSEPayload(
  chunkText: string,
  onPayload: (payload: string) => void
): void {
  const lines = chunkText.split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith("data:")) {
      continue;
    }

    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") {
      continue;
    }

    onPayload(payload);
  }
}

async function streamAssistantReply(
  messages: LiteLLMMessage[],
  settings: AppSettings,
  signal: AbortSignal | undefined,
  onAssistantChunk: ((chunk: string) => void) | undefined
): Promise<StreamResult> {
  const client = createLiteLLMClientConfig(settings);
  const response = await fetch(client.endpoint, {
    method: "POST",
    headers: client.headers,
    body: JSON.stringify(createLiteLLMRequestBody(messages, settings)),
    signal
  });

  if (!response.ok) {
    const detail = await parseErrorMessage(response);
    throw new Error(`服务员流式响应失败: ${detail}`);
  }

  if (!response.body) {
    throw new Error("服务员流式响应为空。");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let requestId = createRequestId("stream");

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? "";

    for (const eventChunk of events) {
      consumeSSEPayload(eventChunk, (payload) => {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(payload) as Record<string, unknown>;
        } catch (_error) {
          return;
        }

        if (typeof parsed.id === "string") {
          requestId = parsed.id;
        }

        const choices = parsed.choices;
        if (!Array.isArray(choices) || !choices[0]) {
          return;
        }

        const nextToken = extractDeltaContent(choices[0]);
        if (!nextToken) {
          return;
        }

        text += nextToken;
        onAssistantChunk?.(nextToken);
      });
    }
  }

  if (buffer.trim()) {
    consumeSSEPayload(buffer, (payload) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(payload) as Record<string, unknown>;
      } catch (_error) {
        return;
      }

      if (typeof parsed.id === "string") {
        requestId = parsed.id;
      }

      const choices = parsed.choices;
      if (!Array.isArray(choices) || !choices[0]) {
        return;
      }

      const nextToken = extractDeltaContent(choices[0]);
      if (!nextToken) {
        return;
      }

      text += nextToken;
      onAssistantChunk?.(nextToken);
    });
  }

  return {
    text: text.trim(),
    requestId
  };
}

async function requestStructuredPlan(
  prompt: string,
  assistantReply: string,
  settings: AppSettings,
  signal: AbortSignal | undefined
): Promise<JsonCompletionResult> {
  const messages: LiteLLMMessage[] = [
    {
      role: "system",
      content: PLAN_SYSTEM_PROMPT
    },
    {
      role: "user",
      content: JSON.stringify({
        prompt,
        assistantReply,
        availableAgents: DEFAULT_AGENTS.map((agent) => ({
          role: agent.role,
          intent: agent.promptIntent
        })),
        requiredPendingActions: ["apply_patch", "run_command", "git_write"],
        outputInstruction:
          "根据 prompt 生成执行步骤，steps 为数组，每个 step 必须有 id/summary/owner。"
      })
    }
  ];

  const client = createLiteLLMClientConfig(settings);
  const body = {
    ...createLiteLLMRequestBody(messages, settings, {
      responseFormat: {
        type: "json_schema",
        json_schema: {
          name: "orchestration_plan",
          schema: PLAN_RESPONSE_SCHEMA as unknown as Record<string, unknown>,
          strict: true
        }
      }
    }),
    stream: false,
    temperature: 0.1
  };

  const response = await fetch(client.endpoint, {
    method: "POST",
    headers: client.headers,
    body: JSON.stringify(body),
    signal
  });

  if (!response.ok) {
    const detail = await parseErrorMessage(response);
    throw new Error(`结构化计划生成失败: ${detail}`);
  }

  const payload = await parseJsonResponse(response);
  const requestId =
    typeof payload.id === "string" && payload.id.trim() ? payload.id : createRequestId("plan");

  const choices = payload.choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") {
    throw new Error("结构化计划响应缺少 choices。");
  }

  const message = (choices[0] as { message?: { content?: unknown } }).message;
  const rawContent = normalizeMessageContent(message?.content);

  if (!rawContent.trim()) {
    throw new Error("结构化计划响应为空。");
  }

  recordLLMAudit({
    requestId,
    provider: settings.provider,
    model: settings.model,
    timestamp: new Date().toISOString(),
    inputLength: inputLengthOf(messages),
    outputLength: rawContent.length
  });

  return {
    rawContent
  };
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

  const messages: LiteLLMMessage[] = [
    { role: "system", content: ASSISTANT_SYSTEM_PROMPT },
    { role: "user", content: normalizedPrompt }
  ];

  const streamResult = await streamAssistantReply(
    messages,
    input.settings,
    input.signal,
    input.onAssistantChunk
  );

  recordLLMAudit({
    requestId: streamResult.requestId,
    provider: input.settings.provider,
    model: input.settings.model,
    timestamp: new Date().toISOString(),
    inputLength: inputLengthOf(messages),
    outputLength: streamResult.text.length
  });

  try {
    const jsonPlan = await requestStructuredPlan(
      normalizedPrompt,
      streamResult.text,
      input.settings,
      input.signal
    );

    return {
      assistantReply: streamResult.text,
      plan: buildPlanFromJson(jsonPlan.rawContent, normalizedPrompt)
    };
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }

    return {
      assistantReply: streamResult.text,
      plan: draftPlanFromPrompt(normalizedPrompt)
    };
  }
}
