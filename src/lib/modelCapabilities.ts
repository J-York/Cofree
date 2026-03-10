/**
 * Cofree - AI Programming Cafe
 * File: src/lib/modelCapabilities.ts
 * Description: Model capability detection and parameter adaptation layer.
 *
 * Different LLMs have vastly different strengths, weaknesses, and API quirks.
 * Mature Vibe Coding tools (Cursor, Cline, Windsurf) adapt their behavior
 * per-model. This module centralizes that knowledge so the rest of the
 * codebase can query capabilities instead of hard-coding model names.
 */

import type { VendorProtocol } from "./settingsStore";

// ---------------------------------------------------------------------------
// Model family detection
// ---------------------------------------------------------------------------

export type ModelFamily =
  | "gpt-4o"
  | "gpt-4.1"
  | "gpt-4-turbo"
  | "gpt-3.5"
  | "o1"
  | "o3"
  | "o4-mini"
  | "claude-3.5-sonnet"
  | "claude-3.5-haiku"
  | "claude-3-opus"
  | "claude-4-sonnet"
  | "claude-4-opus"
  | "gemini-2.5"
  | "gemini-2.0"
  | "gemini-1.5"
  | "deepseek-v3"
  | "deepseek-r1"
  | "qwen-3"
  | "qwen-2.5"
  | "qwen-coder"
  | "llama-3"
  | "mistral"
  | "codestral"
  | "unknown";

const MODEL_FAMILY_PATTERNS: Array<{ pattern: RegExp; family: ModelFamily }> = [
  // OpenAI — order matters: more specific patterns first
  { pattern: /o4-mini/i, family: "o4-mini" },
  { pattern: /o3/i, family: "o3" },
  { pattern: /o1/i, family: "o1" },
  { pattern: /gpt-4\.1/i, family: "gpt-4.1" },
  { pattern: /gpt-4o/i, family: "gpt-4o" },
  { pattern: /gpt-4-turbo/i, family: "gpt-4-turbo" },
  { pattern: /gpt-3\.5/i, family: "gpt-3.5" },

  // Anthropic
  { pattern: /claude-4[.-]?opus/i, family: "claude-4-opus" },
  { pattern: /claude-4[.-]?sonnet/i, family: "claude-4-sonnet" },
  { pattern: /claude-3[.-]?5[.-]?sonnet/i, family: "claude-3.5-sonnet" },
  { pattern: /claude-3[.-]?5[.-]?haiku/i, family: "claude-3.5-haiku" },
  { pattern: /claude-3[.-]?opus/i, family: "claude-3-opus" },

  // Google
  { pattern: /gemini[- ]?2\.5/i, family: "gemini-2.5" },
  { pattern: /gemini[- ]?2\.0/i, family: "gemini-2.0" },
  { pattern: /gemini[- ]?1\.5/i, family: "gemini-1.5" },

  // DeepSeek
  { pattern: /deepseek[- ]?r1/i, family: "deepseek-r1" },
  { pattern: /deepseek[- ]?(v3|chat|coder)/i, family: "deepseek-v3" },

  // Qwen
  { pattern: /qwen[- ]?3/i, family: "qwen-3" },
  { pattern: /qwen[- ]?2\.5[- ]?coder/i, family: "qwen-coder" },
  { pattern: /qwen[- ]?2\.5/i, family: "qwen-2.5" },
  { pattern: /qwen[- ]?coder/i, family: "qwen-coder" },

  // Meta
  { pattern: /llama[- ]?3/i, family: "llama-3" },

  // Mistral
  { pattern: /codestral/i, family: "codestral" },
  { pattern: /mistral/i, family: "mistral" },
];

export function detectModelFamily(modelRef: string): ModelFamily {
  const normalized = modelRef.trim().toLowerCase();
  for (const { pattern, family } of MODEL_FAMILY_PATTERNS) {
    if (pattern.test(normalized)) {
      return family;
    }
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Capability profile
// ---------------------------------------------------------------------------

export interface ModelCapabilities {
  /** Model family identifier */
  family: ModelFamily;

  /** Whether the model natively supports function/tool calling */
  supportsToolCalling: boolean;

  /** Whether the model can handle parallel tool calls in a single response */
  supportsParallelToolCalls: boolean;

  /** Whether the model supports structured JSON output (response_format) */
  supportsStructuredOutput: boolean;

  /** Whether the model has a native thinking/reasoning mode */
  supportsThinking: boolean;

  /** Recommended temperature for coding tasks (lower = more deterministic) */
  recommendedTemperature: number;

  /** Recommended max output tokens (0 = use model default) */
  recommendedMaxTokens: number;

  /** Default context window size in tokens */
  contextWindowSize: number;

  /** Whether to send tool_choice="auto" or omit it */
  preferExplicitToolChoice: boolean;

  /** Whether the model tends to be verbose and needs stronger brevity hints */
  needsBrevityHints: boolean;

  /** Whether the model struggles with complex multi-step tool chains */
  needsStepByStepGuidance: boolean;

  /** Whether to include few-shot examples in tool descriptions */
  benefitsFromFewShot: boolean;

  /** Whether the model sometimes hallucinates tool names or parameters */
  proneToToolHallucination: boolean;

  /** Model-specific system prompt additions */
  systemPromptAdditions: string[];

  /** Preferred tool_choice value when tools are provided */
  defaultToolChoice: "auto" | "none" | undefined;

  /** Whether to set parallel_tool_calls explicitly */
  parallelToolCallsParam: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Capability profiles per family
// ---------------------------------------------------------------------------

const BASE_CAPABILITIES: ModelCapabilities = {
  family: "unknown",
  supportsToolCalling: true,
  supportsParallelToolCalls: false,
  supportsStructuredOutput: false,
  supportsThinking: false,
  recommendedTemperature: 0.2,
  recommendedMaxTokens: 0,
  contextWindowSize: 128000,
  preferExplicitToolChoice: true,
  needsBrevityHints: false,
  needsStepByStepGuidance: true,
  benefitsFromFewShot: true,
  proneToToolHallucination: true,
  systemPromptAdditions: [],
  defaultToolChoice: "auto",
  parallelToolCallsParam: undefined,
};

const FAMILY_OVERRIDES: Partial<Record<ModelFamily, Partial<ModelCapabilities>>> = {
  "gpt-4o": {
    supportsParallelToolCalls: true,
    supportsStructuredOutput: true,
    recommendedTemperature: 0,
    contextWindowSize: 128000,
    needsStepByStepGuidance: false,
    proneToToolHallucination: false,
    benefitsFromFewShot: false,
    parallelToolCallsParam: true,
  },
  "gpt-4.1": {
    supportsParallelToolCalls: true,
    supportsStructuredOutput: true,
    recommendedTemperature: 0,
    contextWindowSize: 1048576,
    needsStepByStepGuidance: false,
    proneToToolHallucination: false,
    benefitsFromFewShot: false,
    parallelToolCallsParam: true,
    systemPromptAdditions: [
      "你是一个高效的编程助手。直接执行任务，不要解释你将要做什么。",
    ],
  },
  "gpt-4-turbo": {
    supportsParallelToolCalls: true,
    supportsStructuredOutput: true,
    recommendedTemperature: 0,
    contextWindowSize: 128000,
    needsStepByStepGuidance: false,
    proneToToolHallucination: false,
    benefitsFromFewShot: false,
    parallelToolCallsParam: true,
  },
  "gpt-3.5": {
    supportsParallelToolCalls: true,
    supportsStructuredOutput: false,
    recommendedTemperature: 0,
    contextWindowSize: 16385,
    needsStepByStepGuidance: true,
    proneToToolHallucination: true,
    benefitsFromFewShot: true,
    needsBrevityHints: true,
    systemPromptAdditions: [
      "重要：每次只调用一个工具。完成一个工具调用后等待结果再决定下一步。",
      "不要在回复中包含代码块，所有代码修改必须通过 propose_file_edit 工具完成。",
    ],
  },
  "o1": {
    supportsToolCalling: false,
    supportsParallelToolCalls: false,
    supportsStructuredOutput: false,
    supportsThinking: true,
    recommendedTemperature: 1,
    contextWindowSize: 200000,
    needsStepByStepGuidance: false,
    proneToToolHallucination: true,
    benefitsFromFewShot: false,
    systemPromptAdditions: [
      "你是一个推理型模型。请在回复中直接给出分析结论和具体的代码修改建议。",
    ],
  },
  "o3": {
    supportsToolCalling: true,
    supportsParallelToolCalls: true,
    supportsStructuredOutput: true,
    supportsThinking: true,
    recommendedTemperature: 1,
    contextWindowSize: 200000,
    needsStepByStepGuidance: false,
    proneToToolHallucination: false,
    benefitsFromFewShot: false,
    parallelToolCallsParam: true,
  },
  "o4-mini": {
    supportsToolCalling: true,
    supportsParallelToolCalls: true,
    supportsStructuredOutput: true,
    supportsThinking: true,
    recommendedTemperature: 1,
    contextWindowSize: 200000,
    needsStepByStepGuidance: false,
    proneToToolHallucination: false,
    benefitsFromFewShot: false,
    parallelToolCallsParam: true,
  },
  "claude-3.5-sonnet": {
    supportsParallelToolCalls: false,
    supportsStructuredOutput: false,
    supportsThinking: false,
    recommendedTemperature: 0.2,
    contextWindowSize: 200000,
    recommendedMaxTokens: 8192,
    needsStepByStepGuidance: false,
    proneToToolHallucination: false,
    benefitsFromFewShot: false,
    preferExplicitToolChoice: true,
    systemPromptAdditions: [
      "每次工具调用后等待结果返回再继续。不要在一次回复中假设多个工具调用的结果。",
    ],
  },
  "claude-3.5-haiku": {
    supportsParallelToolCalls: false,
    supportsStructuredOutput: false,
    recommendedTemperature: 0.2,
    contextWindowSize: 200000,
    recommendedMaxTokens: 8192,
    needsStepByStepGuidance: true,
    proneToToolHallucination: false,
    benefitsFromFewShot: true,
    needsBrevityHints: true,
    systemPromptAdditions: [
      "保持回复简洁。优先使用工具获取信息，不要猜测文件内容。",
    ],
  },
  "claude-3-opus": {
    supportsParallelToolCalls: false,
    supportsStructuredOutput: false,
    supportsThinking: false,
    recommendedTemperature: 0.2,
    contextWindowSize: 200000,
    recommendedMaxTokens: 4096,
    needsStepByStepGuidance: false,
    proneToToolHallucination: false,
    benefitsFromFewShot: false,
    needsBrevityHints: true,
    systemPromptAdditions: [
      "你的输出 token 限制较低，请保持回复极简。所有代码修改通过工具完成，不要在回复中重复代码。",
    ],
  },
  "claude-4-sonnet": {
    supportsParallelToolCalls: true,
    supportsStructuredOutput: false,
    supportsThinking: true,
    recommendedTemperature: 0.2,
    contextWindowSize: 200000,
    recommendedMaxTokens: 16384,
    needsStepByStepGuidance: false,
    proneToToolHallucination: false,
    benefitsFromFewShot: false,
  },
  "claude-4-opus": {
    supportsParallelToolCalls: true,
    supportsStructuredOutput: false,
    supportsThinking: true,
    recommendedTemperature: 0.2,
    contextWindowSize: 200000,
    recommendedMaxTokens: 32768,
    needsStepByStepGuidance: false,
    proneToToolHallucination: false,
    benefitsFromFewShot: false,
  },
  "gemini-2.5": {
    supportsParallelToolCalls: true,
    supportsStructuredOutput: true,
    supportsThinking: true,
    recommendedTemperature: 0,
    contextWindowSize: 1048576,
    needsStepByStepGuidance: false,
    proneToToolHallucination: false,
    benefitsFromFewShot: false,
    parallelToolCallsParam: true,
    systemPromptAdditions: [
      "你可以并行调用多个工具。当需要读取多个文件时，在一次回复中同时调用多个 read_file。",
    ],
  },
  "gemini-2.0": {
    supportsParallelToolCalls: true,
    supportsStructuredOutput: true,
    recommendedTemperature: 0,
    contextWindowSize: 1048576,
    needsStepByStepGuidance: false,
    proneToToolHallucination: false,
    benefitsFromFewShot: false,
    parallelToolCallsParam: true,
  },
  "gemini-1.5": {
    supportsParallelToolCalls: true,
    supportsStructuredOutput: true,
    recommendedTemperature: 0,
    contextWindowSize: 2097152,
    needsStepByStepGuidance: false,
    proneToToolHallucination: true,
    benefitsFromFewShot: true,
  },
  "deepseek-v3": {
    supportsParallelToolCalls: false,
    supportsStructuredOutput: false,
    recommendedTemperature: 0,
    contextWindowSize: 65536,
    needsStepByStepGuidance: true,
    proneToToolHallucination: true,
    benefitsFromFewShot: true,
    needsBrevityHints: true,
    systemPromptAdditions: [
      "重要约束：",
      "1. 每次只调用一个工具，等待结果后再决定下一步。",
      "2. 工具参数必须严格遵循 JSON Schema，不要添加未定义的字段。",
      "3. 文件路径使用相对路径，不要使用绝对路径。",
    ],
  },
  "deepseek-r1": {
    supportsToolCalling: false,
    supportsParallelToolCalls: false,
    supportsStructuredOutput: false,
    supportsThinking: true,
    recommendedTemperature: 0.6,
    contextWindowSize: 65536,
    needsStepByStepGuidance: false,
    proneToToolHallucination: true,
    benefitsFromFewShot: false,
    systemPromptAdditions: [
      "你是一个推理型模型，不支持工具调用。请在回复中直接给出完整的分析和代码修改建议。",
      "使用 markdown 代码块展示需要修改的代码，并标注文件路径。",
    ],
  },
  "qwen-3": {
    supportsParallelToolCalls: false,
    supportsStructuredOutput: true,
    recommendedTemperature: 0.1,
    contextWindowSize: 131072,
    needsStepByStepGuidance: true,
    proneToToolHallucination: true,
    benefitsFromFewShot: true,
    systemPromptAdditions: [
      "严格按照工具定义的参数格式调用工具。每次只调用一个工具。",
    ],
  },
  "qwen-2.5": {
    supportsParallelToolCalls: false,
    supportsStructuredOutput: true,
    recommendedTemperature: 0.1,
    contextWindowSize: 131072,
    needsStepByStepGuidance: true,
    proneToToolHallucination: true,
    benefitsFromFewShot: true,
    systemPromptAdditions: [
      "严格按照工具定义的参数格式调用工具。每次只调用一个工具。",
      "不要在工具参数中使用注释或省略号。",
    ],
  },
  "qwen-coder": {
    supportsParallelToolCalls: false,
    supportsStructuredOutput: true,
    recommendedTemperature: 0,
    contextWindowSize: 131072,
    needsStepByStepGuidance: true,
    proneToToolHallucination: true,
    benefitsFromFewShot: true,
    systemPromptAdditions: [
      "你是一个专业的编程模型。严格按照工具定义调用工具，不要添加额外字段。",
    ],
  },
  "llama-3": {
    supportsParallelToolCalls: false,
    supportsStructuredOutput: false,
    recommendedTemperature: 0.1,
    contextWindowSize: 131072,
    needsStepByStepGuidance: true,
    proneToToolHallucination: true,
    benefitsFromFewShot: true,
    needsBrevityHints: true,
    systemPromptAdditions: [
      "重要：工具调用必须严格遵循 JSON 格式。每次只调用一个工具。",
      "不要在回复中编造工具调用结果，必须等待系统返回实际结果。",
    ],
  },
  "mistral": {
    supportsParallelToolCalls: true,
    supportsStructuredOutput: true,
    recommendedTemperature: 0.1,
    contextWindowSize: 131072,
    needsStepByStepGuidance: true,
    proneToToolHallucination: true,
    benefitsFromFewShot: true,
  },
  "codestral": {
    supportsParallelToolCalls: true,
    supportsStructuredOutput: true,
    recommendedTemperature: 0,
    contextWindowSize: 262144,
    needsStepByStepGuidance: false,
    proneToToolHallucination: false,
    benefitsFromFewShot: true,
  },
};

export function getModelCapabilities(
  modelRef: string,
  protocol?: VendorProtocol,
): ModelCapabilities {
  const family = detectModelFamily(modelRef);
  const overrides = FAMILY_OVERRIDES[family] ?? {};

  const capabilities: ModelCapabilities = {
    ...BASE_CAPABILITIES,
    ...overrides,
    family,
  };

  // Protocol-level adjustments
  if (protocol === "anthropic-messages") {
    // Anthropic API doesn't support parallel_tool_calls parameter
    capabilities.parallelToolCallsParam = undefined;
  }

  return capabilities;
}

// ---------------------------------------------------------------------------
// Request parameter adaptation
// ---------------------------------------------------------------------------

export interface AdaptedRequestParams {
  temperature: number;
  maxTokens: number | undefined;
  toolChoice: "auto" | "none" | undefined;
  parallelToolCalls: boolean | undefined;
  systemPromptAdditions: string[];
}

/**
 * Compute adapted request parameters based on model capabilities.
 * This is the main entry point for the orchestrator to get model-specific
 * tuning before sending a request.
 */
export function adaptRequestParams(
  modelRef: string,
  protocol: VendorProtocol,
  hasTools: boolean,
  overrideTemperature?: number,
): AdaptedRequestParams {
  const capabilities = getModelCapabilities(modelRef, protocol);

  const temperature = overrideTemperature ?? capabilities.recommendedTemperature;

  const maxTokens = capabilities.recommendedMaxTokens > 0
    ? capabilities.recommendedMaxTokens
    : undefined;

  let toolChoice: "auto" | "none" | undefined;
  if (hasTools && capabilities.supportsToolCalling) {
    toolChoice = capabilities.preferExplicitToolChoice ? "auto" : undefined;
  } else if (hasTools && !capabilities.supportsToolCalling) {
    toolChoice = "none";
  }

  const parallelToolCalls = hasTools ? capabilities.parallelToolCallsParam : undefined;

  return {
    temperature,
    maxTokens,
    toolChoice,
    parallelToolCalls,
    systemPromptAdditions: capabilities.systemPromptAdditions,
  };
}

// ---------------------------------------------------------------------------
// Context window budget helpers
// ---------------------------------------------------------------------------

/**
 * Get the effective context window size for a model, accounting for
 * output token reservation.
 */
export function getEffectiveContextBudget(
  modelRef: string,
  protocol?: VendorProtocol,
  outputReservation = 0.15,
): number {
  const capabilities = getModelCapabilities(modelRef, protocol);
  const reserved = Math.floor(capabilities.contextWindowSize * outputReservation);
  return capabilities.contextWindowSize - reserved;
}
