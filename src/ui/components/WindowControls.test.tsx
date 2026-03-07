import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import capability from "../../../src-tauri/capabilities/default.json";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WindowControls } from "./WindowControls";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(),
}));

type WindowControlButton = ReactElement<{
  onClick: () => void;
  "aria-label": string;
}>;

function getButtons(): WindowControlButton[] {
  const tree = WindowControls() as ReactElement<{ children: WindowControlButton | WindowControlButton[] }>;
  const { children } = tree.props;
  return Array.isArray(children) ? children : [children];
}

describe("WindowControls", () => {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

  beforeEach(() => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });

    vi.mocked(getCurrentWindow).mockReturnValue({
      minimize: vi.fn(async () => undefined),
      toggleMaximize: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    } as unknown as ReturnType<typeof getCurrentWindow>);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("invokes the expected Tauri window APIs for each button", () => {
    const [minimizeButton, maximizeButton, closeButton] = getButtons();
    const windowHandle = vi.mocked(getCurrentWindow).mock.results[0]?.value as {
      minimize: ReturnType<typeof vi.fn>;
      toggleMaximize: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    };

    minimizeButton.props.onClick();
    maximizeButton.props.onClick();
    closeButton.props.onClick();

    expect(windowHandle.minimize).toHaveBeenCalledOnce();
    expect(windowHandle.toggleMaximize).toHaveBeenCalledOnce();
    expect(windowHandle.close).toHaveBeenCalledOnce();
  });

  it("logs rejected window commands instead of failing silently", async () => {
    const failure = new Error("ACL denied");
    vi.mocked(getCurrentWindow).mockReturnValue({
      minimize: vi.fn(async () => undefined),
      toggleMaximize: vi.fn(async () => undefined),
      close: vi.fn(async () => {
        throw failure;
      }),
    } as unknown as ReturnType<typeof getCurrentWindow>);

    const [, , closeButton] = getButtons();
    closeButton.props.onClick();
    await Promise.resolve();

    expect(errorSpy).toHaveBeenCalledWith("[window-controls] Failed to close window:", failure);
  });

  it("requires the explicit window permissions used by the custom title bar", () => {
    const permissions = new Set(capability.permissions);

    expect(permissions.has("core:window:allow-close")).toBe(true);
    expect(permissions.has("core:window:allow-minimize")).toBe(true);
    expect(permissions.has("core:window:allow-toggle-maximize")).toBe(true);
  });
});
