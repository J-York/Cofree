import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ManagedModel } from "../../lib/settingsStore";
import { VendorModelRow } from "./VendorModelRow";

const BASE_MODEL: ManagedModel = {
  id: "model-1",
  vendorId: "vendor-1",
  name: "claude-sonnet-4-5",
  source: "manual",
  supportsThinking: true,
  thinkingLevel: "medium",
  metaSettings: {
    contextWindowTokens: 0,
    maxOutputTokens: 0,
    temperature: null,
    topP: null,
    frequencyPenalty: null,
    presencePenalty: null,
    seed: null,
  },
  createdAt: "2026-03-07T00:00:00.000Z",
  updatedAt: "2026-03-07T00:00:00.000Z",
};

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

function renderRow(model: ManagedModel, overrides?: Partial<Parameters<typeof VendorModelRow>[0]>) {
  return VendorModelRow({
    model,
    isEditing: false,
    editingName: "",
    confirmDelete: false,
    canDelete: true,
    onStartEdit: vi.fn(),
    onEditChange: vi.fn(),
    onSaveEdit: vi.fn(),
    onCancelEdit: vi.fn(),
    onConfirmDelete: vi.fn(),
    onDelete: vi.fn(),
    onCancelDelete: vi.fn(),
    onThinkingSupportChange: vi.fn(),
    onThinkingLevelChange: vi.fn(),
    onOpenMetaSettings: vi.fn(),
    ...overrides,
  });
}

describe("VendorModelRow", () => {
  it("renders thinking controls with the current model settings", () => {
    const tree = renderRow(BASE_MODEL);
    const elements = collectElements(tree);

    const checkbox = elements.find(
      (element) => element.type === "input" && (element.props as { type?: string }).type === "checkbox",
    ) as ReactElement<{ checked: boolean }>;
    const select = elements.find(
      (element) => element.type === "select",
    ) as ReactElement<{ value: string; disabled?: boolean }>;

    expect(checkbox.props.checked).toBe(true);
    expect(select.props.value).toBe("medium");
    expect(select.props.disabled).toBe(false);
  });

  it("disables the thinking level selector when the model is marked as non-thinking", () => {
    const tree = renderRow({ ...BASE_MODEL, supportsThinking: false });
    const elements = collectElements(tree);

    const select = elements.find(
      (element) => element.type === "select",
    ) as ReactElement<{ disabled?: boolean }>;

    expect(select.props.disabled).toBe(true);
  });

  it("forwards thinking changes through the supplied callbacks", () => {
    const onThinkingSupportChange = vi.fn();
    const onThinkingLevelChange = vi.fn();
    const tree = renderRow(BASE_MODEL, {
      onThinkingSupportChange,
      onThinkingLevelChange,
    });
    const elements = collectElements(tree);

    const checkbox = elements.find(
      (element) => element.type === "input" && (element.props as { type?: string }).type === "checkbox",
    ) as ReactElement<{ onChange: (event: { target: { checked: boolean } }) => void }>;
    const select = elements.find(
      (element) => element.type === "select",
    ) as ReactElement<{ onChange: (event: { target: { value: string } }) => void }>;

    checkbox.props.onChange({ target: { checked: false } });
    select.props.onChange({ target: { value: "high" } });

    expect(onThinkingSupportChange).toHaveBeenCalledWith(false);
    expect(onThinkingLevelChange).toHaveBeenCalledWith("high");
  });
});
