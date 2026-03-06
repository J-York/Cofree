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
 * This is a thin pass-through to litellm but lets the orchestrator
 * stay unaware of protocol details.
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

  return createLiteLLMRequestBody(messages, effectiveSettings, options);
}
