import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  createManagedModel,
  createVendor,
  setActiveVendorSelection,
  type AppSettings,
} from "../../lib/settingsStore";

vi.mock("../../hooks/useTheme", () => ({
  useTheme: () => ({
    theme: "dark",
    resolvedTheme: "dark",
    setTheme: vi.fn(),
  }),
  getThemeLabel: (mode: "dark" | "light" | "system") => mode,
}));

import {
  WorkspaceTeamTrustModeField,
  resolveSelectedVendorId,
} from "./SettingsPage";

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

function makeSettings(): AppSettings {
  const { settings, vendor } = createVendor(DEFAULT_SETTINGS, {
    name: "Second Vendor",
    protocol: "openai-chat-completions",
    baseUrl: "http://second-vendor:4000",
  });
  const secondModel = createManagedModel(vendor.id, "second-model", "manual");
  return {
    ...settings,
    managedModels: [...settings.managedModels, secondModel],
  };
}

describe("resolveSelectedVendorId", () => {
  it("keeps the current vendor selection after settings are saved", () => {
    const settings = makeSettings();
    const selectedVendorId = settings.vendors[1]?.id ?? null;

    expect(resolveSelectedVendorId(settings, selectedVendorId)).toBe(selectedVendorId);
  });

  it("falls back to the active vendor when the current selection no longer exists", () => {
    const settings = setActiveVendorSelection(makeSettings(), DEFAULT_SETTINGS.activeVendorId!);

    expect(resolveSelectedVendorId(settings, "vendor-deleted")).toBe(settings.activeVendorId);
  });
});

describe("WorkspaceTeamTrustModeField", () => {
  it("shows the unset workspace-scoped mode before first use", () => {
    const tree = WorkspaceTeamTrustModeField({
      workspacePath: "/repo/cofree",
      mode: null,
      onChange: vi.fn(),
    });
    const elements = collectElements(tree);
    const select = elements.find((element) => element.type === "select") as ReactElement<{
      value: string;
      disabled?: boolean;
    }>;

    expect(select.props.value).toBe("");
    expect(select.props.disabled).toBe(false);
    expect(collectText(tree)).toContain("编排执行模式");
    expect(collectText(tree)).toContain("未设置（首次进入编排时询问）");
  });

  it("shows the saved team_yolo mode and forwards changes", () => {
    const onChange = vi.fn();
    const tree = WorkspaceTeamTrustModeField({
      workspacePath: "/repo/cofree",
      mode: "team_yolo",
      onChange,
    });
    const elements = collectElements(tree);
    const select = elements.find((element) => element.type === "select") as ReactElement<{
      value: string;
      onChange: (event: { target: { value: string } }) => void;
    }>;

    expect(select.props.value).toBe("team_yolo");
    select.props.onChange({ target: { value: "team_manual" } });
    select.props.onChange({ target: { value: "" } });

    expect(onChange).toHaveBeenNthCalledWith(1, "team_manual");
    expect(onChange).toHaveBeenNthCalledWith(2, null);
  });

  it("disables the control when no workspace is selected", () => {
    const tree = WorkspaceTeamTrustModeField({
      workspacePath: "",
      mode: null,
      onChange: vi.fn(),
    });
    const elements = collectElements(tree);
    const select = elements.find((element) => element.type === "select") as ReactElement<{
      disabled?: boolean;
    }>;

    expect(select.props.disabled).toBe(true);
    expect(collectText(tree)).toContain("该设置按工作区存储；请先选择工作区。");
  });
});
