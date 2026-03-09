import { describe, expect, it } from "vitest";
import type { ChatMessageRecord } from "../../../lib/chatHistoryStore";
import { buildToolCallsFromPlan, toConversationHistory } from "./helpers";

describe("chat helpers tool-call preservation", () => {
    it("keeps assistant messages that only contain tool_calls in conversation history", () => {
        const records: ChatMessageRecord[] = [
            {
                id: "assistant-1",
                role: "assistant",
                content: "",
                createdAt: "2026-03-08T00:00:00.000Z",
                plan: null,
                tool_calls: [
                    {
                        id: "toolu_1",
                        type: "function",
                        function: {
                            name: "read_file",
                            arguments: JSON.stringify({ relative_path: "src/App.tsx" }),
                        },
                    },
                ],
            },
        ];

        expect(toConversationHistory(records)).toEqual([
            {
                role: "assistant",
                content: "",
                tool_calls: [
                    {
                        id: "toolu_1",
                        type: "function",
                        function: {
                            name: "read_file",
                            arguments: JSON.stringify({ relative_path: "src/App.tsx" }),
                        },
                    },
                ],
            },
        ]);
    });

    it("appends context attachment manifests to user history messages", () => {
        const records: ChatMessageRecord[] = [
            {
                id: "user-1",
                role: "user",
                content: "请帮我看一下",
                createdAt: "2026-03-08T00:00:00.000Z",
                plan: null,
                contextAttachments: [
                    {
                        id: "ctx-1",
                        kind: "file",
                        source: "mention",
                        relativePath: "src/App.tsx",
                        displayName: "App.tsx",
                        addedAt: "2026-03-08T00:00:00.000Z",
                    },
                ],
            },
        ];

        expect(toConversationHistory(records)).toEqual([
            {
                role: "user",
                content: "请帮我看一下\n\n[用户显式附加的上下文路径]\n- [文件] src/App.tsx",
            },
        ]);
    });

    it("builds assistant-visible tool call records from proposed actions", () => {
        expect(
            buildToolCallsFromPlan({
                state: "human_review",
                prompt: "test",
                workspacePath: "d:/Code/cofree",
                steps: [],
                proposedActions: [
                    {
                        id: "action-1",
                        type: "shell",
                        description: "Run tests",
                        gateRequired: true,
                        status: "pending",
                        executed: false,
                        toolName: "propose_shell",
                        toolCallId: "call-1",
                        payload: {
                            shell: "npm test",
                            timeoutMs: 120000,
                        },
                    },
                ],
            }),
        ).toEqual([
            {
                id: "call-1",
                type: "function",
                function: {
                    name: "propose_shell",
                    arguments: JSON.stringify({ shell: "npm test", timeoutMs: 120000 }),
                },
            },
        ]);
    });
});
