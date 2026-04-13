import { describe, expect, it } from "vitest";

import type { OrchestrationPlan, ActionProposal } from "../../../orchestrator/types";
import type { WorkspaceTeamTrustMode } from "../../../lib/workspaceTeamTrustStore";
import {
  buildWorkspaceTeamTrustPromptKey,
  collectAllPendingYoloActionIds,
  collectPendingExpertTeamActionIds,
  collectPendingOrchestrationActionIds,
  getWorkspaceTeamTrustModeLabel,
  isExpertTeamAction,
  isOrchestrationAction,
  parseTeamIdFromOriginDetail,
  resolveWorkspaceTeamTrustDecision,
  resolveWorkspaceTeamTrustMessageAction,
  shouldOpenWorkspaceTeamTrustPrompt,
} from "./teamTrust";

function createShellAction(
  id: string,
  overrides: Partial<Extract<ActionProposal, { type: "shell" }>> = {},
): Extract<ActionProposal, { type: "shell" }> {
  return {
    id,
    type: "shell",
    description: `Run shell ${id}`,
    gateRequired: true,
    status: "pending",
    executed: false,
    payload: {
      shell: "pnpm test",
      timeoutMs: 30_000,
    },
    ...overrides,
  };
}

function createPatchAction(
  id: string,
  overrides: Partial<Extract<ActionProposal, { type: "apply_patch" }>> = {},
): Extract<ActionProposal, { type: "apply_patch" }> {
  return {
    id,
    type: "apply_patch",
    description: `Apply patch ${id}`,
    gateRequired: true,
    status: "pending",
    executed: false,
    payload: {
      patch: [
        "diff --git a/src/App.tsx b/src/App.tsx",
        "--- a/src/App.tsx",
        "+++ b/src/App.tsx",
        "@@ -1,1 +1,1 @@",
        "-old",
        "+new",
      ].join("\n"),
    },
    ...overrides,
  };
}

function createPlan(
  actions: ActionProposal[],
  workspacePath = "/repo/cofree",
): OrchestrationPlan {
  return {
    state: "human_review",
    prompt: "test team trust",
    steps: [],
    proposedActions: actions,
    workspacePath,
  };
}

function resolveDecision(
  mode: WorkspaceTeamTrustMode | null,
  actions: ActionProposal[],
  workspacePath = "/repo/cofree",
) {
  return resolveWorkspaceTeamTrustDecision({
    workspacePath,
    mode,
    plan: createPlan(actions, workspacePath),
  });
}

describe("teamTrust", () => {
  it("parses a stable team id from originDetail", () => {
    expect(parseTeamIdFromOriginDetail("team-build / 代码实现")).toBe(
      "team-build",
    );
    expect(parseTeamIdFromOriginDetail("team-build")).toBe(
      "team-build",
    );
  });

  it("treats malformed or missing originDetail as non-team", () => {
    expect(parseTeamIdFromOriginDetail("")).toBeNull();
    expect(parseTeamIdFromOriginDetail("   ")).toBeNull();
    expect(parseTeamIdFromOriginDetail(undefined)).toBeNull();

    expect(
      isExpertTeamAction(
        createShellAction("shell-missing-origin", {
          origin: "team_stage",
        }),
      ),
    ).toBe(false);
  });

  it("requires a team_stage origin with a team-* id", () => {
    expect(
      isExpertTeamAction(
        createShellAction("team-shell", {
          origin: "team_stage",
          originDetail: "team-build / 代码实现",
        }),
      ),
    ).toBe(true);

    expect(
      isExpertTeamAction(
        createShellAction("non-team-shell", {
          origin: "team_stage",
          originDetail: "reviewer / 代码实现",
        }),
      ),
    ).toBe(false);

    expect(
      isExpertTeamAction(
        createShellAction("subagent-shell", {
          origin: "sub_agent",
          originDetail: "team-build / 代码实现",
        }),
      ),
    ).toBe(false);
  });

  it("collects only pending expert-team action ids", () => {
    const teamShell = createShellAction("team-shell", {
      origin: "team_stage",
      originDetail: "team-build / 执行命令",
    });
    const teamPatch = createPatchAction("team-patch", {
      origin: "team_stage",
      originDetail: "team-build / 修改文件",
      status: "completed",
      executed: true,
    });
    const nonTeamShell = createShellAction("non-team-shell", {
      origin: "main_agent",
    });

    expect(
      collectPendingExpertTeamActionIds(createPlan([teamShell, teamPatch, nonTeamShell])),
    ).toEqual(["team-shell"]);
  });

  it("prompts on the first pending expert-team action when the workspace has no saved mode", () => {
    const teamShell = createShellAction("team-shell", {
      origin: "team_stage",
      originDetail: "team-build / 执行命令",
    });

    expect(resolveDecision(null, [teamShell])).toMatchObject({
      kind: "prompt_first_run",
      teamActionIds: ["team-shell"],
    });
  });

  it("uses yolo for all pending gated shell/patch after team_yolo when orchestration is present", () => {
    const teamShell = createShellAction("team-shell", {
      origin: "team_stage",
      originDetail: "team-build / 执行命令",
    });
    const nonTeamShell = createShellAction("non-team-shell", {
      origin: "main_agent",
    });

    expect(resolveDecision("team_yolo", [teamShell, nonTeamShell])).toMatchObject({
      kind: "yolo",
      teamActionIds: ["team-shell", "non-team-shell"],
    });
  });

  it("treats sub_agent shell as orchestration", () => {
    expect(
      isOrchestrationAction(
        createShellAction("sub-s", { origin: "sub_agent", originDetail: "coder" }),
      ),
    ).toBe(true);
  });

  it("prompts first run when only sub_agent orchestration actions exist", () => {
    const subShell = createShellAction("sub-s", {
      origin: "sub_agent",
      originDetail: "coder",
    });
    expect(resolveDecision(null, [subShell])).toMatchObject({
      kind: "prompt_first_run",
      teamActionIds: ["sub-s"],
    });
  });

  it("collectPendingOrchestrationActionIds includes team_stage and sub_agent", () => {
    const teamShell = createShellAction("a", {
      origin: "team_stage",
      originDetail: "team-build / 执行",
    });
    const subShell = createShellAction("b", { origin: "sub_agent", originDetail: "coder" });
    const mainShell = createShellAction("c", { origin: "main_agent" });
    expect(collectPendingOrchestrationActionIds(createPlan([teamShell, subShell, mainShell]))).toEqual([
      "a",
      "b",
    ]);
  });

  it("collectAllPendingYoloActionIds includes main_agent pending actions", () => {
    const teamShell = createShellAction("a", {
      origin: "team_stage",
      originDetail: "team-build / 执行",
    });
    const mainShell = createShellAction("b", { origin: "main_agent" });
    expect(collectAllPendingYoloActionIds(createPlan([teamShell, mainShell]))).toEqual(["a", "b"]);
  });

  it("prompt_first_run returns all pending yolo ids when mixing team_stage and main_agent", () => {
    const teamShell = createShellAction("team-shell", {
      origin: "team_stage",
      originDetail: "team-build / 执行命令",
    });
    const mainShell = createShellAction("main-shell", { origin: "main_agent" });

    expect(resolveDecision(null, [teamShell, mainShell])).toMatchObject({
      kind: "prompt_first_run",
      teamActionIds: ["team-shell", "main-shell"],
    });
  });

  it("uses manual mode for saved team_manual decisions without re-prompting", () => {
    const teamPatch = createPatchAction("team-patch", {
      origin: "team_stage",
      originDetail: "team-build / 修改文件",
    });

    expect(resolveDecision("team_manual", [teamPatch])).toMatchObject({
      kind: "manual",
      teamActionIds: ["team-patch"],
    });
  });

  it("falls back to manual when there is no workspace path", () => {
    const teamShell = createShellAction("team-shell", {
      origin: "team_stage",
      originDetail: "team-build / 执行命令",
    });

    expect(resolveDecision(null, [teamShell], "")).toMatchObject({
      kind: "disabled_no_workspace",
      teamActionIds: ["team-shell"],
    });
  });

  it("keeps non-team actions on the existing manual path", () => {
    const nonTeamShell = createShellAction("non-team-shell", {
      origin: "main_agent",
    });

    expect(resolveDecision(null, [nonTeamShell])).toMatchObject({
      kind: "manual",
      teamActionIds: [],
    });
  });

  it("formats the workspace trust label for settings", () => {
    expect(getWorkspaceTeamTrustModeLabel("team_yolo")).toBe("YOLO");
    expect(getWorkspaceTeamTrustModeLabel("team_manual")).toBe("审批");
    expect(getWorkspaceTeamTrustModeLabel(null)).toBe("未设置（首次进入编排时询问）");
  });

  it("opens the first-run reminder only once per workspace while it is already in flight", () => {
    const teamShell = createShellAction("team-shell", {
      origin: "team_stage",
      originDetail: "team-build / 执行命令",
    });
    const decision = resolveDecision(null, [teamShell]);
    const promptKey = buildWorkspaceTeamTrustPromptKey("/repo/cofree");

    expect(
      shouldOpenWorkspaceTeamTrustPrompt({
        decision,
        workspacePath: "/repo/cofree",
        activePromptKey: null,
        restoredPromptKey: null,
      }),
    ).toBe(true);
    expect(
      shouldOpenWorkspaceTeamTrustPrompt({
        decision,
        workspacePath: "/repo/cofree",
        activePromptKey: promptKey,
        restoredPromptKey: null,
      }),
    ).toBe(false);
  });

  it("does not reopen the first-run reminder when checkpoint restore already tracks that workspace", () => {
    const teamShell = createShellAction("team-shell", {
      origin: "team_stage",
      originDetail: "team-build / 执行命令",
    });
    const decision = resolveDecision(null, [teamShell]);
    const promptKey = buildWorkspaceTeamTrustPromptKey("/repo/cofree");

    expect(
      shouldOpenWorkspaceTeamTrustPrompt({
        decision,
        workspacePath: "/repo/cofree",
        activePromptKey: null,
        restoredPromptKey: promptKey,
      }),
    ).toBe(false);
  });

  it("resolves a prompt action from the latest message when first-run trust is still unset", () => {
    const teamShell = createShellAction("team-shell", {
      origin: "team_stage",
      originDetail: "team-build / 执行命令",
    });

    expect(
      resolveWorkspaceTeamTrustMessageAction({
        message: {
          id: "assistant-1",
          plan: createPlan([teamShell]),
        },
        workspacePath: "/repo/cofree",
        mode: null,
        activePromptKey: null,
        restoredPromptKey: null,
      }),
    ).toMatchObject({
      kind: "prompt",
      messageId: "assistant-1",
      teamActionIds: ["team-shell"],
      promptKey: buildWorkspaceTeamTrustPromptKey("/repo/cofree"),
    });
  });

  it("resolves yolo with all pending gated shell/patch for auto-approve", () => {
    const teamShell = createShellAction("team-shell", {
      origin: "team_stage",
      originDetail: "team-build / 执行命令",
    });
    const nonTeamShell = createShellAction("non-team-shell", {
      origin: "main_agent",
    });

    expect(
      resolveWorkspaceTeamTrustMessageAction({
        message: {
          id: "assistant-2",
          plan: createPlan([teamShell, nonTeamShell]),
        },
        workspacePath: "/repo/cofree",
        mode: "team_yolo",
        activePromptKey: null,
        restoredPromptKey: null,
      }),
    ).toMatchObject({
      kind: "yolo",
      messageId: "assistant-2",
      teamActionIds: ["team-shell", "non-team-shell"],
    });
  });
});
