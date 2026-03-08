import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
    invoke: vi.fn(),
}));

vi.mock("../lib/cofreerc", () => ({
    loadCofreeRc: vi.fn(async () => ({})),
    buildCofreeRcPromptFragment: vi.fn(() => ""),
}));

vi.mock("./readOnlyWorkspaceService", () => ({
    summarizeWorkspaceFiles: vi.fn(async () => "workspace summary"),
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

vi.mock("../lib/litellm", () => ({
    createLiteLLMRequestBody: vi.fn((messages, _settings, options) => ({
        model: "test-model",
        messages,
        stream: options?.stream ?? false,
        tools: options?.tools,
        tool_choice: options?.toolChoice,
    })),
    isHighRiskToolCallingModelCombo: vi.fn(() => true),
    postLiteLLMChatCompletions: vi.fn(),
    postLiteLLMChatCompletionsStream: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { postLiteLLMChatCompletions } from "../lib/litellm";
import { resolveAgentRuntime } from "../agents/resolveAgentRuntime";
import { DEFAULT_SETTINGS, type AppSettings } from "../lib/settingsStore";
import {
    planningServiceTestUtils,
    runPlanningSession,
    type ToolExecutionTrace,
} from "./planningService";

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

describe("planningService approval-flow repair", () => {
    beforeEach(() => {
        vi.clearAllMocks();
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
            toolPermissions: {
                ...DEFAULT_SETTINGS.toolPermissions,
                propose_shell: "auto",
            },
            allowedSubAgents: [],
        } as any);

        expect(prompt).toContain("Windows 实际通过 PowerShell 执行");
        expect(prompt).toContain("不要重复 mkdir -p、rm -r、&&");
        expect(prompt).toContain("Remove-Item -Recurse -Force");
    });

    it("exposes PowerShell-aware propose_shell tool definitions in planning requests", async () => {
        vi.mocked(postLiteLLMChatCompletions).mockResolvedValue({
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
            if (command === "list_files") {
                return [];
            }
            throw new Error(`Unexpected invoke: ${command}`);
        });

        await runPlanningSession({
            prompt: "Describe the shell tool contract",
            settings: createSettings(),
            conversationHistory: [],
        });

        const firstRequestBody = vi.mocked(postLiteLLMChatCompletions).mock.calls[0]?.[1] as {
            tools: Array<{
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
        };
        const shellTool = firstRequestBody.tools.find(
            (tool) => tool.function.name === "propose_shell",
        );

        expect(shellTool?.function.description).toContain("PowerShell");
        expect(shellTool?.function.description).toContain("New-Item -ItemType Directory -Force");
        expect(shellTool?.function.description).toContain("Read stderr carefully and retry with corrected syntax");
        expect(shellTool?.function.parameters.properties.shell.description).toContain(
            "On Windows prefer PowerShell syntax",
        );
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
            ["shell:git status --porcelain:120000"],
        );

        expect(actions).toHaveLength(0);
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

    it("keeps pending shell proposals visible in the full planning pipeline", async () => {
        vi.mocked(postLiteLLMChatCompletions).mockResolvedValue({
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
        vi.mocked(postLiteLLMChatCompletions).mockResolvedValue({
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
            blockedActionFingerprints: ["shell:git status --porcelain:120000"],
        });

        expect(result.plan.proposedActions).toHaveLength(0);
        expect(result.toolTrace).toHaveLength(1);
        expect(result.toolTrace[0]?.status).toBe("pending_approval");
        expect(result.assistantReply).toContain("审批卡片未能保留");
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

        vi.mocked(postLiteLLMChatCompletions)
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

        vi.mocked(invoke).mockImplementation(async (command: string, args?: any) => {
            if (command === "list_files") {
                return [];
            }
            if (command === "run_shell_command") {
                const shell = String(args?.shell ?? "");
                if (shell === "mkdir -p logs && npm test") {
                    return {
                        success: false,
                        command: shell,
                        timed_out: false,
                        status: 1,
                        stdout: "",
                        stderr:
                            "ParserError: The token '&&' is not a valid statement separator in this version.\nCategoryInfo : ParserError\nFullyQualifiedErrorId : InvalidEndOfLine",
                    };
                }
                if (shell === "New-Item -ItemType Directory -Force logs; npm test") {
                    return {
                        success: true,
                        command: shell,
                        timed_out: false,
                        status: 0,
                        stdout: "ok",
                        stderr: "",
                    };
                }
            }
            throw new Error(`Unexpected invoke: ${command}`);
        });

        const result = await runPlanningSession({
            prompt: "Create a logs directory and run tests",
            settings: createSettings(),
            conversationHistory: [],
        });

        const secondRequestBody = vi.mocked(postLiteLLMChatCompletions).mock.calls[1]?.[1] as {
            messages: Array<{ role: string; content: string }>;
        };
        const repairMessage = [...(secondRequestBody?.messages ?? [])]
            .reverse()
            .find(
                (message) =>
                    message.role === "system" &&
                    message.content.includes("shell 方言不匹配"),
            );
        const shellCalls = vi.mocked(invoke).mock.calls.filter(
            ([command]) => command === "run_shell_command",
        );

        expect(shellCalls).toHaveLength(2);
        expect(shellCalls[0]?.[1]).toMatchObject({
            shell: "mkdir -p logs && npm test",
        });
        expect(shellCalls[1]?.[1]).toMatchObject({
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
});
