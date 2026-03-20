import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { UpdateBanner } from "./UpdateBanner";

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

function renderBanner(
  overrides: Partial<Parameters<typeof UpdateBanner>[0]> = {},
): ReactElement | null {
  return UpdateBanner({
    visible: true,
    status: "error",
    version: "",
    body: "",
    progress: 0,
    error: "自动更新签名校验失败，请联系开发者检查发布签名或更新公钥。",
    errorAction: "check",
    onInstall: vi.fn(),
    onRetry: vi.fn(),
    onDismiss: vi.fn(),
    ...overrides,
  });
}

describe("UpdateBanner", () => {
  it("shows retry-check copy for updater check failures without a pending version", () => {
    const tree = renderBanner();
    const elements = collectElements(tree);

    const message = elements.find(
      (element) => (element.props as { className?: string }).className === "update-banner-text",
    ) as ReactElement<{ children?: ReactNode }>;
    const primaryButton = elements.find(
      (element) => (element.props as { className?: string }).className?.includes("update-banner-action"),
    ) as ReactElement<{ children?: ReactNode }>;

    expect(collectText(message.props.children)).toBe(
      "自动更新检查失败：自动更新签名校验失败，请联系开发者检查发布签名或更新公钥。",
    );
    expect(collectText(primaryButton.props.children)).toBe("重新检查");
  });

  it("keeps install retries tied to the pending version", () => {
    const tree = renderBanner({
      version: "0.1.0",
      error: "更新包已下载，但安装失败。请关闭应用后手动安装，或稍后重试。",
      errorAction: "install",
    });
    const elements = collectElements(tree);

    const message = elements.find(
      (element) => (element.props as { className?: string }).className === "update-banner-text",
    ) as ReactElement<{ children?: ReactNode }>;
    const primaryButton = elements.find(
      (element) => (element.props as { className?: string }).className?.includes("update-banner-action"),
    ) as ReactElement<{ children?: ReactNode }>;

    expect(collectText(message.props.children)).toBe(
      "v0.1.0 更新失败：更新包已下载，但安装失败。请关闭应用后手动安装，或稍后重试。",
    );
    expect(collectText(primaryButton.props.children)).toBe("重试更新");
  });

  it("keeps the install CTA for available updates", () => {
    const tree = renderBanner({
      status: "available",
      version: "0.1.0",
      error: "",
      errorAction: null,
    });
    const elements = collectElements(tree);

    const message = elements.find(
      (element) => (element.props as { className?: string }).className === "update-banner-text",
    ) as ReactElement<{ children?: ReactNode }>;
    const primaryButton = elements.find(
      (element) => (element.props as { className?: string }).className?.includes("update-banner-action"),
    ) as ReactElement<{ children?: ReactNode }>;

    expect(collectText(message.props.children)).toBe("新版本 v0.1.0 已发布");
    expect(collectText(primaryButton.props.children)).toBe("立即更新");
  });
});
