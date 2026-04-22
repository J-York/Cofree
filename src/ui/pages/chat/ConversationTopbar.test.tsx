import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ConversationTopbarState } from "./conversationTopbarState";
import { ConversationTopbar } from "./ConversationTopbar";

type TestElementProps = {
  className?: string;
  children?: ReactNode;
  "data-conversation-topbar-row"?: string;
  "data-conversation-topbar-segment"?: string;
  "aria-live"?: string;
  "aria-label"?: string;
  onClick?: () => void;
};

function propsOf(el: ReactElement): TestElementProps {
  return el.props as TestElementProps;
}

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

function hasClassName(el: ReactElement, part: string): boolean {
  const cn = propsOf(el).className;
  return typeof cn === "string" && cn.split(/\s+/).includes(part);
}

function baseState(over: Partial<ConversationTopbarState> = {}): ConversationTopbarState {
  return {
    mode: "idle",
    source: "idle",
    primaryLabel: "已就绪",
    agentLabel: "测试 Agent",
    badges: [],
    progress: { visible: false },
    attention: null,
    ...over,
  };
}

describe("ConversationTopbar", () => {
  it("row 1 always renders primary label and badge region", () => {
    const tree = ConversationTopbar({
      state: baseState({
        agentLabel: "编排 Agent",
        primaryLabel: "当前：实现",
        badges: [{ key: "tools", label: "工具 2", action: "tools" }],
      }),
    });
    const elements = collectElements(tree);
    const rows = elements.filter((el) => hasClassName(el, "conversation-topbar-row"));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(collectText(tree)).toContain("当前：实现");
    expect(collectText(tree)).toContain("工具 2");
  });

  it("renders row 2 only when progress.visible is true", () => {
    const hidden = ConversationTopbar({
      state: baseState({ progress: { visible: false } }),
    });
    expect(collectElements(hidden).some((el) => hasClassName(el, "conversation-topbar-progress"))).toBe(
      false,
    );

    const shown = ConversationTopbar({
      state: baseState({
        progress: { visible: true, label: "3/5", current: 3, total: 5 },
      }),
    });
    expect(collectElements(shown).some((el) => hasClassName(el, "conversation-topbar-progress"))).toBe(
      true,
    );
    expect(collectText(shown)).toContain("3/5");
  });

  it("renders attention toast only when attention is non-null", () => {
    const none = ConversationTopbar({ state: baseState({ attention: null }) });
    expect(collectElements(none).some((el) => hasClassName(el, "conversation-topbar-attention-toast"))).toBe(
      false,
    );

    const withAttention = ConversationTopbar({
      state: baseState({
        attention: {
          visible: true,
          level: "info",
          message: "提示信息",
        },
      }),
    });
    expect(
      collectElements(withAttention).some((el) => hasClassName(el, "conversation-topbar-attention-toast")),
    ).toBe(true);
    expect(collectText(withAttention)).toContain("提示信息");
  });

  it("approval attention uses row 3 CTA and does not repeat approval count in row 1 badges", () => {
    const approvalMsg = "提醒：有 2 个动作待你审批";
    const onAction = vi.fn();
    const tree = ConversationTopbar({
      state: baseState({
        badges: [{ key: "tools", label: "工具 1", action: "tools" }],
        attention: {
          visible: true,
          level: "warning",
          message: approvalMsg,
          ctaLabel: "查看待审批",
          ctaAction: "approval",
        },
      }),
      onAction,
    });
    const elements = collectElements(tree);
    const row1 = elements.find((el) => propsOf(el)["data-conversation-topbar-row"] === "1");
    expect(row1).toBeDefined();
    const row1Badges = collectElements(row1).filter((el) => hasClassName(el, "conversation-topbar-badge"));
    expect(row1Badges.map((b) => collectText(b))).toEqual(["工具 1"]);
    expect(collectText(row1)).not.toContain("待你审批");
    expect(collectText(tree)).toContain(approvalMsg);
    expect(collectText(tree)).toContain("查看待审批");
    const approvalCta = elements.find(
      (el) => el.type === "button" && collectText(propsOf(el).children) === "查看待审批",
    ) as ReactElement<{ onClick?: () => void }> | undefined;
    approvalCta?.props.onClick?.();
    expect(onAction).toHaveBeenCalledWith("approval");
  });

  it("invokes onAction for badge actions tools, context, and ask_user", () => {
    const onAction = vi.fn();
    const tree = ConversationTopbar({
      state: baseState({
        badges: [
          { key: "tools", label: "工具 2", action: "tools" },
          { key: "ctx", label: "上下文 62%", action: "context" },
          { key: "ask", label: "等待输入", action: "ask_user" },
        ],
      }),
      onAction,
    });
    const buttons = collectElements(tree).filter((el) => el.type === "button") as Array<
      ReactElement<{ onClick?: () => void; children?: ReactNode }>
    >;
    const byLabel = (label: string) =>
      buttons.find((b) => collectText(b.props.children).includes(label));
    byLabel("工具 2")?.props.onClick?.();
    byLabel("上下文 62%")?.props.onClick?.();
    byLabel("等待输入")?.props.onClick?.();
    expect(onAction).toHaveBeenNthCalledWith(1, "tools");
    expect(onAction).toHaveBeenNthCalledWith(2, "context");
    expect(onAction).toHaveBeenNthCalledWith(3, "ask_user");
  });

  it("invokes onAction for attention CTA restore and blocked_output", () => {
    const onAction = vi.fn();
    const restoreTree = ConversationTopbar({
      state: baseState({
        attention: {
          visible: true,
          level: "info",
          message: "已恢复到上次进度",
          ctaLabel: "知道了",
          ctaAction: "restore",
        },
      }),
      onAction,
    });
    const blockedTree = ConversationTopbar({
      state: baseState({
        attention: {
          visible: true,
          level: "blocked",
          message: "阻塞：步骤失败",
          ctaLabel: "查看失败输出",
          ctaAction: "blocked_output",
        },
      }),
      onAction,
    });
    const restoreBtn = collectElements(restoreTree).find(
      (el) => el.type === "button" && collectText(propsOf(el).children) === "知道了",
    ) as ReactElement<{ onClick?: () => void }> | undefined;
    const blockedBtn = collectElements(blockedTree).find(
      (el) => el.type === "button" && collectText(propsOf(el).children) === "查看失败输出",
    ) as ReactElement<{ onClick?: () => void }> | undefined;
    restoreBtn?.props.onClick?.();
    blockedBtn?.props.onClick?.();
    expect(onAction).toHaveBeenNthCalledWith(1, "restore");
    expect(onAction).toHaveBeenNthCalledWith(2, "blocked_output");
  });

  it("clicking progress row and progress track invokes onAction with progress", () => {
    const onAction = vi.fn();
    const tree = ConversationTopbar({
      state: baseState({
        progress: {
          visible: true,
          label: "2/4",
          current: 2,
          total: 4,
          segments: ["completed", "active", "pending", "blocked"],
        },
      }),
      onAction,
    });
    const elements = collectElements(tree);
    const progressRow = elements.find((el) => hasClassName(el, "conversation-topbar-progress"));
    const track = elements.find((el) => hasClassName(el, "conversation-topbar-track"));
    expect(progressRow).toBeDefined();
    expect(propsOf(progressRow!)["aria-label"]).toBe("查看进度，跳转至进度详情");
    expect(track).toBeDefined();
    (progressRow as ReactElement<{ onClick?: () => void }>).props.onClick?.();
    (track as ReactElement<{ onClick?: () => void }>).props.onClick?.();
    expect(onAction).toHaveBeenCalledTimes(2);
    expect(onAction).toHaveBeenNthCalledWith(1, "progress");
    expect(onAction).toHaveBeenNthCalledWith(2, "progress");
  });

  it("progress row exposes a stable aria-label for opening progress details", () => {
    const minimal = ConversationTopbar({
      state: baseState({ progress: { visible: true } }),
    });
    const withLabel = ConversationTopbar({
      state: baseState({
        progress: { visible: true, label: "3/5", segments: ["completed", "active"] },
      }),
    });
    for (const tree of [minimal, withLabel]) {
      const row = collectElements(tree).find((el) => hasClassName(el, "conversation-topbar-progress"));
      expect(row).toBeDefined();
      expect(propsOf(row!)["aria-label"]).toBe("查看进度，跳转至进度详情");
    }
  });

  it("renders progress segments in order including blocked", () => {
    const tree = ConversationTopbar({
      state: baseState({
        mode: "single_agent",
        source: "tools",
        primaryLabel: "当前：测试",
        progress: {
          visible: true,
          label: "2/4",
          segments: ["completed", "active", "pending", "blocked"],
        },
      }),
    });
    const segs = collectElements(tree).filter(
      (el) => propsOf(el)["data-conversation-topbar-segment"] != null,
    );
    expect(segs.map((s) => propsOf(s)["data-conversation-topbar-segment"])).toEqual([
      "completed",
      "active",
      "pending",
      "blocked",
    ]);
  });

  it("primary summary lives in an aria-live polite region", () => {
    const tree = ConversationTopbar({ state: baseState({ primaryLabel: "正在回答" }) });
    const live = collectElements(tree).find(
      (el) => propsOf(el)["aria-live"] === "polite" && collectText(el).includes("正在回答"),
    );
    expect(live).toBeDefined();
  });

  it("attention row uses a separate aria-live polite announcement path from primary", () => {
    const tree = ConversationTopbar({
      state: baseState({
        primaryLabel: "当前：阶段 A",
        attention: {
          visible: true,
          level: "warning",
          message: "需要留意",
        },
      }),
    });
    const polite = collectElements(tree).filter((el) => propsOf(el)["aria-live"] === "polite");
    expect(polite.length).toBeGreaterThanOrEqual(2);
    const primaryLive = polite.find((el) => collectText(el).includes("当前：阶段 A"));
    const attentionLive = polite.find((el) => collectText(el).includes("需要留意"));
    expect(primaryLive).toBeDefined();
    expect(attentionLive).toBeDefined();
    expect(primaryLive).not.toBe(attentionLive);
  });

  it("warning and blocked attention expose visible level labels, not color alone", () => {
    const warnTree = ConversationTopbar({
      state: baseState({
        attention: { visible: true, level: "warning", message: "稍等" },
      }),
    });
    const blockedTree = ConversationTopbar({
      state: baseState({
        attention: { visible: true, level: "blocked", message: "失败" },
      }),
    });
    expect(collectText(warnTree)).toContain("警告");
    expect(collectText(blockedTree)).toContain("阻塞");
  });

  it("completion-style state shows completion affordances without running-style badges", () => {
    const tree = ConversationTopbar({
      state: baseState({
        mode: "single_agent",
        source: "assistant",
        primaryLabel: "本轮编排已完成",
        badges: [{ key: "completion", label: "6/6", tone: "success" }],
        progress: {
          visible: true,
          label: "6/6",
          current: 6,
          total: 6,
          segments: ["completed", "completed", "completed", "completed", "completed", "completed"],
        },
        attention: null,
      }),
    });
    const text = collectText(tree);
    expect(text).toContain("6/6");
    expect(text).not.toContain("工具");
    expect(text).not.toContain("并行");
  });
});
