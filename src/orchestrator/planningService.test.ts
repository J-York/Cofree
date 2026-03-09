import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
    invoke: vi.fn(),
}));

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
import { addWorkspaceApprovalRule } from "../lib/approvalRuleStore";
import { postLiteLLMChatCompletions, type LiteLLMMessage } from "../lib/litellm";
import { resolveAgentRuntime } from "../agents/resolveAgentRuntime";
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
import { clearOldToolUses } from "./contextBudget";

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
        const planTool = firstRequestBody.tools.find(
            (tool) => tool.function.name === "update_plan",
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
        vi.mocked(postLiteLLMChatCompletions).mockResolvedValue({
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
        vi.mocked(postLiteLLMChatCompletions).mockResolvedValue({
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

        const firstRequestBody = vi.mocked(postLiteLLMChatCompletions).mock.calls[0]?.[1] as {
            messages: Array<{ role: string; content: string }>;
        };
        const systemPrompt = firstRequestBody?.messages?.[0]?.content ?? "";

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
        vi.mocked(postLiteLLMChatCompletions).mockResolvedValue({
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

        const firstRequestBody = vi.mocked(postLiteLLMChatCompletions).mock.calls[0]?.[1] as {
            messages: Array<{ role: string; content: string }>;
        };
        const systemPrompt = firstRequestBody?.messages?.[0]?.content ?? "";

        expect(systemPrompt).toContain("[命中的项目规则]");
        expect(systemPrompt).toContain("auth-ui");
        expect(systemPrompt).toContain("docs/ARCHITECTURE.md");
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
        vi.mocked(postLiteLLMChatCompletions).mockResolvedValue({
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

        const firstRequestBody = vi.mocked(postLiteLLMChatCompletions).mock.calls[0]?.[1] as {
            messages: Array<{ role: string; content: string }>;
        };
        const systemPrompt = firstRequestBody?.messages?.[0]?.content ?? "";

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
        vi.mocked(invoke).mockImplementation(async (command: string, args?: any) => {
            if (command === "run_shell_command") {
                expect(args).toMatchObject({
                    workspacePath: "d:/Code/cofree",
                    shell: "git add src/app.ts",
                    timeoutMs: 120000,
                });
                return {
                    success: true,
                    command: "git add src/app.ts",
                    timed_out: false,
                    status: 0,
                    stdout: "ok",
                    stderr: "",
                };
            }
            throw new Error(`Unexpected invoke: ${command}`);
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
});
