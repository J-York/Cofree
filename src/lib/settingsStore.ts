/**
 * Cofree - AI Programming Cafe
 * File: src/lib/settingsStore.ts
 * Description: 持久化模型供应商、模型库与配置档案。
 */

import { invoke } from "@tauri-apps/api/core";

export const SETTINGS_STORAGE_KEY = "cofree.settings.v1";
export const SETTINGS_STORAGE_KEY_V2 = "cofree.settings.v2";

const DEFAULT_BASE_URL = "http://localhost:4000";
const DEFAULT_MODEL_NAME = "openai/gpt-4o-mini";
const DEFAULT_VENDOR_ID = "vendor-default";
const DEFAULT_MODEL_ID = "model-default";
const DEFAULT_PROFILE_ID = "profile-default";
const FIXED_TIMESTAMP = "2026-03-06T00:00:00.000Z";

export type ToolPermissionLevel = "auto" | "ask";
export type VendorProtocol =
  | "openai-chat-completions"
  | "openai-responses"
  | "anthropic-messages";
export type ProxyMode = "off" | "http" | "https" | "socks5";
export type ManagedModelSource = "manual" | "fetched";

export interface ToolPermissions {
  list_files: ToolPermissionLevel;
  read_file: ToolPermissionLevel;
  grep: ToolPermissionLevel;
  glob: ToolPermissionLevel;
  git_status: ToolPermissionLevel;
  git_diff: ToolPermissionLevel;
  propose_file_edit: ToolPermissionLevel;
  propose_apply_patch: ToolPermissionLevel;
  propose_shell: ToolPermissionLevel;
  diagnostics: ToolPermissionLevel;
  fetch: ToolPermissionLevel;
}

export const DEFAULT_TOOL_PERMISSIONS: ToolPermissions = {
  list_files: "auto",
  read_file: "auto",
  grep: "auto",
  glob: "auto",
  git_status: "auto",
  git_diff: "auto",
  propose_file_edit: "ask",
  propose_apply_patch: "ask",
  propose_shell: "ask",
  diagnostics: "auto",
  fetch: "ask",
};

export interface ProxySettings {
  mode: ProxyMode;
  url: string;
  username?: string;
  password?: string;
  noProxy?: string;
}

export interface VendorConfig {
  id: string;
  name: string;
  protocol: VendorProtocol;
  baseUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface ManagedModel {
  id: string;
  vendorId: string;
  name: string;
  source: ManagedModelSource;
  createdAt: string;
  updatedAt: string;
}

/** 单个模型配置档案 */
export interface ModelProfile {
  id: string;
  name: string;
  vendorId?: string;
  modelId?: string;
  provider?: string;
  model: string;
  liteLLMBaseUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface AppSettings {
  apiKey: string;
  liteLLMBaseUrl: string;
  provider?: string;
  model: string;
  allowCloudModels: boolean;
  maxSnippetLines: 200 | 500 | 2000;
  maxContextTokens: number;
  sendRelativePathOnly: boolean;
  lastSavedAt: string | null;
  workspacePath: string;
  toolPermissions: ToolPermissions;
  proxy: ProxySettings;
  activeProfileId: string | null;
  activeAgentId: string | null;
  profiles: ModelProfile[];
  vendors: VendorConfig[];
  managedModels: ManagedModel[];
}

type PersistedSettings = Omit<AppSettings, "apiKey"> & { apiKey?: string };

function nowIso(): string {
  return new Date().toISOString();
}

function formatLegacyModelRef(provider?: string, model?: string): string {
  const trimmedModel = model?.trim() || DEFAULT_MODEL_NAME;
  const trimmedProvider = provider?.trim();
  return trimmedProvider ? `${trimmedProvider}/${trimmedModel}` : trimmedModel;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim();
}

function buildProfileSnapshot(
  profile: ModelProfile,
  vendor?: VendorConfig | null,
  managedModel?: ManagedModel | null
): ModelProfile {
  return {
    ...profile,
    vendorId: vendor?.id,
    modelId: managedModel?.id,
    provider: undefined,
    model: managedModel?.name?.trim() || profile.model?.trim() || DEFAULT_MODEL_NAME,
    liteLLMBaseUrl: vendor?.baseUrl ?? profile.liteLLMBaseUrl ?? "",
  };
}

function createFixedDefaultEntities(): {
  vendor: VendorConfig;
  model: ManagedModel;
  profile: ModelProfile;
} {
  const vendor: VendorConfig = {
    id: DEFAULT_VENDOR_ID,
    name: "默认供应商",
    protocol: "openai-chat-completions",
    baseUrl: DEFAULT_BASE_URL,
    createdAt: FIXED_TIMESTAMP,
    updatedAt: FIXED_TIMESTAMP,
  };
  const model: ManagedModel = {
    id: DEFAULT_MODEL_ID,
    vendorId: vendor.id,
    name: DEFAULT_MODEL_NAME,
    source: "manual",
    createdAt: FIXED_TIMESTAMP,
    updatedAt: FIXED_TIMESTAMP,
  };
  const profile: ModelProfile = {
    id: DEFAULT_PROFILE_ID,
    name: "默认配置",
    vendorId: vendor.id,
    modelId: model.id,
    provider: undefined,
    model: model.name,
    liteLLMBaseUrl: vendor.baseUrl,
    createdAt: FIXED_TIMESTAMP,
    updatedAt: FIXED_TIMESTAMP,
  };
  return { vendor, model, profile };
}

function createInitialSettings(): AppSettings {
  const defaults = createFixedDefaultEntities();
  return {
    apiKey: "",
    liteLLMBaseUrl: defaults.vendor.baseUrl,
    provider: defaults.vendor.name,
    model: defaults.model.name,
    allowCloudModels: true,
    maxSnippetLines: 500,
    maxContextTokens: 128000,
    sendRelativePathOnly: true,
    lastSavedAt: null,
    workspacePath: "",
    toolPermissions: { ...DEFAULT_TOOL_PERMISSIONS },
    proxy: {
      mode: "off",
      url: "",
      username: "",
      password: "",
      noProxy: "",
    },
    activeProfileId: defaults.profile.id,
    activeAgentId: null,
    profiles: [defaults.profile],
    vendors: [defaults.vendor],
    managedModels: [defaults.model],
  };
}

export const DEFAULT_SETTINGS: AppSettings = createInitialSettings();

export function generateProfileId(): string {
  return `profile-${Date.now()}`;
}

export function generateVendorId(): string {
  return `vendor-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

export function generateManagedModelId(): string {
  return `model-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

export function createVendorConfig(
  name: string,
  protocol: VendorProtocol,
  baseUrl: string
): VendorConfig {
  const timestamp = nowIso();
  return {
    id: generateVendorId(),
    name: name.trim() || "新供应商",
    protocol,
    baseUrl: normalizeBaseUrl(baseUrl),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createManagedModel(
  vendorId: string,
  name: string,
  source: ManagedModelSource = "manual"
): ManagedModel {
  const timestamp = nowIso();
  return {
    id: generateManagedModelId(),
    vendorId,
    name: name.trim(),
    source,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createDefaultProfile(
  id: string,
  name: string,
  baseUrl: string,
  provider?: string,
  model?: string
): ModelProfile {
  const timestamp = nowIso();
  return {
    id,
    name: name.trim() || "默认配置",
    provider: undefined,
    model: formatLegacyModelRef(provider, model),
    liteLLMBaseUrl: normalizeBaseUrl(baseUrl) || DEFAULT_BASE_URL,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function getVendorById(
  settings: Pick<AppSettings, "vendors">,
  vendorId?: string | null
): VendorConfig | null {
  if (!vendorId) {
    return null;
  }
  return settings.vendors.find((vendor) => vendor.id === vendorId) || null;
}

export function getManagedModelById(
  settings: Pick<AppSettings, "managedModels">,
  modelId?: string | null
): ManagedModel | null {
  if (!modelId) {
    return null;
  }
  return settings.managedModels.find((model) => model.id === modelId) || null;
}

export function listManagedModelsForVendor(
  settings: Pick<AppSettings, "managedModels">,
  vendorId?: string | null
): ManagedModel[] {
  if (!vendorId) {
    return [];
  }
  return settings.managedModels.filter((model) => model.vendorId === vendorId);
}

function findSelectionForProfile(
  settings: Pick<AppSettings, "vendors" | "managedModels">,
  profile: ModelProfile | null | undefined
): { vendor: VendorConfig; managedModel: ManagedModel } | null {
  if (!profile) {
    return null;
  }

  const directModel = getManagedModelById(settings, profile.modelId);
  const directVendor = getVendorById(settings, directModel?.vendorId ?? profile.vendorId);
  if (directModel && directVendor) {
    return { vendor: directVendor, managedModel: directModel };
  }

  const modelName = profile.model.trim();
  const scopedModels = listManagedModelsForVendor(settings, profile.vendorId);
  const modelByName =
    scopedModels.find((entry) => entry.name === modelName) ||
    settings.managedModels.find((entry) => entry.name === modelName);
  const vendor =
    getVendorById(settings, modelByName?.vendorId) ||
    getVendorById(settings, profile.vendorId);
  if (modelByName && vendor) {
    return { vendor, managedModel: modelByName };
  }

  const [firstVendor] = settings.vendors;
  const firstModel = settings.managedModels.find(
    (entry) => entry.vendorId === firstVendor?.id
  );
  if (firstVendor && firstModel) {
    return { vendor: firstVendor, managedModel: firstModel };
  }

  return null;
}

export function getProfileSelection(
  settings: Pick<AppSettings, "vendors" | "managedModels">,
  profile: ModelProfile | null | undefined
): { vendor: VendorConfig; managedModel: ManagedModel } | null {
  return findSelectionForProfile(settings, profile);
}

export function getActiveProfile(settings: AppSettings): ModelProfile | null {
  if (!settings.activeProfileId) {
    return settings.profiles[0] ?? null;
  }
  return (
    settings.profiles.find((profile) => profile.id === settings.activeProfileId) ||
    settings.profiles[0] ||
    null
  );
}

export function getActiveVendor(settings: AppSettings): VendorConfig | null {
  return getProfileSelection(settings, getActiveProfile(settings))?.vendor ?? null;
}

export function getActiveManagedModel(settings: AppSettings): ManagedModel | null {
  return getProfileSelection(settings, getActiveProfile(settings))?.managedModel ?? null;
}

function withSynchronizedProfiles(settings: AppSettings): AppSettings {
  const profiles =
    settings.profiles.length > 0 ? settings.profiles : [...DEFAULT_SETTINGS.profiles];
  const synchronized = profiles.map((profile) => {
    const selection = findSelectionForProfile(settings, profile);
    if (!selection) {
      return profile;
    }
    return buildProfileSnapshot(profile, selection.vendor, selection.managedModel);
  });
  return { ...settings, profiles: synchronized };
}

function withRuntimeSelection(settings: AppSettings, apiKey = settings.apiKey): AppSettings {
  const profiles = settings.profiles.length > 0 ? settings.profiles : [...DEFAULT_SETTINGS.profiles];
  const activeProfileId =
    settings.activeProfileId && profiles.some((profile) => profile.id === settings.activeProfileId)
      ? settings.activeProfileId
      : (profiles[0]?.id ?? null);
  const activeProfile =
    profiles.find((profile) => profile.id === activeProfileId) || profiles[0] || null;
  const selection = findSelectionForProfile(
    { vendors: settings.vendors, managedModels: settings.managedModels },
    activeProfile
  );

  if (!selection) {
    return {
      ...DEFAULT_SETTINGS,
      ...settings,
      apiKey,
      profiles,
      activeProfileId,
      vendors: settings.vendors.length ? settings.vendors : DEFAULT_SETTINGS.vendors,
      managedModels: settings.managedModels.length
        ? settings.managedModels
        : DEFAULT_SETTINGS.managedModels,
    };
  }

  const nextProfiles = profiles.map((profile) =>
    profile.id === activeProfile?.id
      ? buildProfileSnapshot(profile, selection.vendor, selection.managedModel)
      : profile
  );

  return {
    ...settings,
    apiKey,
    activeProfileId,
    profiles: nextProfiles,
    provider: selection.vendor.name,
    model: selection.managedModel.name,
    liteLLMBaseUrl: selection.vendor.baseUrl,
  };
}

export function syncRuntimeSettings(settings: AppSettings, apiKey = settings.apiKey): AppSettings {
  return withRuntimeSelection(withSynchronizedProfiles(settings), apiKey);
}

function migrateLegacyProfilesToManagedSettings(
  settings: AppSettings
): AppSettings {
  const sourceProfiles =
    settings.profiles.length > 0
      ? settings.profiles
      : [
          createDefaultProfile(
            DEFAULT_PROFILE_ID,
            "默认配置",
            settings.liteLLMBaseUrl || DEFAULT_BASE_URL,
            settings.provider,
            settings.model
          ),
        ];

  const vendors: VendorConfig[] = [];
  const managedModels: ManagedModel[] = [];
  const profiles: ModelProfile[] = [];

  for (const sourceProfile of sourceProfiles) {
    const timestamp = sourceProfile.updatedAt || sourceProfile.createdAt || nowIso();
    const vendorId = sourceProfile.vendorId || `vendor-${sourceProfile.id}`;
    const modelId = sourceProfile.modelId || `model-${sourceProfile.id}`;
    const vendor: VendorConfig = {
      id: vendorId,
      name:
        sourceProfile.name.trim() === "默认配置"
          ? "默认供应商"
          : `${sourceProfile.name.trim()} 供应商`,
      protocol: "openai-chat-completions",
      baseUrl:
        normalizeBaseUrl(sourceProfile.liteLLMBaseUrl || settings.liteLLMBaseUrl) ||
        DEFAULT_BASE_URL,
      createdAt: sourceProfile.createdAt || timestamp,
      updatedAt: timestamp,
    };
    const managedModel: ManagedModel = {
      id: modelId,
      vendorId,
      name: formatLegacyModelRef(sourceProfile.provider, sourceProfile.model),
      source: "manual",
      createdAt: sourceProfile.createdAt || timestamp,
      updatedAt: timestamp,
    };

    vendors.push(vendor);
    managedModels.push(managedModel);
    profiles.push(
      buildProfileSnapshot(
        {
          ...sourceProfile,
          vendorId,
          modelId,
          provider: undefined,
          updatedAt: timestamp,
        },
        vendor,
        managedModel
      )
    );
  }

  return syncRuntimeSettings({
    ...settings,
    apiKey: "",
    activeProfileId:
      settings.activeProfileId && profiles.some((profile) => profile.id === settings.activeProfileId)
        ? settings.activeProfileId
        : profiles[0]?.id ?? null,
    profiles,
    vendors,
    managedModels,
  });
}

function normalizeLoadedSettings(parsed: Partial<PersistedSettings>): AppSettings {
  const base: AppSettings = {
    ...DEFAULT_SETTINGS,
    ...parsed,
    apiKey: "",
    activeProfileId:
      typeof parsed.activeProfileId === "string" ? parsed.activeProfileId : DEFAULT_SETTINGS.activeProfileId,
    activeAgentId:
      typeof (parsed as Record<string, unknown>).activeAgentId === "string" ? (parsed as Record<string, unknown>).activeAgentId as string : null,
    profiles: Array.isArray(parsed.profiles) ? parsed.profiles : [],
    vendors: Array.isArray(parsed.vendors) ? parsed.vendors : [],
    managedModels: Array.isArray(parsed.managedModels) ? parsed.managedModels : [],
    proxy: {
      ...DEFAULT_SETTINGS.proxy,
      ...(isRecord(parsed.proxy) ? parsed.proxy : {}),
    },
    toolPermissions: {
      ...DEFAULT_TOOL_PERMISSIONS,
      ...(isRecord(parsed.toolPermissions) ? parsed.toolPermissions : {}),
    } as ToolPermissions,
  };

  if (!base.vendors.length || !base.managedModels.length) {
    return migrateLegacyProfilesToManagedSettings(base);
  }

  const settingsWithFallbackProfiles =
    base.profiles.length > 0
      ? base
      : {
          ...base,
          profiles: [
            buildProfileSnapshot(
              {
                ...DEFAULT_SETTINGS.profiles[0],
                id: DEFAULT_PROFILE_ID,
                name: "默认配置",
              },
              base.vendors[0],
              base.managedModels.find((model) => model.vendorId === base.vendors[0]?.id) ??
                base.managedModels[0]
            ),
          ],
          activeProfileId: DEFAULT_PROFILE_ID,
        };

  return syncRuntimeSettings(settingsWithFallbackProfiles);
}

function migrateSettingsV1ToV2(v1Settings: Partial<PersistedSettings>): AppSettings {
  return normalizeLoadedSettings(v1Settings);
}

export function loadSettings(): AppSettings {
  if (typeof window === "undefined") {
    return DEFAULT_SETTINGS;
  }

  const rawV2 = window.localStorage.getItem(SETTINGS_STORAGE_KEY_V2);
  if (rawV2) {
    try {
      const parsed = JSON.parse(rawV2) as Partial<PersistedSettings>;
      return normalizeLoadedSettings(parsed);
    } catch (_error) {
      // ignore and continue to V1 migration
    }
  }

  const rawV1 = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
  if (!rawV1) {
    return DEFAULT_SETTINGS;
  }

  try {
    const parsed = JSON.parse(rawV1) as Partial<PersistedSettings>;
    const migrated = migrateSettingsV1ToV2(parsed);
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY_V2,
      JSON.stringify({
        ...migrated,
        apiKey: "",
        lastSavedAt: nowIso(),
      })
    );
    window.localStorage.removeItem(SETTINGS_STORAGE_KEY);
    return migrated;
  } catch (_error) {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: AppSettings): void {
  if (typeof window === "undefined") {
    return;
  }

  const withTimestamp: PersistedSettings = {
    ...syncRuntimeSettings(settings),
    apiKey: "",
    lastSavedAt: nowIso(),
  };

  window.localStorage.setItem(SETTINGS_STORAGE_KEY_V2, JSON.stringify(withTimestamp));
}

export async function loadSecureApiKey(profileId?: string | null): Promise<string> {
  try {
    const value = await invoke<string>("load_secure_api_key", {
      profileId: profileId || null,
    });
    return typeof value === "string" ? value : "";
  } catch (_error) {
    return "";
  }
}

export async function saveSecureApiKey(apiKey: string, profileId?: string | null): Promise<void> {
  await invoke("save_secure_api_key", {
    profileId: profileId || null,
    apiKey,
  });
}

export async function deleteSecureApiKey(profileId: string): Promise<void> {
  await invoke("delete_secure_api_key", { profileId });
}

function vendorSecretSlot(vendorId: string): string {
  return `vendor:${vendorId}`;
}

function legacyVendorSecretSlot(vendorId: string): string | null | undefined {
  if (vendorId === DEFAULT_VENDOR_ID) {
    return undefined;
  }

  if (vendorId.startsWith("vendor-profile-")) {
    return vendorId.slice("vendor-".length);
  }

  return null;
}

export async function loadVendorApiKey(vendorId?: string | null): Promise<string> {
  if (!vendorId) {
    return "";
  }

  const currentSlot = vendorSecretSlot(vendorId);
  const currentKey = await loadSecureApiKey(currentSlot);
  if (currentKey) {
    return currentKey;
  }

  const legacySlot = legacyVendorSecretSlot(vendorId);
  if (legacySlot === null) {
    return "";
  }

  const legacyKey = await loadSecureApiKey(legacySlot);
  if (!legacyKey) {
    return "";
  }

  try {
    await saveSecureApiKey(legacyKey, currentSlot);
  } catch {
    // Ignore migration persistence failure and still return the recovered key.
  }

  return legacyKey;
}

export async function saveVendorApiKey(vendorId: string, apiKey: string): Promise<void> {
  await saveSecureApiKey(apiKey, vendorSecretSlot(vendorId));
}

export async function deleteVendorApiKey(vendorId: string): Promise<void> {
  await deleteSecureApiKey(vendorSecretSlot(vendorId));
}

export function createProfile(
  settings: AppSettings,
  name: string
): { settings: AppSettings; profile: ModelProfile } {
  const id = generateProfileId();
  const activeProfile = getActiveProfile(settings) || DEFAULT_SETTINGS.profiles[0];
  const timestamp = nowIso();
  const profile: ModelProfile = {
    ...activeProfile,
    id,
    name: name.trim() || "新配置",
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  return {
    profile,
    settings: syncRuntimeSettings({
      ...settings,
      profiles: [...settings.profiles, profile],
      activeProfileId: id,
    }),
  };
}

export function updateProfile(
  settings: AppSettings,
  profileId: string,
  updates: Partial<Omit<ModelProfile, "id" | "createdAt">>
): AppSettings {
  const profiles = settings.profiles.map((profile) => {
    if (profile.id !== profileId) {
      return profile;
    }
    const updated = {
      ...profile,
      ...updates,
      updatedAt: nowIso(),
    };
    const selection = findSelectionForProfile(settings, updated);
    return buildProfileSnapshot(updated, selection?.vendor, selection?.managedModel);
  });

  return syncRuntimeSettings({ ...settings, profiles });
}

export function setProfileModelSelection(
  settings: AppSettings,
  profileId: string,
  modelId: string
): AppSettings {
  const managedModel = getManagedModelById(settings, modelId);
  const vendor = getVendorById(settings, managedModel?.vendorId);
  if (!managedModel || !vendor) {
    return settings;
  }

  return updateProfile(settings, profileId, {
    vendorId: vendor.id,
    modelId: managedModel.id,
    model: managedModel.name,
    liteLLMBaseUrl: vendor.baseUrl,
  });
}

export function deleteProfile(settings: AppSettings, profileId: string): AppSettings {
  if (settings.profiles.length <= 1) {
    return settings;
  }

  const profiles = settings.profiles.filter((profile) => profile.id !== profileId);
  const activeProfileId =
    settings.activeProfileId === profileId ? profiles[0]?.id ?? null : settings.activeProfileId;
  return syncRuntimeSettings({ ...settings, profiles, activeProfileId });
}

export function switchProfile(settings: AppSettings, profileId: string): AppSettings {
  if (!settings.profiles.some((profile) => profile.id === profileId)) {
    return settings;
  }
  return syncRuntimeSettings({ ...settings, activeProfileId: profileId });
}

export function switchAgent(settings: AppSettings, agentId: string): AppSettings {
  return { ...settings, activeAgentId: agentId };
}

export function createVendor(
  settings: AppSettings,
  params: {
    name: string;
    protocol: VendorProtocol;
    baseUrl: string;
  }
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
  updates: Partial<Omit<VendorConfig, "id" | "createdAt">>
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
      : vendor
  );

  const updatedSettings = { ...settings, vendors };
  return syncRuntimeSettings(withSynchronizedProfiles(updatedSettings));
}

export function deleteVendor(settings: AppSettings, vendorId: string): AppSettings {
  if (settings.vendors.length <= 1) {
    return settings;
  }

  const vendorExists = settings.vendors.some((vendor) => vendor.id === vendorId);
  if (!vendorExists) {
    return settings;
  }

  const fallbackVendor =
    settings.vendors.find((vendor) => vendor.id !== vendorId) || DEFAULT_SETTINGS.vendors[0];
  const fallbackModel =
    settings.managedModels.find((model) => model.vendorId === fallbackVendor.id) ||
    DEFAULT_SETTINGS.managedModels.find((model) => model.vendorId === fallbackVendor.id) ||
    DEFAULT_SETTINGS.managedModels[0];

  const removedModelIds = new Set(
    settings.managedModels
      .filter((model) => model.vendorId === vendorId)
      .map((model) => model.id)
  );

  const profiles = settings.profiles.map((profile) => {
    const shouldReassign =
      profile.vendorId === vendorId ||
      (profile.modelId ? removedModelIds.has(profile.modelId) : false);

    if (!shouldReassign) {
      return profile;
    }

    return buildProfileSnapshot(profile, fallbackVendor, fallbackModel);
  });

  return syncRuntimeSettings({
    ...settings,
    profiles,
    vendors: settings.vendors.filter((vendor) => vendor.id !== vendorId),
    managedModels: settings.managedModels.filter((model) => model.vendorId !== vendorId),
  });
}

export function addModelsToVendor(
  settings: AppSettings,
  vendorId: string,
  modelNames: string[],
  source: ManagedModelSource
): { settings: AppSettings; added: ManagedModel[] } {
  const normalizedNames = Array.from(
    new Set(
      modelNames
        .map((name) => name.trim())
        .filter(Boolean)
    )
  );
  if (!normalizedNames.length) {
    return { settings, added: [] };
  }

  const existingNames = new Set(
    settings.managedModels
      .filter((model) => model.vendorId === vendorId)
      .map((model) => model.name)
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
  updates: Partial<Omit<ManagedModel, "id" | "vendorId" | "createdAt">>
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
          updatedAt: nowIso(),
        }
      : model
  );
  return syncRuntimeSettings({ ...settings, managedModels });
}

export function deleteManagedModel(settings: AppSettings, modelId: string): AppSettings {
  const managedModel = getManagedModelById(settings, modelId);
  if (!managedModel) {
    return settings;
  }

  const vendorModels = settings.managedModels.filter((model) => model.vendorId === managedModel.vendorId);
  if (vendorModels.length <= 1) {
    return settings;
  }

  const fallbackModel =
    vendorModels.find((model) => model.id !== modelId) ||
    settings.managedModels.find((model) => model.id !== modelId) ||
    DEFAULT_SETTINGS.managedModels[0];
  const fallbackVendor = getVendorById(settings, fallbackModel.vendorId);
  if (!fallbackVendor) {
    return settings;
  }

  const profiles = settings.profiles.map((profile) =>
    profile.modelId === modelId
      ? buildProfileSnapshot(profile, fallbackVendor, fallbackModel)
      : profile
  );

  return syncRuntimeSettings({
    ...settings,
    profiles,
    managedModels: settings.managedModels.filter((model) => model.id !== modelId),
  });
}

export function isLocalVendor(vendor: VendorConfig | null | undefined): boolean {
  if (!vendor) {
    return false;
  }

  try {
    const url = new URL(vendor.baseUrl);
    const host = url.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch (_error) {
    return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?/i.test(vendor.baseUrl);
  }
}

export function isManagedModelLocal(settings: AppSettings, modelId?: string | null): boolean {
  const selection = modelId
    ? settings.profiles
        .map((profile) => getProfileSelection(settings, profile))
        .find((candidate) => candidate?.managedModel.id === modelId) ??
      (() => {
        const managedModel = getManagedModelById(settings, modelId);
        const vendor = getVendorById(settings, managedModel?.vendorId);
        return managedModel && vendor ? { vendor, managedModel } : null;
      })()
    : getProfileSelection(settings, getActiveProfile(settings));

  return isLocalVendor(selection?.vendor);
}

export function isActiveModelLocal(settings: AppSettings): boolean {
  return isLocalVendor(
    getProfileSelection(settings, getActiveProfile(settings))?.vendor
  );
}

export function maskApiKey(key: string): string {
  if (!key) {
    return "未设置";
  }

  if (key.length <= 8) {
    return "*".repeat(key.length);
  }

  const head = key.slice(0, 4);
  const tail = key.slice(-4);
  return `${head}${"*".repeat(Math.max(4, key.length - 8))}${tail}`;
}