/**
 * Cofree - AI Programming Cafe
 * File: src/lib/modelGateway.ts
 * Description: Provider-neutral model gateway that wraps litellm.ts.
 *
 * Upper layers (orchestrator, agent runtime) should call this gateway
 * instead of directly reading settings to build requests. This decouples
 * model selection from the execution loop.
 */

import type { ResolvedAgentRuntime } from "../agents/types";
import type { AppSettings, VendorProtocol } from "./settingsStore";
import {
  createLiteLLMClientConfig,
  createLiteLLMRequestBody,
  type LiteLLMClientConfig,
  type LiteLLMMessage,
  type LiteLLMToolDefinition,
} from "./litellm";
import {
  adaptRequestParams,
  getModelCapabilities,
  type ModelCapabilities,
} from "./modelCapabilities";

export interface ModelGatewayConfig {
  endpoint: string;
  headers: Record<string, string>;
  modelRef: string;
  protocol: VendorProtocol;
}

/**
 * Build a ModelGatewayConfig from the current agent runtime.
 * Falls back to the global settings-based config when the runtime
 * doesn't carry enough information (e.g. legacy code paths).
 */
export function createModelGatewayConfig(
  runtime: ResolvedAgentRuntime | null,
  settings: AppSettings,
): ModelGatewayConfig {
  if (!runtime) {
    return createLiteLLMClientConfig(settings);
  }

  const protocol = (runtime.vendorProtocol || "openai-chat-completions") as VendorProtocol;

  const litellmConfig: LiteLLMClientConfig = createLiteLLMClientConfig({
    ...settings,
    model: runtime.modelRef,
    liteLLMBaseUrl: runtime.baseUrl,
    apiKey: runtime.apiKey,
  });

  return {
    ...litellmConfig,
    modelRef: runtime.modelRef,
    protocol,
  };
}

/**
 * Create a request body using the agent runtime's model ref.
 *
 * This layer applies model-capability-aware parameter adaptation before
 * delegating to litellm. This is the key integration point that makes
 * different LLMs perform better by tuning temperature, tool_choice,
 * parallel_tool_calls, and max_tokens per model family.
 */
export function createGatewayRequestBody(
  messages: LiteLLMMessage[],
  settings: AppSettings,
  runtime: ResolvedAgentRuntime | null,
  options?: {
    stream?: boolean;
    temperature?: number;
    tools?: LiteLLMToolDefinition[];
    toolChoice?: "auto" | "none" | { type: "function"; function: { name: string } };
  },
): Record<string, unknown> {
  const effectiveSettings: AppSettings = runtime
    ? { ...settings, model: runtime.modelRef, liteLLMBaseUrl: runtime.baseUrl, apiKey: runtime.apiKey }
    : settings;

  const protocol = (runtime?.vendorProtocol || "openai-chat-completions") as VendorProtocol;
  const modelRef = runtime?.modelRef || settings.model;
  const hasTools = (options?.tools?.length ?? 0) > 0;

  // Apply model-capability-aware parameter adaptation
  const adapted = adaptRequestParams(modelRef, protocol, hasTools, options?.temperature);

  const adaptedOptions = {
    ...options,
    temperature: options?.temperature ?? adapted.temperature,
    toolChoice: options?.toolChoice ?? adapted.toolChoice,
  };

  const body = createLiteLLMRequestBody(messages, effectiveSettings, adaptedOptions);

  // Inject parallel_tool_calls if the model supports it (OpenAI-specific)
  if (adapted.parallelToolCalls !== undefined && hasTools && protocol === "openai-chat-completions") {
    body.parallel_tool_calls = adapted.parallelToolCalls;
  }

  // Inject max_tokens if the model has a recommended limit and it's not already set
  if (adapted.maxTokens && !body.max_tokens) {
    body.max_tokens = adapted.maxTokens;
  }

  return body;
}

/**
 * Get model capabilities for the current runtime configuration.
 * Useful for the orchestrator to make decisions about prompt assembly,
 * context budget, and tool selection.
 */
export function getGatewayModelCapabilities(
  runtime: ResolvedAgentRuntime | null,
  settings: AppSettings,
): ModelCapabilities {
  const modelRef = runtime?.modelRef || settings.model;
  const protocol = (runtime?.vendorProtocol || "openai-chat-completions") as VendorProtocol;
  return getModelCapabilities(modelRef, protocol);
}
