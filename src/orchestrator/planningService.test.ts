import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
    invoke: vi.fn(),
}));

vi.mock("../lib/tauriBridge", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../lib/tauriBridge")>();
    return {
        ...actual,
        awaitShellCommand: vi.fn(),
        awaitShellCommandWithDeadline: vi.fn(),
        checkShellJob: vi.fn(),
    };
});

vi.mock("../lib/cofreerc", () => ({
    loadCofreeRc: vi.fn(async () => ({})),
    buildCofreeRcPromptFragment: vi.fn(() => ""),
    resolveMatchingContextRules: vi.fn(() => []),
}));

vi.mock("./readOnlyWorkspaceService", () => ({
    summarizeWorkspaceFiles: vi.fn(async () => "workspace summary"),
}));

vi.mock("./repoMapService", () => ({
    generateRepoMap: vi.fn(async () => ""),
}));

vi.mock("../agents/resolveAgentRuntime", () => ({
    resolveAgentRuntime: vi.fn(() => ({
        agentId: "agent-default",
        enabledTools: ["propose_shell"],
        toolPermissions: {
            list_files: "auto",
            read_file: "auto",
            grep: "auto",
            glob: "auto",
            git_status: "auto",
            git_diff: "auto",
            propose_file_edit: "ask",
            propose_apply_patch: "ask",
            propose_shell: "ask",
            diagnostics: "auto",
            fetch: "ask",
        },
        allowedSubAgents: [],
    })),
}));

vi.mock("../agents/promptAssembly", () => ({
    assembleSystemPrompt: vi.fn(() => "system prompt"),
    assembleRuntimeContext: vi.fn(() => "runtime context"),
    classifyTaskType: vi.fn(() => "mixed"),
}));

vi.mock("../agents/toolPolicy", () => ({
    selectAgentTools: vi.fn((runtime: any, allToolDefs: any[]) => ({
        visibleToolDefs: allToolDefs.filter((tool: any) =>
            runtime.enabledTools.includes(tool.function.name),
        ),
        autoTools: [],
        askTools: [],
        allowedSubAgentRoles: runtime.allowedSubAgents,
    })),
}));

vi.mock("../lib/piAiBridge", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../lib/piAiBridge")>();
    return {
        ...actual,
        gatewayComplete: vi.fn(),
        gatewayStream: vi.fn(),
        gatewaySummarize: vi.fn(),
        isHighRiskToolCallingModelCombo: vi.fn(() => true),
    };
});

import { invoke } from "@tauri-apps/api/core";
import { awaitShellCommandWithDeadline } from "../lib/tauriBridge";
import { addWorkspaceApprovalRule } from "../lib/approvalRuleStore";
import {
    gatewayComplete,
    gatewayStream,
    type LiteLLMMessage,
} from "../lib/piAiBridge";
import { resolveAgentRuntime } from "../agents/resolveAgentRuntime";
import { assembleRuntimeContext, classifyTaskType } from "../agents/promptAssembly";
import { DEFAULT_SETTINGS, type AppSettings } from "../lib/settingsStore";
import { createFileContextAttachment } from "../lib/contextAttachments";
import { loadCofreeRc, resolveMatchingContextRules } from "../lib/cofreerc";
import { generateRepoMap } from "./repoMapService";
import {
    executeSubAgentTask,
    planningServiceTestUtils,
    runPlanningSession,
    type ToolExecutionTrace,
} from "./planningService";
import type { WorkingMemorySnapshot } from "./workingMemory";
import { clearOldToolUses, compressMessagesToFitBudget } from "./contextBudget";

function createSettings(): AppSettings {
  return {
        ...DEFAULT_SETTINGS,
        apiKey: "",
        allowCloudModels: true,
        workspacePath: "d:/Code/cofree",
        provider: "Test Vendor",
        model: "test-model",
  };
}

class MemoryStorage implements Storage {
  private data = new Map<string, string>();

  get length(): number {
    return this.data.size;
  }

  clear(): void {
    this.data.clear();
  }

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.data.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

describe("planningService approval-flow repair", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(gatewayStream).mockImplementation(
            async (messages: any, settings: any, runtime: any, options: any, onChunk?: (content: string) => void) => {
                const response = await vi.mocked(gatewayComplete)(
                    messages,
                    settings,
                    runtime,
                    options,
                );
                if (response?.body) {
                    try {
                        const payload = JSON.parse(response.body) as {
                            choices?: Array<{
                                message?: {
                                    content?: string | Array<{ type?: string; text?: string }>;
                                    reasoning_content?: string | Array<{ type?: string; text?: string }>;
                                };
                            }>;
                        };
                        const reasoning = payload.choices?.[0]?.message?.reasoning_content;
                        const content = payload.choices?.[0]?.message?.content;
                        const reasoningText = typeof reasoning === "string"
                            ? reasoning
                            : Array.isArray(reasoning)
                                ? reasoning
                                    .map((item) =>
                                        item && item.type === "text" && typeof item.text === "string"
                                            ? item.text
                                            : "",
                                    )
                                    .join("")
                                : "";
                        if (reasoningText) {
                            onChunk?.(`<think>${reasoningText}</think>`);
                        }
                        if (typeof content === "string" && content) {
                            onChunk?.(content);
                        } else if (Array.isArray(content)) {
                            const text = content
                                .map((item) =>
                                    item && item.type === "text" && typeof item.text === "string"
                                        ? item.text
                                        : "",
                                )
                                .join("");
                            if (text) {
                                onChunk?.(text);
                            }
                        }
                    } catch {
                        // Ignore mock payload parsing in tests that only care about the final response.
                    }
                }
                return response as any;
            },
        );
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("includes PowerShell-specific guidance in the assembled system prompt", async () => {
        const actual = await vi.importActual<typeof import("../agents/promptAssembly")>(
            "../agents/promptAssembly",
        );

        const prompt = actual.assembleSystemPrompt({
            agentId: "agent-default",
            systemPrompt: "system prompt",
            enabledTools: ["propose_shell"],
            modelRef: "gpt-5.4",
            toolPermissions: {
                ...DEFAULT_SETTINGS.toolPermissions,
                propose_shell: "auto",
            },
            allowedSubAgents: [],
        } as any);

        expect(prompt).toContain("宿主系统的 Shell 环境约束（Windows=PowerShell，Unix=sh）");
        expect(prompt).toContain("Windows/PowerShell 下优先用 'Remove-Item -Recurse -Force <路径>'");
        expect(prompt).toContain("Remove-Item -Recurse -Force");
        expect(prompt).toContain("必须先获得精确上下文，通常通过 read_file/grep 完成");
        expect(prompt).toContain("通过 read_file、grep 结果或已有会话上下文获得精确上下文");
    });

    it("uses conditional completion-summary wording for review tasks", async () => {
        const actual = await vi.importActual<typeof import("../agents/promptAssembly")>(
            "../agents/promptAssembly",
        );

        const prompt = actual.assembleSystemPrompt({
            agentId: "agent-default",
            systemPrompt: "system prompt",
            enabledTools: ["read_file", "grep"],
            modelRef: "gpt-4o-mini",
            toolPermissions: {
                ...DEFAULT_SETTINGS.toolPermissions,
                read_file: "auto",
                grep: "auto",
            },
            allowedSubAgents: [],
        } as any, "review");

        expect(prompt).toContain("若本轮包含代码或文件修改");
        expect(prompt).toContain("若本轮是审查/信息类任务且没有文件变更");
        expect(prompt).not.toContain("明确告诉用户：你修改了哪些文件");
    });

    it("keeps brevity completion hints truthful for no-edit tasks", async () => {
        const actual = await vi.importActual<typeof import("../agents/promptAssembly")>(
            "../agents/promptAssembly",
        );

        const prompt = actual.assembleSystemPrompt({
            agentId: "agent-default",
            systemPrompt: "system prompt",
            enabledTools: ["read_file", "grep"],
            modelRef: "gpt-3.5-turbo",
            toolPermissions: {
                ...DEFAULT_SETTINGS.toolPermissions,
                read_file: "auto",
                grep: "auto",
            },
            allowedSubAgents: [],
        } as any, "review");

        expect(prompt).toContain("有修改则列出修改项与验证方式；无修改则列出结论、依据和建议的后续验证方式");
    });

    it("passes update_plan as an internal tool to assembleRuntimeContext so it appears in 本轮可用工具", async () => {
        vi.mocked(gatewayComplete).mockResolvedValue({
            status: 200,
            endpoint: "http://localhost:4000/chat/completions",
            body: JSON.stringify({
                id: "chatcmpl-ctx",
                choices: [{ message: { role: "assistant", content: "done" } }],
                usage: { prompt_tokens: 4, completion_tokens: 2 },
            }),
        });

        await runPlanningSession({
            prompt: "请帮我做一个MVP",
            settings: createSettings(),
            conversationHistory: [],
        });

        const calls = vi.mocked(assembleRuntimeContext).mock.calls;
        expect(calls.length).toBeGreaterThan(0);
        // The third argument must be an array that contains "update_plan"
        const internalTools = calls[0]?.[2] as string[] | undefined;
        expect(Array.isArray(internalTools)).toBe(true);
        expect(internalTools).toContain("update_plan");
    });

    it("builds tool-loop request bodies through modelGateway", async () => {
        vi.mocked(gatewayComplete).mockResolvedValue({
            status: 200,
            endpoint: "http://localhost:4000/chat/completions",
            body: JSON.stringify({
                id: "chatcmpl-model-gateway",
                choices: [{ message: { role: "assistant", content: "done" } }],
                usage: { prompt_tokens: 4, completion_tokens: 2 },
            }),
        });

        await runPlanningSession({
            prompt: "Describe the shell tool contract",
            settings: createSettings(),
            conversationHistory: [],
        });

        expect(vi.mocked(gatewayStream)).toHaveBeenCalled();
        const firstCall = vi.mocked(gatewayStream).mock.calls[0];
        expect(firstCall?.[2]).toMatchObject({ agentId: "agent-default" });
        expect(firstCall?.[3]).toMatchObject({ temperature: 0.1 });
    });

    it("retries once when the model narrates a tool call in plain text without native tool_calls", async () => {
        vi.mocked(gatewayComplete).mockResolvedValueOnce({
            status: 200,
            endpoint: "http://localhost:4000/chat/completions",
            body: JSON.stringify({
                id: "chatcmpl-pseudo-tool-1",
                choices: [{
                    message: {
                        role: "assistant",
                        content: "I will call propose_shell now to inspect the workspace.",
                    },
                }],
                usage: { prompt_tokens: 4, completion_tokens: 2 },
            }),
        }).mockResolvedValueOnce({
            status: 200,
            endpoint: "http://localhost:4000/chat/completions",
            body: JSON.stringify({
                id: "chatcmpl-pseudo-tool-2",
                choices: [{ message: { role: "assistant", content: "done" } }],
                usage: { prompt_tokens: 5, completion_tokens: 2 },
            }),
        });
        vi.mocked(invoke).mockImplementation(async (command: string) => {
            if (command === "list_workspace_files") {
                return [];
            }
            throw new Error(`Unexpected invoke: ${command}`);
        });

        const result = await runPlanningSession({
            prompt: "Describe the shell tool contract",
            settings: createSettings(),
            conversationHistory: [],
        });

        expect(result.assistantReply).toBe("done");
        expect(vi.mocked(gatewayStream).mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it("retries once when the model dumps tool JSON transcripts in plain text without native tool_calls", async () => {
        vi.mocked(gatewayComplete).mockResolvedValueOnce({
            status: 200,
            endpoint: "http://localhost:4000/chat/completions",
            body: JSON.stringify({
                id: "chatcmpl-pseudo-json-1",
                choices: [{
                    message: {
                        role: "assistant",
                        content: "{\"relative_path\":\"apps/api/src/index.ts\",\"start_line\":1,\"end_line\":200}{\"ok\":false,\"error\":\"read_file failed: no such file or directory\"}",
                    },
                }],
                usage: { prompt_tokens: 4, completion_tokens: 2 },
            }),
        }).mockResolvedValueOnce({
            status: 200,
            endpoint: "http://localhost:4000/chat/completions",
            body: JSON.stringify({
                id: "chatcmpl-pseudo-json-2",
                choices: [{ message: { role: "assistant", content: "done" } }],
                usage: { prompt_tokens: 5, completion_tokens: 2 },
            }),
        });
        vi.mocked(invoke).mockImplementation(async (command: string) => {
            if (command === "list_workspace_files") {
                return [];
            }
            throw new Error(`Unexpected invoke: ${command}`);
        });

        const result = await runPlanningSession({
            prompt: "帮我实现一个全栈音乐分享项目",
            settings: createSettings(),
            conversationHistory: [],
        });

        expect(result.assistantReply).toBe("done");
        expect(vi.mocked(gatewayStream)).toHaveBeenCalledTimes(2);
    });

    it("removes pseudo tool JSON transcripts from retry history", async () => {
        const pseudoTranscript =
            "{\"relative_path\":\"apps/api/src/index.ts\",\"start_line\":1,\"end_line\":200}" +
            "{\"ok\":false,\"error\":\"read_file failed: no such file or directory\"}";

        vi.mocked(gatewayComplete).mockResolvedValueOnce({
            status: 200,
            endpoint: "http://localhost:4000/chat/completions",
            body: JSON.stringify({
                id: "chatcmpl-pseudo-history-1",
                choices: [{
                    message: {
                        role: "assistant",
                        content: pseudoTranscript,
                    },
                }],
                usage: { prompt_tokens: 4, completion_tokens: 2 },
            }),
        }).mockResolvedValueOnce({
            status: 200,
            endpoint: "http://localhost:4000/chat/completions",
            body: JSON.stringify({
                id: "chatcmpl-pseudo-history-2",
                choices: [{ message: { role: "assistant", content: "done" } }],
                usage: { prompt_tokens: 5, completion_tokens: 2 },
            }),
        });
        vi.mocked(invoke).mockImplementation(async (command: string) => {
            if (command === "list_workspace_files") {
                return [];
            }
            throw new Error(`Unexpected invoke: ${command}`);
        });

        const result = await runPlanningSession({
            prompt: "帮我实现一个全栈音乐分享项目",
            settings: createSettings(),
            conversationHistory: [],
        });

        expect(result.assistantReply).toBe("done");
        const secondCall = vi.mocked(gatewayStream).mock.calls[1];
        const secondMessages = (secondCall?.[0] ?? []) as Array<{ content?: string }>;
        expect(secondMessages.some((message) => message.content?.includes(pseudoTranscript))).toBe(false);
    });

    it("retries once when the model dumps tool JSON in plain text without native tool_calls", async () => {
        vi.mocked(resolveAgentRuntime).mockImplementationOnce(() => ({
            agentId: "agent-default",
            enabledTools: ["propose_shell"],
            toolPermissions: {
                list_files: "auto",
                read_file: "auto",
                grep: "auto",
                glob: "auto",
                git_status: "auto",
                git_diff: "auto",
                propose_file_edit: "ask",
                propose_apply_patch: "ask",
                propose_shell: "ask",
                diagnostics: "auto",
                fetch: "ask",
            },
            allowedSubAgents: [],
            vendorProtocol: "openai-responses",
            modelRef: "test-model",
        }) as any);
        vi.mocked(gatewayComplete).mockResolvedValueOnce({
            status: 200,
            endpoint: "http://localhost:4000/responses",
            body: JSON.stringify({
                id: "resp-pseudo-json-1",
                choices: [{
                    message: {
                        role: "assistant",
                        content:
                            "{\"shell\":\"pnpm test\",\"timeout_ms\":120000}{\"ok\":false,\"error\":\"propose_shell failed: command not found\"}",
                    },
                }],
                usage: { prompt_tokens: 4, completion_tokens: 2 },
            }),
        }).mockResolvedValueOnce({
            status: 200,
            endpoint: "http://localhost:4000/responses",
            body: JSON.stringify({
                id: "resp-pseudo-json-2",
                choices: [{ message: { role: "assistant", content: "done" } }],
                usage: { prompt_tokens: 5, completion_tokens: 2 },
            }),
        });

        const result = await runPlanningSession({
            prompt: "Describe the shell tool contract",
            settings: createSettings(),
            conversationHistory: [],
        });

        expect(result.assistantReply).toBe("done");
        expect(vi.mocked(gatewayStream)).toHaveBeenCalledTimes(2);
    });

    it("returns a compatibility diagnostic when pseudo tool JSON persists after repair", async () => {
        vi.mocked(resolveAgentRuntime).mockImplementationOnce(() => ({
            agentId: "agent-default",
            enabledTools: ["propose_shell"],
            toolPermissions: {
                list_files: "auto",
                read_file: "auto",
                grep: "auto",
                glob: "auto",
                git_status: "auto",
                git_diff: "auto",
                propose_file_edit: "ask",
                propose_apply_patch: "ask",
                propose_shell: "ask",
                diagnostics: "auto",
                fetch: "ask",
            },
            allowedSubAgents: [],
            vendorProtocol: "openai-responses",
            modelRef: "test-model",
        }) as any);
        vi.mocked(gatewayComplete).mockResolvedValue({
            status: 200,
            endpoint: "http://localhost:4000/responses",
            body: JSON.stringify({
                id: "resp-pseudo-json-repeat",
                choices: [{
                    message: {
                        role: "assistant",
                        content:
                            "{\"shell\":\"pnpm test\",\"timeout_ms\":120000}{\"ok\":false,\"error\":\"propose_shell failed: command not found\"}",
                    },
                }],
                usage: { prompt_tokens: 4, completion_tokens: 2 },
            }),
        });

        const result = await runPlanningSession({
            prompt: "Describe the shell tool contract",
            settings: createSettings(),
            conversationHistory: [],
        });

        expect(result.assistantReply).toContain("OpenAI Responses");
        expect(result.assistantReply).toContain("OpenAI Chat Completions");
        expect(result.assistantReply).not.toContain("{\"shell\"");
        expect(vi.mocked(gatewayStream).mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it("falls back to non-streaming when the streamed response assembles to empty text without tool calls", async () => {
        vi.mocked(gatewayStream).mockResolvedValueOnce({
            status: 200,
            endpoint: "http://localhost:4000/chat/completions",
            body: JSON.stringify({
                id: "chatcmpl-empty-stream",
                choices: [
                    {
                        message: {
                            role: "assistant",
                            content: "",
                        },
                        finish_reason: "stop",
                    },
                ],
                usage: {
                    prompt_tokens: 7,
                    completion_tokens: 0,
                    total_tokens: 7,
                },
            }),
        } as any);
        vi.mocked(gatewayComplete).mockResolvedValueOnce({
            status: 200,
            endpoint: "http://localhost:4000/chat/completions",
            body: JSON.stringify({
                id: "chatcmpl-nonstream-retry",
                choices: [
                    {
                        message: {
                            role: "assistant",
                            content: "来自非流式回退的正常回复",
                        },
                    },
                ],
                usage: {
                    prompt_tokens: 7,
                    completion_tokens: 12,
                    total_tokens: 19,
                },
            }),
        });

        const result = await runPlanningSession({
            prompt: "帮我检查一下当前问题",
            settings: createSettings(),
            conversationHistory: [],
        });

        expect(result.assistantReply).toBe("来自非流式回退的正常回复");
        expect(vi.mocked(gatewayStream)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(gatewayComplete)).toHaveBeenCalledTimes(1);
    });

    it("falls back to non-streaming when streaming fails with a connection error", async () => {
        vi.mocked(gatewayStream).mockResolvedValueOnce({
            status: 500,
            endpoint: "http://localhost:4000/responses",
            body: JSON.stringify({
                error: {
                    message: "Connection error.",
                },
            }),
        } as any);
        vi.mocked(gatewayComplete).mockResolvedValueOnce({
            status: 200,
            endpoint: "http://localhost:4000/responses",
            body: JSON.stringify({
                id: "resp-nonstream-after-connection-error",
                choices: [
                    {
                        message: {
                            role: "assistant",
                            content: "来自非流式回退的连接恢复回复",
                        },
                    },
                ],
                usage: {
                    prompt_tokens: 7,
                    completion_tokens: 12,
                    total_tokens: 19,
                },
            }),
        });

        const result = await runPlanningSession({
            prompt: "帮我检查一下当前问题",
            settings: createSettings(),
            conversationHistory: [],
        });

        expect(result.assistantReply).toBe("来自非流式回退的连接恢复回复");
        expect(vi.mocked(gatewayStream)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(gatewayComplete)).toHaveBeenCalledTimes(1);
    });

    it("preserves reasoning_content as a think block in the final assistant reply", async () => {
        vi.mocked(gatewayComplete).mockResolvedValue({
            status: 200,
            endpoint: "http://localhost:4000/chat/completions",
            body: JSON.stringify({
                id: "chatcmpl-reasoning-content",
                choices: [{
                    message: {
                        role: "assistant",
                        reasoning_content: "先分析项目结构，再决定下一步。",
                        content: "已生成执行计划。",
                    },
                }],
                usage: { prompt_tokens: 8, completion_tokens: 4 },
            }),
        });

        const chunks: string[] = [];
        const result = await runPlanningSession({
            prompt: "帮我看一下当前目录该怎么开始",
            settings: createSettings(),
            conversationHistory: [],
            onAssistantChunk: (chunk) => {
                chunks.push(chunk);
            },
        });

        expect(chunks.join("")).toBe("<think>先分析项目结构，再决定下一步。</think>已生成执行计划。");
        expect(result.assistantReply).toBe("<think>先分析项目结构，再决定下一步。</think>已生成执行计划。");
    });

    it("extracts file targets from partial streamed tool-call JSON", () => {
        expect(
            planningServiceTestUtils.summarizeToolArgs(
                "read_file",
                "{\"relative_path\":\"src/ui/pages/ChatPage.tsx\"",
            ),
        ).toBe("src/ui/pages/ChatPage.tsx");

        expect(
            planningServiceTestUtils.summarizeToolArgs(
                "propose_file_edit",
                "{\"relative_path\":\"src/orchestrator/planningService.ts\",\"operation\":\"replace\"",
            ),
        ).toBe("src/orchestrator/planningService.ts");
    });

    it("exposes PowerShell-aware propose_shell tool definitions in planning requests", async () => {
        vi.mocked(gatewayComplete).mockResolvedValue({
            status: 200,
            endpoint: "http://localhost:4000/chat/completions",
            body: JSON.stringify({
                id: "chatcmpl-tools",
                choices: [
                    {
                        message: {
                            role: "assistant",
                            content: "done",
                        },
                    },
                ],
                usage: {
                    prompt_tokens: 4,
                    completion_tokens: 2,
                },
            }),
        });
        vi.mocked(invoke).mockImplementation(async (command: string) => {
            if (command === "list_workspace_files") {
                return [];
            }
            throw new Error(`Unexpected invoke: ${command}`);
        });

        await runPlanningSession({
            prompt: "Describe the shell tool contract",
            settings: createSettings(),
            conversationHistory: [],
        });

        const firstRequestOptions = vi.mocked(gatewayComplete).mock.calls[0]?.[3] as {
            tools?: Array<{
                function: {
                    name: string;
                    description: string;
                    parameters: {
                        properties: {
                            shell: {
                                description: string;
                            };
                        };
                    };
                };
            }>;
        } | undefined;
        const shellTool = firstRequestOptions?.tools?.find(
            (tool) => tool.function.name === "propose_shell",
        );
        const planTool = firstRequestOptions?.tools?.find(
            (tool: any) => tool.function.name === "update_plan",
        );

        expect(shellTool?.function.description).toContain("PowerShell");
        expect(shellTool?.function.description).toContain("New-Item -ItemType Directory -Force");
        expect(shellTool?.function.description).toContain("Read stderr carefully and retry with corrected syntax");
        expect(shellTool?.function.parameters.properties.shell.description).toContain(
            "On Windows prefer PowerShell syntax",
        );
        expect(planTool?.function.description).toContain("internal todo plan");
    });

    it("passes task description and focused paths into repo-map generation on first turn", async () => {
        vi.mocked(gatewayComplete).mockResolvedValue({
            status: 200,
            endpoint: "http://localhost:4000/chat/completions",
            body: JSON.stringify({
                id: "chatcmpl-repomap",
                choices: [
                    {
                        message: {
                            role: "assistant",
                            content: "done",
                        },
                    },
                ],
                usage: {
                    prompt_tokens: 4,
                    completion_tokens: 2,
                },
            }),
        });
        vi.mocked(invoke).mockImplementation(async (command: string) => {
            if (command === "list_files") {
                return [];
            }
            throw new Error(`Unexpected invoke: ${command}`);
        });

        await runPlanningSession({
            prompt: "Improve repo map injection in planning service",
            settings: createSettings(),
            conversationHistory: [],
            contextAttachments: [createFileContextAttachment("src/orchestrator/repoMapService.ts")],
        });

        expect(vi.mocked(generateRepoMap)).toHaveBeenCalledWith(
            "d:/Code/cofree",
            null,
            expect.any(Number),
            {
                taskDescription: "Improve repo map injection in planning service",
                prioritizedPaths: ["src/orchestrator/repoMapService.ts"],
                maxFiles: undefined,
            },
        );
    });

    it("injects matching path-scoped rules into sub-agent prompts", async () => {
        vi.mocked(loadCofreeRc).mockResolvedValue({
            contextRules: [
                {
                    id: "auth-ui",
                    paths: ["src/auth/**/*"],
                    instructions: "Preserve auth validation flow.",
                    contextFiles: ["docs/ARCHITECTURE.md"],
                },
            ],
        });
        vi.mocked(resolveMatchingContextRules).mockReturnValue([
            {
                id: "auth-ui",
                paths: ["src/auth/**/*"],
                instructions: "Preserve auth validation flow.",
                contextFiles: ["docs/ARCHITECTURE.md"],
            },
        ]);
        vi.mocked(gatewayComplete).mockResolvedValue({
            status: 200,
            endpoint: "http://localhost:4000/chat/completions",
            body: JSON.stringify({
                id: "chatcmpl-subagent-rule",
                choices: [
                    {
                        message: {
                            role: "assistant",
                            content: "done",
                        },
                    },
                ],
                usage: {
                    prompt_tokens: 4,
                    completion_tokens: 2,
                },
            }),
        });
        vi.mocked(invoke).mockImplementation(async (command: string, args?: any) => {
            if (command === "read_workspace_file" && args?.relativePath === "docs/ARCHITECTURE.md") {
                return {
                    content: "# Architecture\nAuth UI lives under src/auth.\n",
                    total_lines: 10,
                    start_line: 1,
                    end_line: 10,
                };
            }
            throw new Error(`Unexpected invoke: ${command}`);
        });

        await executeSubAgentTask(
            "coder",
            "Update validation in src/auth/login.ts and keep auth UX unchanged.",
            "d:/Code/cofree",
            createSettings(),
            DEFAULT_SETTINGS.toolPermissions,
            undefined,
            undefined,
            undefined,
        );

        const firstMessages = (vi.mocked(gatewayComplete).mock.calls[0]?.[0] ?? []) as Array<{ role: string; content: string }>;
        const systemPrompt = firstMessages?.[0]?.content ?? "";

        expect(systemPrompt).toContain("[命中的项目规则]");
        expect(systemPrompt).toContain("auth-ui");
        expect(systemPrompt).toContain("Preserve auth validation flow.");
        expect(systemPrompt).toContain("docs/ARCHITECTURE.md");
        expect(systemPrompt).toContain("Auth UI lives under src/auth.");
    });

    it("uses provided focused paths when sub-agent task text does not mention a file", async () => {
        vi.mocked(loadCofreeRc).mockResolvedValue({
            contextRules: [
                {
                    id: "auth-ui",
                    paths: ["src/auth/**/*"],
                    instructions: "Preserve auth validation flow.",
                    contextFiles: ["docs/ARCHITECTURE.md"],
                },
            ],
        });
        vi.mocked(resolveMatchingContextRules).mockReturnValue([
            {
                id: "auth-ui",
                paths: ["src/auth/**/*"],
                instructions: "Preserve auth validation flow.",
                contextFiles: ["docs/ARCHITECTURE.md"],
            },
        ]);
        vi.mocked(gatewayComplete).mockResolvedValue({
            status: 200,
            endpoint: "http://localhost:4000/chat/completions",
            body: JSON.stringify({
                id: "chatcmpl-subagent-focused-paths",
                choices: [
                    {
                        message: {
                            role: "assistant",
                            content: "done",
                        },
                    },
                ],
                usage: {
                    prompt_tokens: 4,
                    completion_tokens: 2,
                },
            }),
        });
        vi.mocked(invoke).mockImplementation(async (command: string, args?: any) => {
            if (command === "read_workspace_file" && args?.relativePath === "docs/ARCHITECTURE.md") {
                return {
                    content: "# Architecture\nAuth UI lives under src/auth.\n",
                    total_lines: 10,
                    start_line: 1,
                    end_line: 10,
                };
            }
            throw new Error(`Unexpected invoke: ${command}`);
        });

        await executeSubAgentTask(
            "coder",
            "Update the validation flow while keeping the current UX unchanged.",
            "d:/Code/cofree",
            createSettings(),
            DEFAULT_SETTINGS.toolPermissions,
            undefined,
            undefined,
            undefined,
            ["src/auth/login.ts"],
        );

        const firstMessages = (vi.mocked(gatewayComplete).mock.calls[0]?.[0] ?? []) as Array<{ role: string; content: string }>;
        const systemPrompt = firstMessages?.[0]?.content ?? "";

        expect(systemPrompt).toContain("[命中的项目规则]");
        expect(systemPrompt).toContain("auth-ui");
        expect(systemPrompt).toContain("docs/ARCHITECTURE.md");
    });

    it("keeps shell proposals pending for sub-agents even when a workspace rule matches", async () => {
        vi.stubGlobal("window", { localStorage: new MemoryStorage() });
        addWorkspaceApprovalRule("d:/Code/cofree", {
            kind: "shell_command_prefix",
            commandTokens: ["npm", "install"],
        });
        vi.mocked(gatewayComplete)
            .mockResolvedValueOnce({
                status: 200,
                endpoint: "http://localhost:4000/chat/completions",
                body: JSON.stringify({
                    id: "chatcmpl-subagent-shell-rule-1",
                    choices: [
                        {
                            message: {
                                role: "assistant",
                                content: "",
                                tool_calls: [
                                    {
                                        id: "subagent-shell-1",
                                        type: "function",
                                        function: {
                                            name: "propose_shell",
                                            arguments: JSON.stringify({
                                                shell: "npm install",
                                                description: "Install dependencies",
                                            }),
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                    usage: { prompt_tokens: 8, completion_tokens: 6 },
                }),
            })
            .mockResolvedValueOnce({
                status: 200,
                endpoint: "http://localhost:4000/chat/completions",
                body: JSON.stringify({
                    id: "chatcmpl-subagent-shell-rule-2",
                    choices: [
                        {
                            message: {
                                role: "assistant",
                                content: "done",
                            },
                        },
                    ],
                    usage: { prompt_tokens: 8, completion_tokens: 2 },
                }),
            });
        vi.mocked(invoke).mockImplementation(async (command: string) => {
            throw new Error(`Unexpected invoke: ${command}`);
        });

        const result = await executeSubAgentTask(
            "coder",
            "Install the missing dependencies.",
            "d:/Code/cofree",
            createSettings(),
            DEFAULT_SETTINGS.toolPermissions,
        );

        expect(result.proposedActions).toHaveLength(1);
        expect(result.proposedActions[0]).toMatchObject({
            type: "shell",
            status: "pending",
            executed: false,
            payload: {
                shell: "npm install",
            },
        });
        expect(result.toolTrace[0]?.status).toBe("pending_approval");
    });

    it("P2-1: keeps sub-agent shell proposals pending when global propose_* permissions are auto", async () => {
        vi.stubGlobal("window", { localStorage: new MemoryStorage() });
        vi.mocked(gatewayComplete)
            .mockResolvedValueOnce({
                status: 200,
                endpoint: "http://localhost:4000/chat/completions",
                body: JSON.stringify({
                    id: "chatcmpl-p2-1-auto-shell",
                    choices: [
                        {
                            message: {
                                role: "assistant",
                                content: "",
                                tool_calls: [
                                    {
                                        id: "p2-1-shell",
                                        type: "function",
                                        function: {
                                            name: "propose_shell",
                                            arguments: JSON.stringify({
                                                shell: "npm install",
                                                description: "Install dependencies",
                                            }),
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                    usage: { prompt_tokens: 8, completion_tokens: 6 },
                }),
            })
            .mockResolvedValueOnce({
                status: 200,
                endpoint: "http://localhost:4000/chat/completions",
                body: JSON.stringify({
                    id: "chatcmpl-p2-1-auto-done",
                    choices: [
                        {
                            message: {
                                role: "assistant",
                                content: "done",
                            },
                        },
                    ],
                    usage: { prompt_tokens: 8, completion_tokens: 2 },
                }),
            });
        vi.mocked(invoke).mockImplementation(async (command: string) => {
            throw new Error(`Unexpected invoke: ${command}`);
        });

        const autoPerms = {
            ...DEFAULT_SETTINGS.toolPermissions,
            propose_shell: "auto" as const,
            propose_file_edit: "auto" as const,
            propose_apply_patch: "auto" as const,
        };

        const result = await executeSubAgentTask(
            "tester",
            "Install the missing dependencies.",
            "d:/Code/cofree",
            createSettings(),
            autoPerms,
        );

        expect(result.proposedActions).toHaveLength(1);
        expect(result.proposedActions[0]).toMatchObject({
            type: "shell",
            status: "pending",
            executed: false,
            payload: {
                shell: "npm install",
            },
        });
        expect(result.toolTrace[0]?.status).toBe("pending_approval");
    });

    it("propagates session focused paths into task-tool sub-agents", async () => {
        vi.mocked(loadCofreeRc).mockResolvedValue({
            contextRules: [
                {
                    id: "auth-ui",
                    paths: ["src/auth/**/*"],
                    instructions: "Preserve auth validation flow.",
                    contextFiles: ["docs/ARCHITECTURE.md"],
                },
            ],
        });
        vi.mocked(resolveMatchingContextRules).mockReturnValue([
            {
                id: "auth-ui",
                paths: ["src/auth/**/*"],
                instructions: "Preserve auth validation flow.",
                contextFiles: ["docs/ARCHITECTURE.md"],
            },
        ]);
        vi.mocked(gatewayComplete).mockResolvedValue({
            status: 200,
            endpoint: "http://localhost:4000/chat/completions",
            body: JSON.stringify({
                id: "chatcmpl-task-focused-paths",
                choices: [
                    {
                        message: {
                            role: "assistant",
                            content: "done",
                        },
                    },
                ],
                usage: {
                    prompt_tokens: 4,
                    completion_tokens: 2,
                },
            }),
        });
        vi.mocked(invoke).mockImplementation(async (command: string, args?: any) => {
            if (command === "read_workspace_file" && args?.relativePath === "docs/ARCHITECTURE.md") {
                return {
                    content: "# Architecture\nAuth UI lives under src/auth.\n",
                    total_lines: 10,
                    start_line: 1,
                    end_line: 10,
                };
            }
            throw new Error(`Unexpected invoke: ${command}`);
        });

        await planningServiceTestUtils.executeToolCall(
            {
                id: "tool-task-1",
                type: "function",
                function: {
                    name: "task",
                    arguments: JSON.stringify({
                        role: "coder",
                        description: "Refine the validation flow while preserving existing UX.",
                    }),
                },
            },
            "d:/Code/cofree",
            DEFAULT_SETTINGS.toolPermissions,
            createSettings(),
            undefined,
            ["coder" as any],
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            ["src/auth/login.ts"],
        );

        const firstMessages = (vi.mocked(gatewayComplete).mock.calls[0]?.[0] ?? []) as Array<{ role: string; content: string }>;
        const systemPrompt = firstMessages?.[0]?.content ?? "";

        expect(systemPrompt).toContain("[命中的项目规则]");
        expect(systemPrompt).toContain("auth-ui");
        expect(systemPrompt).toContain("docs/ARCHITECTURE.md");
    });

    it("updates todo plan state through the internal update_plan tool", async () => {
        const planState = {
            steps: [
                {
                    id: "step-plan",
                    title: "分析需求",
                    summary: "分析需求并拆解",
                    owner: "planner",
                    status: "in_progress" as const,
                },
                {
                    id: "step-implement",
                    title: "执行实现",
                    summary: "执行代码改动",
                    owner: "coder",
                    status: "pending" as const,
                    dependsOn: ["step-plan"],
                },
            ],
            activeStepId: "step-plan",
        };

        const result = await planningServiceTestUtils.executeToolCall(
            {
                id: "tool-plan-1",
                type: "function",
                function: {
                    name: "update_plan",
                    arguments: JSON.stringify({
                        operation: "complete",
                        step_id: "step-plan",
                        note: "需求已分析完成",
                    }),
                },
            },
            "d:/Code/cofree",
            DEFAULT_SETTINGS.toolPermissions,
            undefined,
            undefined,
            undefined,
            undefined,
            planState as any,
        );

        const payload = JSON.parse(result.content) as Record<string, unknown>;

        expect(result.success).toBe(true);
        expect(planState.steps[0].status).toBe("completed");
        expect((planState.steps[0] as any).note).toContain("需求已分析完成");
        expect(planState.steps[1].status).toBe("in_progress");
        expect(planState.activeStepId).toBe("step-implement");
        expect(payload.active_step_id).toBe("step-implement");
    });

    it("refreshes the todo system prompt after update_plan before the next turn", async () => {
        vi.mocked(gatewayComplete)
            .mockResolvedValueOnce({
                status: 200,
                endpoint: "http://localhost:4000/chat/completions",
                body: JSON.stringify({
                    id: "chatcmpl-plan-refresh-1",
                    choices: [
                        {
                            message: {
                                role: "assistant",
                                content: "",
                                tool_calls: [
                                    {
                                        id: "call-plan-refresh-1",
                                        type: "function",
                                        function: {
                                            name: "update_plan",
                                            arguments: JSON.stringify({
                                                operation: "complete",
                                                step_id: "step-plan",
                                                note: "需求已分析完成",
                                            }),
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                    usage: {
                        prompt_tokens: 16,
                        completion_tokens: 8,
                    },
                }),
            })
            .mockResolvedValueOnce({
                status: 200,
                endpoint: "http://localhost:4000/chat/completions",
                body: JSON.stringify({
                    id: "chatcmpl-plan-refresh-2",
                    choices: [
                        {
                            message: {
                                role: "assistant",
                                content: "done",
                            },
                        },
                    ],
                    usage: {
                        prompt_tokens: 14,
                        completion_tokens: 2,
                    },
                }),
            });

        await runPlanningSession({
            prompt: "完成 todo 列表中的当前工作",
            settings: createSettings(),
            conversationHistory: [],
            existingPlan: {
                state: "planning",
                prompt: "完成 todo 列表中的当前工作",
                steps: [
                    {
                        id: "step-plan",
                        title: "分析需求",
                        summary: "分析需求并拆解",
                        owner: "planner",
                        status: "in_progress",
                    },
                    {
                        id: "step-implement",
                        title: "执行实现",
                        summary: "执行代码改动",
                        owner: "coder",
                        status: "pending",
                        dependsOn: ["step-plan"],
                    },
                ],
                activeStepId: "step-plan",
                proposedActions: [],
                workspacePath: "d:/Code/cofree",
            },
        });

        const secondMessages = (vi.mocked(gatewayComplete).mock.calls[1]?.[0] ?? []) as Array<{ role: string; content: string }>;
        const todoMessages = secondMessages.filter(
            (message) => message.role === "system" && message.content.startsWith("[Todo Plan]"),
        );

        expect(todoMessages).toHaveLength(1);
        expect(todoMessages[0]?.content).toContain("(planner/completed) 分析需求");
        expect(todoMessages[0]?.content).toContain("(coder/in_progress) 执行实现 [当前]");
    });

    it("returns explicit pending-approval semantics for gated shell proposals", async () => {
        const result = await planningServiceTestUtils.executeToolCall(
            {
                id: "tool-1",
                type: "function",
                function: {
                    name: "propose_shell",
                    arguments: JSON.stringify({
                        shell: "git status --porcelain",
                        description: "Inspect working tree",
                    }),
                },
            },
            "d:/Code/cofree",
            {
                ...DEFAULT_SETTINGS.toolPermissions,
                propose_shell: "ask",
            },
        );

        const payload = JSON.parse(result.content) as Record<string, unknown>;

        expect(result.success).toBe(true);
        expect(result.traceStatus).toBe("pending_approval");
        expect(result.proposedAction).toMatchObject({
            type: "shell",
            status: "pending",
            executed: false,
            payload: {
                shell: "git status --porcelain",
                timeoutMs: 120000,
            },
        });
        expect(payload).toMatchObject({
            action_type: "shell",
            shell: "git status --porcelain",
            timeout_ms: 120000,
            approval_required: true,
            proposal_created: true,
            execution_state: "pending_approval",
            command_executed: false,
            action_status: "pending",
        });
        expect(payload).not.toHaveProperty("ok");
        expect(payload).not.toHaveProperty("auto_executed");
        expect(typeof payload.action_id).toBe("string");
    });

    it("auto-executes shell proposals when a workspace approval rule matches", async () => {
        vi.stubGlobal("window", { localStorage: new MemoryStorage() });
        addWorkspaceApprovalRule("d:/Code/cofree", {
            kind: "shell_command_prefix",
            commandTokens: ["git", "add"],
        });
        vi.mocked(awaitShellCommandWithDeadline).mockImplementation(async (params) => {
            expect(params).toMatchObject({
                workspacePath: "d:/Code/cofree",
                shell: "git add src/app.ts",
                timeoutMs: 120000,
            });
            return {
                moved_to_background: false,
                result: {
                    success: true,
                    command: "git add src/app.ts",
                    timed_out: false,
                    status: 0,
                    stdout: "ok",
                    stderr: "",
                },
            };
        });

        const result = await planningServiceTestUtils.executeToolCall(
            {
                id: "tool-auto-rule",
                type: "function",
                function: {
                    name: "propose_shell",
                    arguments: JSON.stringify({
                        shell: "git add src/app.ts",
                    }),
                },
            },
            "d:/Code/cofree",
            {
                ...DEFAULT_SETTINGS.toolPermissions,
                propose_shell: "ask",
            },
        );

        const payload = JSON.parse(result.content) as Record<string, unknown>;

        expect(result.success).toBe(true);
        expect(result.proposedAction).toBeUndefined();
        expect(payload).toMatchObject({
            ok: true,
            action_type: "shell",
            auto_executed: true,
            approval_source: "workspace_rule",
            approval_rule_matched: true,
            approval_rule_kind: "shell_command_prefix",
            approval_rule_label: "git add xxx",
        });
    });

    it("keeps long-running shell proposals pending instead of auto-executing them synchronously", async () => {
        vi.stubGlobal("window", { localStorage: new MemoryStorage() });
        addWorkspaceApprovalRule("d:/Code/cofree", {
            kind: "shell_command_prefix",
            commandTokens: ["python3", "-m", "http.server"],
        });
        vi.mocked(invoke).mockImplementation(async (command: string) => {
            throw new Error(`Unexpected invoke: ${command}`);
        });

        const result = await planningServiceTestUtils.executeToolCall(
            {
                id: "tool-background-shell",
                type: "function",
                function: {
                    name: "propose_shell",
                    arguments: JSON.stringify({
                        shell: "python3 -m http.server 5173",
                    }),
                },
            },
            "d:/Code/cofree",
            {
                ...DEFAULT_SETTINGS.toolPermissions,
                propose_shell: "ask",
            },
        );

        const payload = JSON.parse(result.content) as Record<string, unknown>;

        expect(result.success).toBe(true);
        expect(result.traceStatus).toBe("pending_approval");
        expect(result.proposedAction).toMatchObject({
            type: "shell",
            status: "pending",
            executed: false,
            payload: {
                shell: "python3 -m http.server 5173",
                timeoutMs: 120000,
                executionMode: "background",
                readyUrl: "http://127.0.0.1:5173",
                readyTimeoutMs: 20000,
            },
        });
        expect(payload).toMatchObject({
            action_type: "shell",
            shell: "python3 -m http.server 5173",
            timeout_ms: 120000,
            execution_mode: "background",
            ready_url: "http://127.0.0.1:5173",
            ready_timeout_ms: 20000,
            approval_required: true,
            proposal_created: true,
            action_status: "pending",
        });
        expect(payload).not.toHaveProperty("auto_executed");
    });

    it("drops a pending shell approval when the fingerprint is blocked", () => {
        const actions = planningServiceTestUtils.buildProposedActions(
            [
                {
                    id: "shell-1",
                    type: "shell",
                    description: "Run git status",
                    gateRequired: true,
                    status: "pending",
                    executed: false,
                    toolCallId: "call-1",
                    toolName: "propose_shell",
                    payload: {
                        shell: "git status --porcelain",
                        timeoutMs: 120000,
                    },
                },
            ],
            ["shell:git status --porcelain:120000:foreground::"],
        );

        expect(actions).toHaveLength(0);
    });

    it("buildProposedActions assigns a shared patch group only when targets are disjoint files", () => {
        const patchBase = (path: string, oldLine: string, newLine: string) =>
            [
                `diff --git a/${path} b/${path}`,
                `--- a/${path}`,
                `+++ b/${path}`,
                "@@ -1,1 +1,1 @@",
                `-${oldLine}`,
                `+${newLine}`,
            ].join("\n");

        const patchFooA = patchBase("src/foo.ts", "a", "b");
        const patchFooB = patchBase("src/foo.ts", "b", "c");
        const patchBar = patchBase("src/bar.ts", "x", "y");

        const sameFilePair = planningServiceTestUtils.buildProposedActions([
            {
                id: "p1",
                type: "apply_patch",
                description: "edit foo 1",
                gateRequired: true,
                status: "pending",
                executed: false,
                payload: { patch: patchFooA },
            },
            {
                id: "p2",
                type: "apply_patch",
                description: "edit foo 2",
                gateRequired: true,
                status: "pending",
                executed: false,
                payload: { patch: patchFooB },
            },
        ]);
        expect(sameFilePair).toHaveLength(2);
        expect(sameFilePair[0]?.type === "apply_patch" && !sameFilePair[0].group).toBe(
            true,
        );
        expect(sameFilePair[1]?.type === "apply_patch" && !sameFilePair[1].group).toBe(
            true,
        );

        const disjointPair = planningServiceTestUtils.buildProposedActions([
            {
                id: "p3",
                type: "apply_patch",
                description: "edit foo",
                gateRequired: true,
                status: "pending",
                executed: false,
                payload: { patch: patchFooA },
            },
            {
                id: "p4",
                type: "apply_patch",
                description: "edit bar",
                gateRequired: true,
                status: "pending",
                executed: false,
                payload: { patch: patchBar },
            },
        ]);
        expect(disjointPair).toHaveLength(2);
        const g0 =
            disjointPair[0]?.type === "apply_patch" ? disjointPair[0].group : undefined;
        const g1 =
            disjointPair[1]?.type === "apply_patch" ? disjointPair[1].group : undefined;
        expect(g0?.groupId).toBeTruthy();
        expect(g0?.groupId).toBe(g1?.groupId);
        expect(g0?.atomicIntent).toBe(true);
    });

    it("surfaces a diagnostic reply when a pending approval trace exists without a preserved card", () => {
        const reply = planningServiceTestUtils.reconcileAssistantReply({
            assistantReply: "",
            proposedActions: [],
            assistantToolCalls: [
                {
                    id: "call-1",
                    type: "function",
                    function: {
                        name: "propose_shell",
                        arguments: JSON.stringify({ shell: "git status --porcelain" }),
                    },
                },
            ],
            toolTrace: [
                {
                    callId: "call-1",
                    name: "propose_shell",
                    arguments: JSON.stringify({ shell: "git status --porcelain" }),
                    startedAt: "2026-03-08T00:00:00.000Z",
                    finishedAt: "2026-03-08T00:00:01.000Z",
                    attempts: 1,
                    status: "pending_approval",
                    retried: false,
                    resultPreview: "preview",
                } satisfies ToolExecutionTrace,
            ],
        });

        expect(reply).toContain("待审批动作");
        expect(reply).toContain("审批卡片未能保留");
    });

    it("does not present carried-forward tool calls as a fresh request when the final reply is empty", () => {
        const reply = planningServiceTestUtils.reconcileAssistantReply({
            assistantReply: "",
            proposedActions: [],
            assistantToolCallsFromFinalTurn: false,
            assistantToolCalls: [
                {
                    id: "call-1",
                    type: "function",
                    function: {
                        name: "list_files",
                        arguments: JSON.stringify({ relative_path: "src" }),
                    },
                },
            ],
            toolTrace: [
                {
                    callId: "call-1",
                    name: "list_files",
                    arguments: JSON.stringify({ relative_path: "src" }),
                    startedAt: "2026-03-08T00:00:00.000Z",
                    finishedAt: "2026-03-08T00:00:01.000Z",
                    attempts: 1,
                    status: "success",
                    retried: false,
                    resultPreview: "preview",
                } satisfies ToolExecutionTrace,
            ],
        });

        expect(reply).toBe("已完成工具调用。");
        expect(reply).not.toContain("模型已请求工具调用");
    });

    it("keeps pending shell proposals visible in the full planning pipeline", async () => {
        vi.mocked(gatewayComplete).mockResolvedValue({
            status: 200,
            endpoint: "http://localhost:4000/chat/completions",
            body: JSON.stringify({
                id: "chatcmpl-test",
                choices: [
                    {
                        message: {
                            role: "assistant",
                            content: "",
                            tool_calls: [
                                {
                                    id: "call-shell-1",
                                    type: "function",
                                    function: {
                                        name: "propose_shell",
                                        arguments: JSON.stringify({
                                            shell: "git status --porcelain",
                                            description: "Inspect working tree",
                                        }),
                                    },
                                },
                            ],
                        },
                    },
                ],
                usage: {
                    prompt_tokens: 12,
                    completion_tokens: 8,
                },
            }),
        });
        vi.mocked(invoke).mockImplementation(async (command: string) => {
            if (command === "list_files") {
                return [];
            }
            throw new Error(`Unexpected invoke: ${command}`);
        });

        const result = await runPlanningSession({
            prompt: "Check the repo status",
            settings: createSettings(),
            conversationHistory: [],
        });

        expect(result.plan.proposedActions).toHaveLength(1);
        expect(result.plan.proposedActions[0]).toMatchObject({
            type: "shell",
            status: "pending",
            executed: false,
            toolCallId: "call-shell-1",
        });
        expect(result.toolTrace).toHaveLength(1);
        expect(result.toolTrace[0]?.status).toBe("pending_approval");
        expect(result.assistantReply).toContain("待审批动作");
    });

    it("suppresses a blocked pending shell proposal during continuation planning", async () => {
        vi.mocked(gatewayComplete).mockResolvedValue({
            status: 200,
            endpoint: "http://localhost:4000/chat/completions",
            body: JSON.stringify({
                id: "chatcmpl-test",
                choices: [
                    {
                        message: {
                            role: "assistant",
                            content: "",
                            tool_calls: [
                                {
                                    id: "call-shell-1",
                                    type: "function",
                                    function: {
                                        name: "propose_shell",
                                        arguments: JSON.stringify({
                                            shell: "git status --porcelain",
                                            description: "Inspect working tree",
                                        }),
                                    },
                                },
                            ],
                        },
                    },
                ],
                usage: {
                    prompt_tokens: 12,
                    completion_tokens: 8,
                },
            }),
        });
        vi.mocked(invoke).mockImplementation(async (command: string) => {
            if (command === "list_files") {
                return [];
            }
            throw new Error(`Unexpected invoke: ${command}`);
        });

        const result = await runPlanningSession({
            prompt: "Check the repo status",
            settings: createSettings(),
            conversationHistory: [],
            isContinuation: true,
            blockedActionFingerprints: ["shell:git status --porcelain:120000:foreground::"],
        });

        expect(result.plan.proposedActions).toHaveLength(0);
        // P0-1: The loop may iterate multiple turns since the static mock keeps
        // returning the same tool call. The key invariant is that proposedActions
        // remains empty (blocked fingerprint suppression) and all traces are
        // pending_approval for the blocked tool.
        expect(result.toolTrace.length).toBeGreaterThanOrEqual(1);
        expect(result.toolTrace[0]?.status).toBe("pending_approval");
    });

    it("keeps carried-forward tool details without showing a fresh tool-request placeholder", async () => {
        vi.mocked(resolveAgentRuntime).mockReturnValue({
            agentId: "agent-default",
            enabledTools: ["list_files"],
            toolPermissions: {
                ...DEFAULT_SETTINGS.toolPermissions,
                list_files: "auto",
            },
            allowedSubAgents: [],
        } as any);

        vi.mocked(gatewayStream).mockReset();
        vi.mocked(gatewayStream)
            .mockResolvedValueOnce({
                status: 200,
                endpoint: "http://localhost:4000/chat/completions",
                body: JSON.stringify({
                    id: "chatcmpl-empty-final-1",
                    choices: [
                        {
                            message: {
                                role: "assistant",
                                content: "",
                                tool_calls: [
                                    {
                                        id: "call-list-1",
                                        type: "function",
                                        function: {
                                            name: "list_files",
                                            arguments: JSON.stringify({ relative_path: "src" }),
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                    usage: {
                        prompt_tokens: 12,
                        completion_tokens: 8,
                    },
                }),
            })
            .mockResolvedValueOnce({
                status: 200,
                endpoint: "http://localhost:4000/chat/completions",
                body: JSON.stringify({
                    id: "chatcmpl-empty-final-2",
                    choices: [
                        {
                            message: {
                                role: "assistant",
                                content: "",
                            },
                        },
                    ],
                    usage: {
                        prompt_tokens: 10,
                        completion_tokens: 2,
                    },
                }),
            });
        vi.mocked(gatewayComplete).mockReset();
        vi.mocked(gatewayComplete).mockResolvedValueOnce({
            status: 200,
            endpoint: "http://localhost:4000/chat/completions",
            body: JSON.stringify({
                id: "chatcmpl-empty-final-fallback",
                choices: [
                    {
                        message: {
                            role: "assistant",
                            content: "",
                        },
                    },
                ],
                usage: {
                    prompt_tokens: 10,
                    completion_tokens: 2,
                },
            }),
        });

        vi.mocked(invoke).mockImplementation(async (command: string) => {
            if (command === "list_workspace_files") {
                return [];
            }
            throw new Error(`Unexpected invoke: ${command}`);
        });

        const result = await runPlanningSession({
            prompt: "看看项目里有哪些目录",
            settings: createSettings(),
            conversationHistory: [],
        });

        expect(result.toolTrace.length).toBeGreaterThanOrEqual(1);
        expect(result.toolTrace.some((trace) => trace.name === "list_files")).toBe(true);
        expect(result.assistantToolCalls).toHaveLength(1);
        expect(result.assistantReply).toBe("已完成工具调用。");
        expect(result.assistantReply).not.toContain("模型已请求工具调用");
    });

    it("does not force-stop exploration tasks after 25 tool turns", async () => {
        vi.mocked(classifyTaskType).mockReturnValue("exploration");
        vi.mocked(resolveAgentRuntime).mockReturnValue({
            agentId: "agent-default",
            enabledTools: ["list_files"],
            toolPermissions: {
                list_files: "auto",
                read_file: "auto",
                grep: "auto",
                glob: "auto",
                git_status: "auto",
                git_diff: "auto",
                propose_file_edit: "ask",
                propose_apply_patch: "ask",
                propose_shell: "ask",
                diagnostics: "auto",
                fetch: "ask",
            },
            allowedSubAgents: [],
        } as any);

        let llmCallCount = 0;
        vi.mocked(gatewayComplete).mockImplementation(async () => {
            llmCallCount += 1;
            if (llmCallCount <= 26) {
                return {
                    status: 200,
                    endpoint: "http://localhost:4000/chat/completions",
                    body: JSON.stringify({
                        id: `chatcmpl-${llmCallCount}`,
                        choices: [
                            {
                                message: {
                                    role: "assistant",
                                    content: "",
                                    tool_calls: [
                                        {
                                            id: `call-list-${llmCallCount}`,
                                            type: "function",
                                            function: {
                                                name: "list_files",
                                                arguments: JSON.stringify({ relative_path: "src" }),
                                            },
                                        },
                                    ],
                                },
                            },
                        ],
                        usage: {
                            prompt_tokens: 12,
                            completion_tokens: 8,
                        },
                    }),
                } as any;
            }

            return {
                status: 200,
                endpoint: "http://localhost:4000/chat/completions",
                body: JSON.stringify({
                    id: "chatcmpl-final",
                    choices: [
                        {
                            message: {
                                role: "assistant",
                                content: "探索完成",
                            },
                        },
                    ],
                    usage: {
                        prompt_tokens: 12,
                        completion_tokens: 8,
                    },
                }),
            } as any;
        });

        vi.mocked(invoke).mockImplementation(async (command: string) => {
            if (command === "list_workspace_files") {
                return [];
            }
            throw new Error(`Unexpected invoke: ${command}`);
        });

        const result = await runPlanningSession({
            prompt: "查找这个项目里和多 agent 调度相关的代码入口",
            settings: createSettings(),
            conversationHistory: [],
        });

        expect(llmCallCount).toBe(27);
        expect(result.toolTrace).toHaveLength(26);
        expect(result.assistantReply).toContain("探索完成");
        expect(result.assistantReply).not.toContain("工具调用预算");
    }, 15000);

    it("classifies review task type correctly", async () => {
        const actual = await vi.importActual<typeof import("../agents/promptAssembly")>(
            "../agents/promptAssembly",
        );
        expect(actual.classifyTaskType("前端页面怎么样 有没有值得优化的地方")).toBe("review");
        expect(actual.classifyTaskType("代码质量如何评价")).toBe("review");
        expect(actual.classifyTaskType("review the codebase and give suggestions")).toBe("review");
    });

    it("does not misclassify code_edit as review", async () => {
        const actual = await vi.importActual<typeof import("../agents/promptAssembly")>(
            "../agents/promptAssembly",
        );
        expect(actual.classifyTaskType("帮我修改登录页面")).toBe("code_edit");
        expect(actual.classifyTaskType("fix the bug in App.tsx")).toBe("code_edit");
    });

    it("includes review strategy rules for review task type", async () => {
        const actual = await vi.importActual<typeof import("../agents/promptAssembly")>(
            "../agents/promptAssembly",
        );
        const prompt = actual.assembleSystemPrompt(
            {
                agentId: "agent-default",
                systemPrompt: "system prompt",
                enabledTools: ["read_file", "grep"],
                modelRef: "gpt-5.4",
                toolPermissions: DEFAULT_SETTINGS.toolPermissions,
                allowedSubAgents: [],
            } as any,
            "review",
        );
        expect(prompt).toContain("审查/评估任务策略");
        expect(prompt).toContain("禁止穷举");
        expect(prompt).toContain("抽样阅读");
        // review type should NOT include editing rules (propose_* tool usage guide)
        expect(prompt).not.toContain("必须通过当前已暴露的 propose_* 工具提出待审批动作");
        // review type should NOT include toolSelection rules
        expect(prompt).not.toContain("工具选择关键规则");
    });

    it("returns cached result for deduplicated read_file calls", async () => {
        const { createWorkingMemory } = await vi.importActual<typeof import("./workingMemory")>(
            "./workingMemory",
        );
        const wm = createWorkingMemory({ maxTokenBudget: 4000 });
        wm.fileKnowledge.set("src/App.tsx", {
            relativePath: "src/App.tsx",
            summary: "Main app component",
            totalLines: 100,
            language: "typescript",
            lastReadAt: new Date().toISOString(),
            lastReadTurn: 3,
            readByAgent: "main",
        });

        // Simulate a second read of the same file at turn 5 (within dedup window)
        const result = await planningServiceTestUtils.executeToolCall(
            {
                id: "tool-dedup",
                type: "function",
                function: {
                    name: "read_file",
                    arguments: JSON.stringify({ relative_path: "src/App.tsx" }),
                },
            },
            "d:/Code/cofree",
            DEFAULT_SETTINGS.toolPermissions,
            undefined,   // settings
            undefined,   // projectConfig
            undefined,   // allowedSubAgents
            undefined,   // enabledToolNames
            undefined,   // planState
            wm,          // workingMemory
            undefined,   // onSubAgentProgress
            undefined,   // signal
            5,           // turn
        );

        expect(result.success).toBe(true);
        const payload = JSON.parse(result.content) as Record<string, unknown>;
        expect(payload.status).toBe("cached");
        expect(payload.cached_summary).toBe("Main app component");
    });

    it("allows read_file with line range even if file was recently read", async () => {
        const { createWorkingMemory } = await vi.importActual<typeof import("./workingMemory")>(
            "./workingMemory",
        );
        const wm = createWorkingMemory({ maxTokenBudget: 4000 });
        wm.fileKnowledge.set("src/App.tsx", {
            relativePath: "src/App.tsx",
            summary: "Main app component",
            totalLines: 100,
            language: "typescript",
            lastReadAt: new Date().toISOString(),
            lastReadTurn: 3,
            readByAgent: "main",
        });

        vi.mocked(invoke).mockImplementation(async (command: string) => {
            if (command === "read_workspace_file") {
                return {
                    content: "line content here\n",
                    total_lines: 100,
                    start_line: 10,
                    end_line: 20,
                };
            }
            throw new Error(`Unexpected invoke: ${command}`);
        });

        // Read with start_line/end_line should NOT be deduplicated
        const result = await planningServiceTestUtils.executeToolCall(
            {
                id: "tool-range",
                type: "function",
                function: {
                    name: "read_file",
                    arguments: JSON.stringify({
                        relative_path: "src/App.tsx",
                        start_line: 10,
                        end_line: 20,
                    }),
                },
            },
            "d:/Code/cofree",
            DEFAULT_SETTINGS.toolPermissions,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            wm,
            undefined,
            undefined,
            5,
        );

        expect(result.success).toBe(true);
        const payload = JSON.parse(result.content) as Record<string, unknown>;
        // Should NOT be cached — it's a targeted line range read
        expect(payload.status).not.toBe("cached");
        expect(payload.ok).toBe(true);
    });

    it("adds a PowerShell repair hint after failed auto propose_shell execution and allows a corrected retry", async () => {
        vi.mocked(resolveAgentRuntime).mockReturnValue({
            agentId: "agent-default",
            enabledTools: ["propose_shell"],
            toolPermissions: {
                ...DEFAULT_SETTINGS.toolPermissions,
                propose_shell: "auto",
            },
            allowedSubAgents: [],
        } as any);

        vi.mocked(gatewayComplete)
            .mockResolvedValueOnce({
                status: 200,
                endpoint: "http://localhost:4000/chat/completions",
                body: JSON.stringify({
                    id: "chatcmpl-test-1",
                    choices: [
                        {
                            message: {
                                role: "assistant",
                                content: "",
                                tool_calls: [
                                    {
                                        id: "call-shell-bad",
                                        type: "function",
                                        function: {
                                            name: "propose_shell",
                                            arguments: JSON.stringify({
                                                shell: "mkdir -p logs && npm test",
                                            }),
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                    usage: {
                        prompt_tokens: 12,
                        completion_tokens: 8,
                    },
                }),
            })
            .mockResolvedValueOnce({
                status: 200,
                endpoint: "http://localhost:4000/chat/completions",
                body: JSON.stringify({
                    id: "chatcmpl-test-2",
                    choices: [
                        {
                            message: {
                                role: "assistant",
                                content: "",
                                tool_calls: [
                                    {
                                        id: "call-shell-fixed",
                                        type: "function",
                                        function: {
                                            name: "propose_shell",
                                            arguments: JSON.stringify({
                                                shell: "New-Item -ItemType Directory -Force logs; npm test",
                                            }),
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                    usage: {
                        prompt_tokens: 16,
                        completion_tokens: 8,
                    },
                }),
            })
            .mockResolvedValueOnce({
                status: 200,
                endpoint: "http://localhost:4000/chat/completions",
                body: JSON.stringify({
                    id: "chatcmpl-test-3",
                    choices: [
                        {
                            message: {
                                role: "assistant",
                                content: "done",
                            },
                        },
                    ],
                    usage: {
                        prompt_tokens: 10,
                        completion_tokens: 2,
                    },
                }),
            });

        vi.mocked(invoke).mockImplementation(async (command: string) => {
            if (command === "list_files") {
                return [];
            }
            throw new Error(`Unexpected invoke: ${command}`);
        });
        vi.mocked(awaitShellCommandWithDeadline).mockImplementation(async (params) => {
            const shell = params.shell;
            if (shell === "mkdir -p logs && npm test") {
                return {
                    moved_to_background: false,
                    result: {
                        success: false,
                        command: shell,
                        timed_out: false,
                        status: 1,
                        stdout: "",
                        stderr:
                            "ParserError: The token '&&' is not a valid statement separator in this version.\nCategoryInfo : ParserError\nFullyQualifiedErrorId : InvalidEndOfLine",
                    },
                };
            }
            if (shell === "New-Item -ItemType Directory -Force logs; npm test") {
                return {
                    moved_to_background: false,
                    result: {
                        success: true,
                        command: shell,
                        timed_out: false,
                        status: 0,
                        stdout: "ok",
                        stderr: "",
                    },
                };
            }
            throw new Error(`Unexpected awaitShellCommandWithDeadline: ${shell}`);
        });

        const result = await runPlanningSession({
            prompt: "Create a logs directory and run tests",
            settings: createSettings(),
            conversationHistory: [],
        });

        const secondMessages2 = (vi.mocked(gatewayComplete).mock.calls[1]?.[0] ?? []) as Array<{ role: string; content: string }>;
        const repairMessage = [...secondMessages2]
            .reverse()
            .find(
                (message) =>
                    message.role === "system" &&
                    message.content.includes("shell 方言不匹配"),
            );
        const shellCalls = vi.mocked(awaitShellCommandWithDeadline).mock.calls;

        expect(shellCalls).toHaveLength(2);
        expect(shellCalls[0]?.[0]).toMatchObject({
            shell: "mkdir -p logs && npm test",
        });
        expect(shellCalls[1]?.[0]).toMatchObject({
            shell: "New-Item -ItemType Directory -Force logs; npm test",
        });
        expect(repairMessage?.content).toContain(
            "当前 Windows 执行器实际使用 PowerShell",
        );
        expect(repairMessage?.content).toContain(
            "不要重复使用 bash/cmd 风格写法如 mkdir -p 或 &&",
        );
        expect(repairMessage?.content).toContain(
            "New-Item -ItemType Directory -Force <目录>",
        );
        expect(result.assistantReply).toBe("done");
    });

    it("uses build_workspace_edit_patch for minimal propose_file_edit diffs", async () => {
        const original = "alpha\nbeta\ngamma\n";
        const minimalPatch = [
            "diff --git a/src/example.ts b/src/example.ts",
            "index 85c3040..9b8acd0 100644",
            "--- a/src/example.ts",
            "+++ b/src/example.ts",
            "@@ -1,3 +1,4 @@",
            " alpha",
            " beta",
            "+inserted",
            " gamma",
            "",
        ].join("\n");

        vi.mocked(invoke).mockImplementation(async (command: string, args?: any) => {
            if (command === "read_workspace_file") {
                return {
                    content: original,
                    total_lines: 3,
                    start_line: 1,
                    end_line: 3,
                };
            }
            if (command === "build_workspace_edit_patch") {
                expect(args).toMatchObject({
                    relativePath: "src/example.ts",
                    before: original,
                    after: "alpha\nbeta\ninserted\ngamma\n",
                });
                return minimalPatch;
            }
            if (command === "check_workspace_patch") {
                expect(args?.patch).toBe(minimalPatch);
                return {
                    success: true,
                    message: "Patch 可应用（1 files）",
                    files: ["src/example.ts"],
                };
            }
            throw new Error(`Unexpected invoke: ${command}`);
        });

        const result = await planningServiceTestUtils.executeToolCall(
            {
                id: "tool-file-edit",
                type: "function",
                function: {
                    name: "propose_file_edit",
                    arguments: JSON.stringify({
                        relative_path: "src/example.ts",
                        operation: "insert",
                        line: 2,
                        content: "inserted\n",
                        position: "after",
                    }),
                },
            },
            "d:/Code/cofree",
            {
                ...DEFAULT_SETTINGS.toolPermissions,
                propose_file_edit: "ask",
            },
        );

        expect(result.success).toBe(true);
        expect(result.proposedAction).toMatchObject({
            type: "apply_patch",
            status: "pending",
            executed: false,
            payload: {
                patch: minimalPatch,
            },
        });

        const buildCalls = vi.mocked(invoke).mock.calls.filter(
            ([command]) => command === "build_workspace_edit_patch",
        );
        expect(buildCalls).toHaveLength(1);
    });

    it("rejects multi-file propose_apply_patch requests", async () => {
        vi.mocked(invoke).mockImplementation(async (command: string, args?: any) => {
            if (command === "check_workspace_patch") {
                expect(args?.patch).toContain("diff --git a/src/a.ts b/src/a.ts");
                return {
                    success: true,
                    message: "Patch 可应用（2 files）",
                    files: ["src/a.ts", "src/b.ts"],
                };
            }
            throw new Error(`Unexpected invoke: ${command}`);
        });

        const multiFilePatch = [
            "diff --git a/src/a.ts b/src/a.ts",
            "--- a/src/a.ts",
            "+++ b/src/a.ts",
            "@@ -1 +1 @@",
            "-a",
            "+aa",
            "diff --git a/src/b.ts b/src/b.ts",
            "--- a/src/b.ts",
            "+++ b/src/b.ts",
            "@@ -1 +1 @@",
            "-b",
            "+bb",
            "",
        ].join("\n");

        const result = await planningServiceTestUtils.executeToolCall(
            {
                id: "tool-raw-patch-multifile",
                type: "function",
                function: {
                    name: "propose_apply_patch",
                    arguments: JSON.stringify({
                        patch: multiFilePatch,
                    }),
                },
            },
            "d:/Code/cofree",
            {
                ...DEFAULT_SETTINGS.toolPermissions,
                propose_apply_patch: "ask",
            },
        );

        expect(result.success).toBe(false);
        expect(result.errorCategory).toBe("validation");
        expect(result.errorMessage).toContain("仅允许单文件 patch");
        expect(result.content).toContain("src/a.ts");
        expect(result.content).toContain("src/b.ts");
    });
});

// ---------------------------------------------------------------------------
// Context Editing: clearOldToolUses tests
// ---------------------------------------------------------------------------

/** Helper: build a read_file tool-use turn (assistant + tool response). */
function makeReadFileTurn(turnIndex: number): LiteLLMMessage[] {
    const callId = `call-rf-${turnIndex}`;
    return [
        {
            role: "assistant",
            content: "",
            tool_calls: [
                {
                    id: callId,
                    type: "function" as const,
                    function: { name: "read_file", arguments: JSON.stringify({ relative_path: `file${turnIndex}.ts` }) },
                },
            ],
        },
        {
            role: "tool",
            content: `contents of file${turnIndex}.ts — lots of code here...`,
            tool_call_id: callId,
            name: "read_file",
        },
    ];
}

/** Helper: build a propose_file_edit tool-use turn. */
function makeEditTurn(turnIndex: number): LiteLLMMessage[] {
    const callId = `call-edit-${turnIndex}`;
    return [
        {
            role: "assistant",
            content: "",
            tool_calls: [
                {
                    id: callId,
                    type: "function" as const,
                    function: { name: "propose_file_edit", arguments: JSON.stringify({ path: `file${turnIndex}.ts`, edit: "change" }) },
                },
            ],
        },
        {
            role: "tool",
            content: `edit applied to file${turnIndex}.ts`,
            tool_call_id: callId,
            name: "propose_file_edit",
        },
    ];
}

describe("clearOldToolUses", () => {
    it("clears old read_file turns while keeping the most recent ones", () => {
        const pinned: LiteLLMMessage[] = [
            { role: "system", content: "system prompt" },
            { role: "system", content: "runtime context" },
        ];
        const turns: LiteLLMMessage[] = [];
        for (let i = 0; i < 10; i++) {
            turns.push(...makeReadFileTurn(i));
        }

        const messages = [...pinned, ...turns];

        const result = clearOldToolUses(messages, {
            keepRecentTurns: 3,
            clearAtLeast: 3,
            pinnedPrefixLen: 2,
        });

        expect(result.cleared).toBe(true);
        expect(result.pairsRemoved).toBe(7);
        // Remaining: 2 pinned + 1 tombstone + 3 recent turns * 2 messages = 9
        expect(result.messages.length).toBe(9);
    });

    it("does not clear turns containing action tools like propose_file_edit", () => {
        const pinned: LiteLLMMessage[] = [
            { role: "system", content: "system prompt" },
        ];
        // 4 read_file turns, then 1 propose_file_edit turn, then 2 read_file turns
        const turns: LiteLLMMessage[] = [
            ...makeReadFileTurn(0),
            ...makeReadFileTurn(1),
            ...makeReadFileTurn(2),
            ...makeReadFileTurn(3),
            ...makeEditTurn(4),
            ...makeReadFileTurn(5),
            ...makeReadFileTurn(6),
        ];

        const messages = [...pinned, ...turns];

        const result = clearOldToolUses(messages, {
            keepRecentTurns: 2,
            clearAtLeast: 3,
            pinnedPrefixLen: 1,
        });

        expect(result.cleared).toBe(true);
        // Only read_file turns are clearable (6 total), keep recent 2 → clear 4
        expect(result.pairsRemoved).toBe(4);

        // The propose_file_edit turn should still be present
        const editAssistant = result.messages.find(
            (m) => m.tool_calls?.some((tc) => tc.function.name === "propose_file_edit"),
        );
        expect(editAssistant).toBeDefined();
    });

    it("does not execute when clearable turns < clearAtLeast", () => {
        const pinned: LiteLLMMessage[] = [
            { role: "system", content: "system prompt" },
        ];
        // Only 5 read_file turns, keepRecentTurns=3 → only 2 clearable, clearAtLeast=3
        const turns: LiteLLMMessage[] = [];
        for (let i = 0; i < 5; i++) {
            turns.push(...makeReadFileTurn(i));
        }

        const messages = [...pinned, ...turns];

        const result = clearOldToolUses(messages, {
            keepRecentTurns: 3,
            clearAtLeast: 3,
            pinnedPrefixLen: 1,
        });

        expect(result.cleared).toBe(false);
        expect(result.pairsRemoved).toBe(0);
        expect(result.messages).toBe(messages); // same reference, no copy
    });

    it("maintains pair integrity: every remaining tool_calls[].id has a matching tool message", () => {
        const pinned: LiteLLMMessage[] = [
            { role: "system", content: "system prompt" },
            { role: "system", content: "runtime context" },
        ];
        const turns: LiteLLMMessage[] = [];
        for (let i = 0; i < 12; i++) {
            turns.push(...makeReadFileTurn(i));
        }

        const messages = [...pinned, ...turns];

        const result = clearOldToolUses(messages, {
            keepRecentTurns: 4,
            clearAtLeast: 3,
            pinnedPrefixLen: 2,
        });

        expect(result.cleared).toBe(true);

        // Verify integrity: for each remaining assistant with tool_calls,
        // every tool_call id must have a corresponding tool message
        const remainingToolCallIds = new Set<string>();
        const remainingToolResponseIds = new Set<string>();

        for (const msg of result.messages) {
            if (msg.role === "assistant" && msg.tool_calls) {
                for (const tc of msg.tool_calls) {
                    remainingToolCallIds.add(tc.id);
                }
            }
            if (msg.role === "tool" && msg.tool_call_id) {
                remainingToolResponseIds.add(msg.tool_call_id);
            }
        }

        for (const id of remainingToolCallIds) {
            expect(remainingToolResponseIds.has(id)).toBe(true);
        }
    });

    it("does not modify messages in the pinned prefix", () => {
        const pinned: LiteLLMMessage[] = [
            { role: "system", content: "system prompt" },
            { role: "system", content: "runtime context" },
            { role: "system", content: "workspace overview" },
        ];
        const turns: LiteLLMMessage[] = [];
        for (let i = 0; i < 10; i++) {
            turns.push(...makeReadFileTurn(i));
        }

        const messages = [...pinned, ...turns];

        const result = clearOldToolUses(messages, {
            keepRecentTurns: 3,
            clearAtLeast: 3,
            pinnedPrefixLen: 3,
        });

        expect(result.cleared).toBe(true);

        // First 3 messages should be exactly the pinned prefix
        expect(result.messages[0]).toEqual(pinned[0]);
        expect(result.messages[1]).toEqual(pinned[1]);
        expect(result.messages[2]).toEqual(pinned[2]);
    });

    it("inserts exactly one tombstone system message after clearing", () => {
        const pinned: LiteLLMMessage[] = [
            { role: "system", content: "system prompt" },
        ];
        const turns: LiteLLMMessage[] = [];
        for (let i = 0; i < 10; i++) {
            turns.push(...makeReadFileTurn(i));
        }

        const messages = [...pinned, ...turns];

        const result = clearOldToolUses(messages, {
            keepRecentTurns: 3,
            clearAtLeast: 3,
            pinnedPrefixLen: 1,
        });

        expect(result.cleared).toBe(true);

        const tombstones = result.messages.filter(
            (m) => m.role === "system" && m.content.includes("[Context Edited]"),
        );
        expect(tombstones).toHaveLength(1);
        expect(tombstones[0].content).toContain("已清除 7 个旧工具调用轮次");
    });

    it("removes the entire assistant message when content is empty and all tool_calls are cleared", () => {
        const pinned: LiteLLMMessage[] = [
            { role: "system", content: "system prompt" },
        ];

        // Create turns where assistant has empty content
        const turns: LiteLLMMessage[] = [];
        for (let i = 0; i < 8; i++) {
            turns.push(...makeReadFileTurn(i)); // content is ""
        }

        // Add one turn where assistant has textual content
        const specialCallId = "call-special";
        turns.push(
            {
                role: "assistant",
                content: "I found important information about the architecture.",
                tool_calls: [
                    {
                        id: specialCallId,
                        type: "function" as const,
                        function: { name: "read_file", arguments: JSON.stringify({ relative_path: "special.ts" }) },
                    },
                ],
            },
            {
                role: "tool",
                content: "special file contents",
                tool_call_id: specialCallId,
                name: "read_file",
            },
        );

        // Add recent turns to protect
        for (let i = 9; i < 14; i++) {
            turns.push(...makeReadFileTurn(i));
        }

        const messages = [...pinned, ...turns];

        const result = clearOldToolUses(messages, {
            keepRecentTurns: 5,
            clearAtLeast: 3,
            pinnedPrefixLen: 1,
        });

        expect(result.cleared).toBe(true);

        // The assistant messages with empty content should be fully removed.
        // The assistant with "I found important information" should still exist (content preserved).
        const assistantsWithContent = result.messages.filter(
            (m) => m.role === "assistant" && (m.content ?? "").includes("important information"),
        );
        // It was in a clearable turn (read_file, not in recent 5), so it gets cleared
        // but the assistant message should be kept with content, tool_calls stripped
        if (assistantsWithContent.length > 0) {
            // If kept, it should NOT have tool_calls
            expect(assistantsWithContent[0].tool_calls).toBeUndefined();
        }

        // The empty-content assistant messages that were cleared should not exist
        const emptyAssistants = result.messages.filter(
            (m) => m.role === "assistant" && (m.content ?? "").trim() === "" && !m.tool_calls,
        );
        expect(emptyAssistants).toHaveLength(0);
    });

    it("keeps the full leading system prefix during compression even if pinnedPrefixLen is too small", async () => {
        const result = await compressMessagesToFitBudget({
            messages: [
                { role: "system", content: "system prompt" },
                { role: "system", content: "[Todo Plan]\n○ [step-plan] (planner/in_progress) 分析需求 [当前]" },
                { role: "user", content: "A".repeat(600) },
                { role: "assistant", content: "B".repeat(600) },
            ],
            policy: {
                maxPromptTokens: 60,
                minMessagesToSummarize: 10,
                minRecentMessagesToKeep: 1,
                recentTokensMinRatio: 0.2,
            },
            pinnedPrefixLen: 1,
        });

        expect(result.compressed).toBe(true);
        expect(result.messages[0]).toMatchObject({ role: "system", content: "system prompt" });
        expect(result.messages[1]).toMatchObject({
            role: "system",
            content: "[Todo Plan]\n○ [step-plan] (planner/in_progress) 分析需求 [当前]",
        });
    });
});

// ===================================================================
// P5-1: Regression tests for multi-agent remediation
// ===================================================================


describe("P3-2: restoredWorkingMemory in runPlanningSession", () => {
    it("returns workingMemorySnapshot that retains restored file knowledge after a no-tool turn", async () => {
        const streamBody = JSON.stringify({
            id: "chatcmpl-wm-restore",
            choices: [
                {
                    message: {
                        role: "assistant",
                        content: "done",
                    },
                },
            ],
            usage: { prompt_tokens: 4, completion_tokens: 2 },
        });
        vi.mocked(gatewayStream).mockResolvedValueOnce({
            status: 200,
            endpoint: "http://localhost:4000/chat/completions",
            body: streamBody,
        } as any);
        vi.mocked(gatewayComplete).mockResolvedValue({
            status: 200,
            endpoint: "http://localhost:4000/chat/completions",
            body: streamBody,
        });
        vi.mocked(invoke).mockImplementation(async (command: string) => {
            if (command === "list_workspace_files") {
                return [];
            }
            throw new Error(`Unexpected invoke: ${command}`);
        });

        const restored: WorkingMemorySnapshot = {
            fileKnowledge: [
                [
                    "src/restored.ts",
                    {
                        relativePath: "src/restored.ts",
                        summary: "restored from checkpoint",
                        totalLines: 10,
                        lastReadAt: "2026-01-01T00:00:00Z",
                        lastReadTurn: 0,
                        readByAgent: "test",
                    },
                ],
            ],
            discoveredFacts: [],
            subAgentHistory: [],
            taskProgress: [],
            projectContext: "restored-project-context",
            maxTokenBudget: 4000,
        };

        const result = await runPlanningSession({
            prompt: "hi",
            settings: createSettings(),
            conversationHistory: [],
            restoredWorkingMemory: restored,
        });

        const snapshot = result.workingMemorySnapshot;
        expect(snapshot).toBeDefined();
        const entry = snapshot!.fileKnowledge.find(([p]) => p === "src/restored.ts");
        expect(entry?.[1].summary).toBe("restored from checkpoint");
        expect(snapshot!.projectContext).toContain("restored");
    });
});


describe("evaluateCompressionSafeZone", () => {
    const { evaluateCompressionSafeZone } = planningServiceTestUtils;

    it("uses the latest token estimate when deciding compression safe-zone bypass", () => {
        const tokenTracker = {
            update: vi.fn()
                .mockReturnValueOnce(120)
                .mockReturnValueOnce(820),
        } as any;

        const messages: LiteLLMMessage[] = [
            { role: "user", content: "start" },
        ];

        // Simulate the turn-start estimate that is now stale after system-note injection.
        const turnStartTokens = tokenTracker.update(messages);
        expect(turnStartTokens).toBe(120);

        messages.push({
            role: "system",
            content: "late injected system message that increases token usage",
        });

        const evaluation = evaluateCompressionSafeZone({
            tokenTracker,
            messages,
            promptBudgetTarget: 1000,
            safeZoneRatio: 0.7,
        });

        expect(tokenTracker.update).toHaveBeenCalledTimes(2);
        expect(evaluation.currentTokens).toBe(820);
        expect(evaluation.skipCompression).toBe(false);
    });
});
// ---------------------------------------------------------------------------
// Message sanitization tests
// ---------------------------------------------------------------------------

describe("sanitizeMessagesForToolCalling", () => {
    const { sanitizeMessagesForToolCalling } = planningServiceTestUtils;

    it("moves interleaved system messages after tool result block", () => {
        const messages: LiteLLMMessage[] = [
            { role: "system", content: "You are a helpful assistant." },
            { role: "user", content: "Fix the bug." },
            {
                role: "assistant",
                content: "",
                tool_calls: [
                    { id: "tc1", type: "function", function: { name: "read_file", arguments: '{"relative_path":"a.ts"}' } },
                    { id: "tc2", type: "function", function: { name: "read_file", arguments: '{"relative_path":"b.ts"}' } },
                ],
            },
            { role: "tool", tool_call_id: "tc1", content: '{"ok":true}' },
            { role: "system", content: "Dedup reminder" },
            { role: "tool", tool_call_id: "tc2", content: '{"ok":true}' },
        ];

        const sanitized = sanitizeMessagesForToolCalling(messages);
        expect(sanitized).toHaveLength(6);
        // Tool results should be consecutive after the assistant message
        expect(sanitized[2].role).toBe("assistant");
        expect(sanitized[3].role).toBe("tool");
        expect(sanitized[3].tool_call_id).toBe("tc1");
        expect(sanitized[4].role).toBe("tool");
        expect(sanitized[4].tool_call_id).toBe("tc2");
        // System message should come after tool results
        expect(sanitized[5].role).toBe("system");
        expect(sanitized[5].content).toContain("Dedup reminder");
    });

    it("preserves order when no system messages are interleaved", () => {
        const messages: LiteLLMMessage[] = [
            { role: "system", content: "System prompt." },
            { role: "user", content: "Hello" },
            {
                role: "assistant",
                content: "",
                tool_calls: [
                    { id: "tc1", type: "function", function: { name: "list_files", arguments: '{}' } },
                ],
            },
            { role: "tool", tool_call_id: "tc1", content: '{"ok":true}' },
            { role: "assistant", content: "Done!" },
        ];

        const sanitized = sanitizeMessagesForToolCalling(messages);
        expect(sanitized).toEqual(messages);
    });

    it("consolidates multiple interleaved system messages into one", () => {
        const messages: LiteLLMMessage[] = [
            { role: "user", content: "Do something" },
            {
                role: "assistant",
                content: "",
                tool_calls: [
                    { id: "tc1", type: "function", function: { name: "read_file", arguments: '{}' } },
                ],
            },
            { role: "system", content: "Progress update 1" },
            { role: "system", content: "Progress update 2" },
            { role: "tool", tool_call_id: "tc1", content: '{"ok":true}' },
        ];

        const sanitized = sanitizeMessagesForToolCalling(messages);
        // assistant + tool + consolidated system = 4 messages (user + assistant + tool + system)
        expect(sanitized).toHaveLength(4);
        expect(sanitized[2].role).toBe("tool");
        expect(sanitized[3].role).toBe("system");
        expect(sanitized[3].content).toContain("Progress update 1");
        expect(sanitized[3].content).toContain("Progress update 2");
    });
});

describe("pruneStaleSystemMessages", () => {
    const { pruneStaleSystemMessages } = planningServiceTestUtils;

    it("removes oldest interstitial system messages when exceeding limit", () => {
        const messages: LiteLLMMessage[] = [
            { role: "system", content: "Pinned system prompt" },
            { role: "user", content: "Hello" },
            { role: "system", content: "Old hint 1" },
            { role: "assistant", content: "Thinking..." },
            { role: "system", content: "Old hint 2" },
            { role: "system", content: "Recent hint 1" },
            { role: "system", content: "Recent hint 2" },
        ];

        const pruned = pruneStaleSystemMessages(messages, 1, 2);
        // Should keep only the 2 most recent system messages (Recent hint 1 & 2)
        expect(pruned).toHaveLength(5);
        const sysContents = pruned.filter(m => m.role === "system").map(m => m.content);
        expect(sysContents).toContain("Pinned system prompt");
        expect(sysContents).toContain("Recent hint 1");
        expect(sysContents).toContain("Recent hint 2");
        expect(sysContents).not.toContain("Old hint 1");
        expect(sysContents).not.toContain("Old hint 2");
    });

    it("does not remove messages when under the limit", () => {
        const messages: LiteLLMMessage[] = [
            { role: "system", content: "Pinned" },
            { role: "user", content: "Hello" },
            { role: "system", content: "Hint 1" },
        ];

        const pruned = pruneStaleSystemMessages(messages, 1, 5);
        expect(pruned).toEqual(messages);
    });
});

describe("detectPseudoToolCallNarration (enhanced patterns)", () => {
    const { detectPseudoToolCallNarration } = planningServiceTestUtils;
    const tools = ["read_file", "grep", "propose_file_edit", "list_files"];

    it("detects 'I am going to call read_file' pattern", () => {
        const result = detectPseudoToolCallNarration(
            "I am going to call read_file to check the contents.",
            tools,
        );
        expect(result).not.toBeNull();
    });

    it("detects code block with tool call JSON", () => {
        const result = detectPseudoToolCallNarration(
            '```json\n{"name": "read_file", "arguments": {"relative_path": "src/app.ts"}}\n```',
            tools,
        );
        expect(result).not.toBeNull();
    });

    it("detects 'calling the tool' pattern", () => {
        const result = detectPseudoToolCallNarration(
            "I am calling the tool read_file now to get the contents.",
            tools,
        );
        expect(result).not.toBeNull();
    });

    it("returns null for normal assistant text without tool mention patterns", () => {
        const result = detectPseudoToolCallNarration(
            "The file contains a function called processData that handles validation.",
            tools,
        );
        expect(result).toBeNull();
    });

    it("returns null for empty content", () => {
        const result = detectPseudoToolCallNarration("", tools);
        expect(result).toBeNull();
    });
});
