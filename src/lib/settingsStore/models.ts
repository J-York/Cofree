import type {
  AppSettings,
  ManagedModel,
  ManagedModelMetaSettings,
  ManagedModelSource,
  ManagedModelThinkingLevel,
  VendorConfig,
  VendorProtocol,
} from "./general";
import {
  createManagedModel,
  createVendorConfig,
  getManagedModelById,
  getVendorById,
  listManagedModelsForVendor,
  resolveManagedModelSelection,
  syncRuntimeSettings,
} from "./general";

const DEFAULT_MANAGED_MODEL_THINKING_LEVEL: ManagedModelThinkingLevel = "medium";
const MANAGED_MODEL_THINKING_LEVELS: readonly ManagedModelThinkingLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim();
}

function normalizeManagedModelThinkingLevel(
  value: unknown,
): ManagedModelThinkingLevel {
  return typeof value === "string" &&
    (MANAGED_MODEL_THINKING_LEVELS as readonly string[]).includes(value)
    ? (value as ManagedModelThinkingLevel)
    : DEFAULT_MANAGED_MODEL_THINKING_LEVEL;
}

function normalizeManagedModelThinkingBudgetTokens(
  value: unknown,
): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.floor(parsed);
}

function normalizeNumberInRangeOrNull(
  value: unknown,
  min: number,
  max: number,
): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.min(max, Math.max(min, parsed));
}

function normalizeIntegerTokenLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(0, Math.floor(parsed));
}

function createDefaultManagedModelMetaSettings(): ManagedModelMetaSettings {
  return {
    contextWindowTokens: 0,
    maxOutputTokens: 0,
    temperature: null,
    topP: null,
    frequencyPenalty: null,
    presencePenalty: null,
    seed: null,
  };
}

function normalizeManagedModelMetaSettings(raw: unknown): ManagedModelMetaSettings {
  if (!raw || typeof raw !== "object") {
    return createDefaultManagedModelMetaSettings();
  }
  const record = raw as Record<string, unknown>;
  return {
    contextWindowTokens: normalizeIntegerTokenLimit(record.contextWindowTokens),
    maxOutputTokens: normalizeIntegerTokenLimit(record.maxOutputTokens),
    temperature: normalizeNumberInRangeOrNull(record.temperature, 0, 2),
    topP: normalizeNumberInRangeOrNull(record.topP, 0, 1),
    frequencyPenalty: normalizeNumberInRangeOrNull(record.frequencyPenalty, -2, 2),
    presencePenalty: normalizeNumberInRangeOrNull(record.presencePenalty, -2, 2),
    seed: normalizeNumberInRangeOrNull(record.seed, 0, Number.MAX_SAFE_INTEGER),
  };
}

export function getActiveVendor(settings: AppSettings): VendorConfig | null {
  return resolveManagedModelSelection(settings, {
    vendorId: settings.activeVendorId,
    modelId: settings.activeModelId,
  })?.vendor ?? null;
}

export function getActiveManagedModel(settings: AppSettings): ManagedModel | null {
  return resolveManagedModelSelection(settings, {
    vendorId: settings.activeVendorId,
    modelId: settings.activeModelId,
  })?.managedModel ?? null;
}

export function setActiveVendorSelection(
  settings: AppSettings,
  vendorId: string,
): AppSettings {
  const vendor = getVendorById(settings, vendorId);
  if (!vendor) {
    return settings;
  }
  const firstModel = listManagedModelsForVendor(settings, vendor.id)[0] ?? null;
  return syncRuntimeSettings({
    ...settings,
    activeVendorId: vendor.id,
    activeModelId: firstModel?.id ?? settings.activeModelId,
  });
}

export function setActiveManagedModelSelection(
  settings: AppSettings,
  modelId: string,
): AppSettings {
  const managedModel = getManagedModelById(settings, modelId);
  if (!managedModel) {
    return settings;
  }
  return syncRuntimeSettings({
    ...settings,
    activeVendorId: managedModel.vendorId,
    activeModelId: managedModel.id,
  });
}

export function createVendor(
  settings: AppSettings,
  params: { name: string; protocol: VendorProtocol; baseUrl: string },
): { settings: AppSettings; vendor: VendorConfig } {
  const vendor = createVendorConfig(params.name, params.protocol, params.baseUrl);
  return {
    vendor,
    settings: {
      ...settings,
      vendors: [...settings.vendors, vendor],
    },
  };
}

export function updateVendor(
  settings: AppSettings,
  vendorId: string,
  updates: Partial<Omit<VendorConfig, "id" | "createdAt">>,
): AppSettings {
  const vendors = settings.vendors.map((vendor) =>
    vendor.id === vendorId
      ? {
          ...vendor,
          ...updates,
          name:
            updates.name !== undefined
              ? updates.name === ""
                ? ""
                : updates.name.trim() || vendor.name
              : vendor.name,
          baseUrl: normalizeBaseUrl(updates.baseUrl ?? vendor.baseUrl),
          updatedAt: nowIso(),
        }
      : vendor,
  );

  return syncRuntimeSettings({ ...settings, vendors });
}

function clearRemovedSelections(
  settings: AppSettings,
  removedVendorId: string,
  removedModelIds: Set<string>,
): AppSettings {
  const activeVendorId =
    settings.activeVendorId === removedVendorId ? null : settings.activeVendorId;
  const activeModelId =
    settings.activeModelId && removedModelIds.has(settings.activeModelId)
      ? null
      : settings.activeModelId;

  return {
    ...settings,
    activeVendorId,
    activeModelId,
  };
}

export function deleteVendor(settings: AppSettings, vendorId: string): AppSettings {
  if (settings.vendors.length <= 1) {
    return settings;
  }

  if (!settings.vendors.some((vendor) => vendor.id === vendorId)) {
    return settings;
  }

  const removedModelIds = new Set(
    settings.managedModels
      .filter((model) => model.vendorId === vendorId)
      .map((model) => model.id),
  );

  const next = clearRemovedSelections(
    {
      ...settings,
      vendors: settings.vendors.filter((vendor) => vendor.id !== vendorId),
      managedModels: settings.managedModels.filter((model) => model.vendorId !== vendorId),
    },
    vendorId,
    removedModelIds,
  );

  return syncRuntimeSettings(next);
}

export function addModelsToVendor(
  settings: AppSettings,
  vendorId: string,
  modelNames: string[],
  source: ManagedModelSource,
): { settings: AppSettings; added: ManagedModel[] } {
  const normalizedNames = Array.from(
    new Set(modelNames.map((name) => name.trim()).filter(Boolean)),
  );
  if (!normalizedNames.length) {
    return { settings, added: [] };
  }

  const existingNames = new Set(
    settings.managedModels
      .filter((model) => model.vendorId === vendorId)
      .map((model) => model.name),
  );
  const added = normalizedNames
    .filter((name) => !existingNames.has(name))
    .map((name) => createManagedModel(vendorId, name, source));

  if (!added.length) {
    return { settings, added: [] };
  }

  return {
    added,
    settings: syncRuntimeSettings({
      ...settings,
      managedModels: [...settings.managedModels, ...added],
    }),
  };
}

export function updateManagedModel(
  settings: AppSettings,
  modelId: string,
  updates: Partial<Omit<ManagedModel, "id" | "vendorId" | "createdAt">>,
): AppSettings {
  const managedModels = settings.managedModels.map((model) =>
    model.id === modelId
      ? {
          ...model,
          ...updates,
          name:
            updates.name !== undefined
              ? updates.name === ""
                ? ""
                : updates.name.trim() || model.name
              : model.name,
          supportsThinking:
            updates.supportsThinking !== undefined
              ? updates.supportsThinking
              : model.supportsThinking,
          thinkingLevel:
            updates.thinkingLevel !== undefined
              ? normalizeManagedModelThinkingLevel(updates.thinkingLevel)
              : model.thinkingLevel,
          thinkingBudgetTokens:
            updates.thinkingBudgetTokens !== undefined
              ? normalizeManagedModelThinkingBudgetTokens(
                  updates.thinkingBudgetTokens,
                )
              : model.thinkingBudgetTokens ?? null,
          metaSettings:
            updates.metaSettings !== undefined
              ? normalizeManagedModelMetaSettings(updates.metaSettings)
              : model.metaSettings,
          updatedAt: nowIso(),
        }
      : model,
  );
  return syncRuntimeSettings({ ...settings, managedModels });
}

export function deleteManagedModel(settings: AppSettings, modelId: string): AppSettings {
  const managedModel = getManagedModelById(settings, modelId);
  if (!managedModel) {
    return settings;
  }

  const vendorModels = settings.managedModels.filter(
    (model) => model.vendorId === managedModel.vendorId,
  );
  if (vendorModels.length <= 1) {
    return settings;
  }

  const next = clearRemovedSelections(
    {
      ...settings,
      managedModels: settings.managedModels.filter((model) => model.id !== modelId),
    },
    managedModel.vendorId,
    new Set([modelId]),
  );

  return syncRuntimeSettings(next);
}

export function isLocalVendor(vendor: VendorConfig | null | undefined): boolean {
  if (!vendor) {
    return false;
  }

  try {
    const url = new URL(vendor.baseUrl);
    const host = url.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?/i.test(vendor.baseUrl);
  }
}

export function isManagedModelLocal(settings: AppSettings, modelId?: string | null): boolean {
  const selection = modelId
    ? resolveManagedModelSelection(settings, { modelId })
    : resolveManagedModelSelection(settings, {
        vendorId: settings.activeVendorId,
        modelId: settings.activeModelId,
      });
  return isLocalVendor(selection?.vendor);
}

export function isActiveModelLocal(settings: AppSettings): boolean {
  return isLocalVendor(getActiveVendor(settings));
}
