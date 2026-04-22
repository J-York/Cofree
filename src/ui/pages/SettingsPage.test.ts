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
  resolveSelectedVendorId,
} from "./SettingsPage";

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
