/**
 * Test script to verify Anthropic Prompt Caching implementation
 * Run with: npx tsx test-cache-implementation.ts
 */

import { createLiteLLMRequestBody, type LiteLLMMessage } from "./src/lib/litellm";
import { DEFAULT_SETTINGS, type AppSettings } from "./src/lib/settingsStore";

// Create test settings for Anthropic protocol
const anthropicSettings: AppSettings = {
  ...DEFAULT_SETTINGS,
  activeVendorId: "anthropic",
  activeModelId: "claude-model",
  activeManagedModelId: "claude-model",
  vendors: [
    {
      id: "anthropic",
      name: "Anthropic",
      protocol: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ],
  managedModels: [
    {
      id: "claude-model",
      vendorId: "anthropic",
      name: "claude-3-5-sonnet-20241022",
      source: "manual",
      supportsThinking: false,
      thinkingLevel: "medium",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ],
  apiKey: "test-key",
};

// Create a long system message (>1024 chars) to trigger caching
const longSystemPrompt = "System: " + "A".repeat(1200);

const testMessages: LiteLLMMessage[] = [
  { role: "system", content: longSystemPrompt },
  { role: "user", content: "Hello, how are you?" },
];

console.log("Testing Anthropic Prompt Caching Implementation\n");
console.log("=" .repeat(60));

const requestBody = createLiteLLMRequestBody(testMessages, anthropicSettings);

console.log("\n1. Request Body Structure:");
console.log("   - Model:", requestBody.model);
console.log("   - Has system field:", "system" in requestBody);
console.log("   - System type:", typeof requestBody.system);

if (Array.isArray(requestBody.system)) {
  console.log("   ✓ System prompt is array (cache-enabled format)");
  const systemBlock = requestBody.system[0] as any;
  console.log("   - System block type:", systemBlock.type);
  console.log("   - Has cache_control:", "cache_control" in systemBlock);
  if ("cache_control" in systemBlock) {
    console.log("   ✓ cache_control present:", JSON.stringify(systemBlock.cache_control));
  }
} else {
  console.log("   ✗ System prompt is string (cache not enabled)");
}

console.log("\n2. Message Count:", Array.isArray(requestBody.messages) ? requestBody.messages.length : 0);

console.log("\n3. Full Request Body:");
console.log(JSON.stringify(requestBody, null, 2));

console.log("\n" + "=".repeat(60));

// Test with short system prompt (should NOT enable caching)
const shortTestMessages: LiteLLMMessage[] = [
  { role: "system", content: "Short prompt" },
  { role: "user", content: "Hello" },
];

const shortRequestBody = createLiteLLMRequestBody(shortTestMessages, anthropicSettings);

console.log("\n4. Short System Prompt Test:");
console.log("   - System type:", typeof shortRequestBody.system);
if (typeof shortRequestBody.system === "string") {
  console.log("   ✓ System prompt is string (cache not enabled for short content)");
} else {
  console.log("   ✗ System prompt is array (unexpected for short content)");
}

console.log("\n✓ Cache implementation test complete!");
