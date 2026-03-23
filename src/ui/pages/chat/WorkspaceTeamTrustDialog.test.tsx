import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { WorkspaceTeamTrustDialog } from "./WorkspaceTeamTrustDialog";

function collectElements(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) {
    return node.flatMap(collectElements);
  }

  if (!node || typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
    return [];
  }

  const element = node as ReactElement<{ children?: ReactNode }>;
  return [element, ...collectElements(element.props.children)];
}

function collectText(node: ReactNode): string {
  if (Array.isArray(node)) {
    return node.map(collectText).join("");
  }

  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }

  if (!node || typeof node === "boolean") {
    return "";
  }

  const element = node as ReactElement<{ children?: ReactNode }>;
  return collectText(element.props.children);
}

describe("WorkspaceTeamTrustDialog", () => {
  it("returns null when closed", () => {
    expect(
      WorkspaceTeamTrustDialog({
        open: false,
        onChooseMode: vi.fn(),
      }),
    ).toBeNull();
  });

  it("renders the first-run workspace trust copy and only the two persistent choices", () => {
    const tree = WorkspaceTeamTrustDialog({
      open: true,
      onChooseMode: vi.fn(),
    });
    const elements = collectElements(tree);
    const buttons = elements.filter((element) => element.type === "button") as Array<
      ReactElement<{ children?: ReactNode }>
    >;

    expect(collectText(tree)).toContain("当前工作区首次使用专家团");
    expect(collectText(tree)).toContain(
      "专家团 YOLO 模式会在此工作区自动执行专家团 shell 与文件修改动作",
    );
    expect(collectText(tree)).toContain("普通单 Agent 对话仍保持原有审批行为");
    expect(buttons).toHaveLength(2);
    expect(buttons.map((button) => collectText(button.props.children))).toEqual([
      "启用该工作区专家团 YOLO",
      "继续使用审批模式",
    ]);
  });

  it("emits the persisted trust mode for each explicit choice", () => {
    const onChooseMode = vi.fn();
    const tree = WorkspaceTeamTrustDialog({
      open: true,
      onChooseMode,
    });
    const buttons = collectElements(tree).filter((element) => element.type === "button") as Array<
      ReactElement<{ onClick: () => void }>
    >;

    buttons[0]?.props.onClick();
    buttons[1]?.props.onClick();

    expect(onChooseMode).toHaveBeenNthCalledWith(1, "team_yolo");
    expect(onChooseMode).toHaveBeenNthCalledWith(2, "team_manual");
  });
});
