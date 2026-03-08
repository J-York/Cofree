import { describe, expect, it } from "vitest";
import type { ChatAgentDefinition } from "../../../agents/types";
import type { AppSettings } from "../../../lib/settingsStore";
import { DEFAULT_SETTINGS } from "../../../lib/settingsStore";
import { buildExecutionSettings } from "./execution";

const BASE_AGENT: ChatAgentDefinition = {
    id: "agent-default",
    name: "Default Agent",
    description: "",
    systemPromptTemplate: "",
    toolPolicy: {},
    allowedSubAgents: [],
    builtin: true,
};
function createSettings(): AppSettings {
    return {
        ...DEFAULT_SETTINGS,
        apiKey: "",
        activeVendorId: "vendor-claude",
        activeModelId: "model-claude",
        vendors: [
            {
                ...DEFAULT_SETTINGS.vendors[0],
                id: "vendor-claude",
                name: "Claude Vendor",
                protocol: "anthropic-messages",
            },
            {
                ...DEFAULT_SETTINGS.vendors[0],
                id: "vendor-modelscope",
                name: "ModelScope Vendor",
                protocol: "openai-chat-completions",
            },
        ],
        managedModels: [
            {
                ...DEFAULT_SETTINGS.managedModels[0],
                id: "model-claude",
                vendorId: "vendor-claude",
                name: "claude-sonnet-4-5",
            },
            {
                ...DEFAULT_SETTINGS.managedModels[0],
                id: "model-modelscope",
                vendorId: "vendor-modelscope",
                name: "qwen-max",
            },
        ],
    };
}

describe("chat execution managed model selection guards", () => {
    it("fails closed when a persisted conversation binding is mismatched", async () => {
        const settings = createSettings();
        const conversation = {
            id: "conv-1",
            title: "Conversation",
            createdAt: "2026-03-07T00:00:00.000Z",
            updatedAt: "2026-03-07T00:00:00.000Z",
            messages: [],
            lastTokenCount: null,
            agentBinding: {
                agentId: BASE_AGENT.id,
                vendorId: "vendor-modelscope",
                modelId: "model-claude",
                bindingSource: "default" as const,
                agentNameSnapshot: BASE_AGENT.name,
                boundAt: "2026-03-07T00:00:00.000Z",
            },
        };

        await expect(buildExecutionSettings(settings, BASE_AGENT, conversation)).rejects.toThrow(
            "Model selection is invalid. Please reselect a configured vendor/model.",
        );
    });
    it("keeps the selected vendor/model when the active selection is valid", async () => {
        const settings = createSettings();

        const result = await buildExecutionSettings(settings, BASE_AGENT, null);

        expect(result.selection).toEqual({
            vendorId: "vendor-claude",
            modelId: "model-claude",
        });
        expect(result.snapshots).toEqual({
            vendorName: "Claude Vendor",
            modelName: "claude-sonnet-4-5",
        });
        expect(result.settings.activeVendorId).toBe("vendor-claude");
        expect(result.settings.activeModelId).toBe("model-claude");
        expect(result.settings.model).toBe("claude-sonnet-4-5");
        expect(result.settings.provider).toBe("Claude Vendor");
    });
});
