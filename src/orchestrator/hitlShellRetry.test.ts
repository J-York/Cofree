import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
    invoke: vi.fn(),
}));

vi.mock("../lib/tauriBridge", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../lib/tauriBridge")>();
    return {
        ...actual,
        awaitShellCommandWithDeadline: vi.fn(),
    };
});

import { awaitShellCommandWithDeadline } from "../lib/tauriBridge";
import {
    approveAllPendingActions,
    approveAction,
    retryFailedShellAction,
} from "./hitlService";
import { decideHitlContinuation } from "./hitlContinuationMachine";
import type { OrchestrationPlan } from "./types";

function createShellPlan(): OrchestrationPlan {
    return {
        state: "human_review",
        prompt: "run failing shell command",
        steps: [
            {
                id: "step-shell",
                title: "执行验证命令",
                summary: "运行 shell 命令并检查输出",
                owner: "tester",
                status: "in_progress",
            },
        ],
        activeStepId: "step-shell",
        proposedActions: [
            {
                id: "shell-1",
                type: "shell",
                description: "Run test command",
                gateRequired: true,
                status: "pending",
                executed: false,
                toolCallId: "tool-1",
                toolName: "propose_shell",
                fingerprint: "fp-shell-1",
                planStepId: "step-shell",
                payload: {
                    shell: "npm test",
                    timeoutMs: 1000,
                },
            },
        ],
    };
}

function createMultiShellPlan(): OrchestrationPlan {
    return {
        state: "human_review",
        prompt: "run multiple shell commands",
        steps: [
            {
                id: "step-shell",
                title: "执行验证命令",
                summary: "运行 shell 命令并检查输出",
                owner: "tester",
                status: "in_progress",
            },
        ],
        activeStepId: "step-shell",
        proposedActions: [
            {
                id: "shell-team",
                type: "shell",
                description: "Run team command",
                gateRequired: true,
                status: "pending",
                executed: false,
                toolCallId: "tool-team",
                toolName: "propose_shell",
                fingerprint: "fp-shell-team",
                planStepId: "step-shell",
                payload: {
                    shell: "pnpm test team",
                    timeoutMs: 1000,
                },
            },
            {
                id: "shell-manual",
                type: "shell",
                description: "Run manual command",
                gateRequired: true,
                status: "pending",
                executed: false,
                toolCallId: "tool-manual",
                toolName: "propose_shell",
                fingerprint: "fp-shell-manual",
                planStepId: "step-shell",
                payload: {
                    shell: "pnpm test manual",
                    timeoutMs: 1000,
                },
            },
        ],
    };
}

describe("HITL shell retry flow", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("prefers stderr for failed shell execution messages while preserving metadata", async () => {
        vi.mocked(awaitShellCommandWithDeadline).mockResolvedValue({
            moved_to_background: false,
            result: {
                success: false,
                command: "npm test",
                timed_out: false,
                status: 2,
                stdout: "stdout text",
                stderr: "meaningful stderr",
                cancelled: false,
                stdout_truncated: false,
                stderr_truncated: false,
                stdout_total_bytes: 11,
                stderr_total_bytes: 16,
                output_limit_bytes: 16384,
            },
        });

        const nextPlan = await approveAction(createShellPlan(), "shell-1", "workspace");
        const action = nextPlan.proposedActions[0];

        expect(action.status).toBe("failed");
        expect(action.executionResult?.message).toBe("meaningful stderr");
        expect(action.executionResult?.metadata).toMatchObject({
            command: "npm test",
            stdout: "stdout text",
            stderr: "meaningful stderr",
            status: 2,
            timedOut: false,
            executor: "human_reviewer",
        });
        expect(nextPlan.activeStepId).toBeUndefined();
        expect(nextPlan.steps[0].status).toBe("failed");
        expect(nextPlan.steps[0].note).toContain("meaningful stderr");
    });

    it("records remembered workspace-rule approvals in execution metadata", async () => {
        vi.mocked(awaitShellCommandWithDeadline).mockResolvedValue({
            moved_to_background: false,
            result: {
                success: true,
                command: "npm test",
                timed_out: false,
                status: 0,
                stdout: "passed",
                stderr: "",
                cancelled: false,
                stdout_truncated: false,
                stderr_truncated: false,
                stdout_total_bytes: 6,
                stderr_total_bytes: 0,
                output_limit_bytes: 16384,
            },
        });

        const nextPlan = await approveAction(
            createShellPlan(),
            "shell-1",
            "workspace",
            {
                approvalMode: "remember_workspace_rule",
                approvalRuleLabel: "npm xxx",
                approvalRuleKind: "shell_command_prefix",
            },
        );

        expect(nextPlan.proposedActions[0]?.executionResult?.metadata).toMatchObject({
            approvalMode: "remember_workspace_rule",
            approvalRuleLabel: "npm xxx",
            approvalRuleKind: "shell_command_prefix",
        });
    });

    it("records workspace team yolo approvals in execution metadata", async () => {
        vi.mocked(awaitShellCommandWithDeadline).mockResolvedValue({
            moved_to_background: false,
            result: {
                success: true,
                command: "npm test",
                timed_out: false,
                status: 0,
                stdout: "passed",
                stderr: "",
                cancelled: false,
                stdout_truncated: false,
                stderr_truncated: false,
                stdout_total_bytes: 6,
                stderr_total_bytes: 0,
                output_limit_bytes: 16384,
            },
        });

        const nextPlan = await approveAction(
            createShellPlan(),
            "shell-1",
            "workspace",
            {
                approvalMode: "workspace_team_yolo",
            },
        );

        expect(nextPlan.proposedActions[0]?.executionResult?.metadata).toMatchObject({
            approvalMode: "workspace_team_yolo",
            approvalRuleLabel: null,
            approvalRuleKind: null,
        });
    });

    it("approves only the requested action ids in batch mode", async () => {
        vi.mocked(awaitShellCommandWithDeadline)
            .mockResolvedValueOnce({
                moved_to_background: false,
                result: {
                    success: true,
                    command: "pnpm test team",
                    timed_out: false,
                    status: 0,
                    stdout: "team passed",
                    stderr: "",
                    cancelled: false,
                    stdout_truncated: false,
                    stderr_truncated: false,
                    stdout_total_bytes: 11,
                    stderr_total_bytes: 0,
                    output_limit_bytes: 16384,
                },
            });

        const nextPlan = await approveAllPendingActions(
            createMultiShellPlan(),
            "workspace",
            {
                actionIds: ["shell-team"],
                approvalContext: {
                    approvalMode: "workspace_team_yolo",
                },
            },
        );

        expect(nextPlan.proposedActions.find((action) => action.id === "shell-team")).toMatchObject({
            status: "completed",
            executed: true,
            executionResult: {
                metadata: {
                    approvalMode: "workspace_team_yolo",
                },
            },
        });
        expect(nextPlan.proposedActions.find((action) => action.id === "shell-manual")).toMatchObject({
            status: "pending",
            executed: false,
        });
        expect(awaitShellCommandWithDeadline).toHaveBeenCalledTimes(1);
    });

    it("creates a fresh pending shell action identity for retry", () => {
        const failedPlan: OrchestrationPlan = {
            ...createShellPlan(),
            proposedActions: [
                {
                    ...createShellPlan().proposedActions[0],
                    status: "failed",
                    executionResult: {
                        success: false,
                        message: "boom",
                        timestamp: "2026-03-08T00:00:00.000Z",
                    },
                },
            ],
        };

        const retriedPlan = retryFailedShellAction(failedPlan, "shell-1");
        const retriedAction = retriedPlan.proposedActions[0];

        expect(retriedAction.id).not.toBe("shell-1");
        expect(retriedAction.status).toBe("pending");
        expect(retriedAction.executed).toBe(false);
        expect(retriedAction.executionResult).toBeUndefined();
        expect(retriedPlan.activeStepId).toBe("step-shell");
        expect(retriedPlan.steps[0].status).toBe("in_progress");
        expect(retriedPlan.steps[0].note).toContain("已重新创建重试动作");
        expect(retriedAction.type).toBe("shell");
        if (retriedAction.type === "shell") {
            expect(retriedAction.payload.retryFromActionId).toBe("shell-1");
            expect(retriedAction.payload.retryAttempt).toBe(1);
        }
    });

    it("treats manual retry attempts as a new continuation execution", () => {
        const failedOriginalPlan: OrchestrationPlan = {
            ...createShellPlan(),
            proposedActions: [
                {
                    ...createShellPlan().proposedActions[0],
                    status: "failed",
                    executed: false,
                    executionResult: {
                        success: false,
                        message: "first failure",
                        timestamp: "2026-03-08T00:00:00.000Z",
                    },
                },
            ],
        };

        const firstDecision = decideHitlContinuation({
            plan: failedOriginalPlan,
        });
        expect(firstDecision.kind).toBe("continue");

        const retriedPlan = retryFailedShellAction(failedOriginalPlan, "shell-1");
        const retriedAction = retriedPlan.proposedActions[0];
        const failedRetryPlan: OrchestrationPlan = {
            ...retriedPlan,
            proposedActions: [
                {
                    ...retriedAction,
                    status: "failed",
                    executed: false,
                    executionResult: {
                        success: false,
                        message: "second failure",
                        timestamp: "2026-03-08T00:01:00.000Z",
                    },
                },
            ],
        };

        const secondDecision = decideHitlContinuation({
            plan: failedRetryPlan,
            memory: firstDecision.memory,
        });

        expect(secondDecision.kind).toBe("continue");
    });
});
