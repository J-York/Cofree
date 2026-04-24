import { migrateLegacyConversationBindings } from "../conversationMaintenance";
import type { ModelSelection } from "../modelSelection";
import type { SkillEntry } from "../skillStore";

export const SETTINGS_STORAGE_KEY = "cofree.settings.v1";
export const SETTINGS_STORAGE_KEY_V2 = "cofree.settings.v2";
export const SETTINGS_STORAGE_KEY_V3 = "cofree.settings.v3";

const DEFAULT_BASE_URL = "http://localhost:4000";
const DEFAULT_MODEL_NAME = "openai/gpt-4o-mini";
const DEFAULT_VENDOR_ID = "vendor-default";
const DEFAULT_MODEL_ID = "model-default";
const FIXED_TIMESTAMP = "2026-03-06T00:00:00.000Z";
const MAX_RECENT_WORKSPACES = 5;

export type ToolPermissionLevel = "auto" | "ask";
export type VendorProtocol =
  | "openai-chat-completions"
  | "openai-responses"
  | "anthropic-messages";
export type ProxyMode = "off" | "http" | "https" | "socks5";
export type ManagedModelSource = "manual" | "fetched";
export type ManagedModelThinkingLevel = "low" | "medium" | "high";

const DEFAULT_MANAGED_MODEL_THINKING_LEVEL: ManagedModelThinkingLevel = "medium";

export interface ToolPermissions {
  list_files: ToolPermissionLevel;
  read_file: ToolPermissionLevel;
  grep: ToolPermissionLevel;
  glob: ToolPermissionLevel;
  git_status: ToolPermissionLevel;
  git_diff: ToolPermissionLevel;
  propose_file_edit: ToolPermissionLevel;
  propose_shell: ToolPermissionLevel;
  check_shell_job: ToolPermissionLevel;
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
  propose_shell: "ask",
  check_shell_job: "auto",
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
  supportsThinking: boolean;
  thinkingLevel: ManagedModelThinkingLevel;
  metaSettings: ManagedModelMetaSettings;
  createdAt: string;
  updatedAt: string;
}

export interface ManagedModelMetaSettings {
  contextWindowTokens: number;
  maxOutputTokens: number;
  temperature: number | null;
  topP: number | null;
  frequencyPenalty: number | null;
  presencePenalty: number | null;
  seed: number | null;
}

export interface AppSettings {
  apiKey: string;
  liteLLMBaseUrl: string;
  provider?: string;
  model: string;
  debugMode: boolean;
  allowCloudModels: boolean;
  maxSnippetLines: 200 | 500 | 2000;
  sendRelativePathOnly: boolean;
  lastSavedAt: string | null;
  workspacePath: string;
  recentWorkspaces: string[];
  toolPermissions: ToolPermissions;
  proxy: ProxySettings;
  activeVendorId: string | null;
  activeModelId: string | null;
  vendors: VendorConfig[];
  managedModels: ManagedModel[];
  skills: SkillEntry[];
}

type PersistedSettings = Omit<AppSettings, "apiKey"> & { apiKey?: string };

type LegacyModelProfile = {
  id?: string;
  name?: string;
  vendorId?: string;
  modelId?: string;
  provider?: string;
  model?: string;
  liteLLMBaseUrl?: string;
  createdAt?: string;
  updatedAt?: string;
};

type LegacyProfileSelection = ModelSelection & {
  vendorName?: string;
  modelName?: string;
};

interface ResolvedSelection {
  vendor: VendorConfig;
  managedModel: ManagedModel;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim();
}

function normalizeWorkspacePath(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeRecentWorkspaces(raw: unknown, activeWorkspacePath = ""): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const pushPath = (value: unknown) => {
    const normalized = normalizeWorkspacePath(value);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    result.push(normalized);
  };

  pushPath(activeWorkspacePath);
  if (Array.isArray(raw)) {
    for (const value of raw) {
      pushPath(value);
      if (result.length >= MAX_RECENT_WORKSPACES) {
        break;
      }
    }
  }

  return result.slice(0, MAX_RECENT_WORKSPACES);
}

function normalizeManagedModelThinkingLevel(
  value: unknown,
): ManagedModelThinkingLevel {
  return value === "low" || value === "medium" || value === "high"
    ? value
    : DEFAULT_MANAGED_MODEL_THINKING_LEVEL;
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

function normalizeManagedModelMetaSettings(raw: unknown): ManagedModelMetaSettings {
  if (!isRecord(raw)) {
    return createDefaultManagedModelMetaSettings();
  }
  return {
    contextWindowTokens: normalizeIntegerTokenLimit(raw.contextWindowTokens),
    maxOutputTokens: normalizeIntegerTokenLimit(raw.maxOutputTokens),
    temperature: normalizeNumberInRangeOrNull(raw.temperature, 0, 2),
    topP: normalizeNumberInRangeOrNull(raw.topP, 0, 1),
    frequencyPenalty: normalizeNumberInRangeOrNull(raw.frequencyPenalty, -2, 2),
    presencePenalty: normalizeNumberInRangeOrNull(raw.presencePenalty, -2, 2),
    seed: normalizeNumberInRangeOrNull(raw.seed, 0, Number.MAX_SAFE_INTEGER),
  };
}

function formatLegacyModelRef(provider?: string, model?: string): string {
  const trimmedModel = model?.trim() || DEFAULT_MODEL_NAME;
  const trimmedProvider = provider?.trim();
  return trimmedProvider ? `${trimmedProvider}/${trimmedModel}` : trimmedModel;
}

function createFixedDefaultEntities(): { vendor: VendorConfig; model: ManagedModel } {
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
    supportsThinking: false,
    thinkingLevel: DEFAULT_MANAGED_MODEL_THINKING_LEVEL,
    metaSettings: createDefaultManagedModelMetaSettings(),
    createdAt: FIXED_TIMESTAMP,
    updatedAt: FIXED_TIMESTAMP,
  };
  return { vendor, model };
}

function createInitialSettings(): AppSettings {
  const defaults = createFixedDefaultEntities();
  return {
    apiKey: "",
    liteLLMBaseUrl: defaults.vendor.baseUrl,
    provider: defaults.vendor.name,
    model: defaults.model.name,
    debugMode: false,
    allowCloudModels: true,
    maxSnippetLines: 500,
    sendRelativePathOnly: true,
    lastSavedAt: null,
    workspacePath: "",
    recentWorkspaces: [],
    toolPermissions: { ...DEFAULT_TOOL_PERMISSIONS },
    proxy: {
      mode: "off",
      url: "",
      username: "",
      password: "",
      noProxy: "",
    },
    activeVendorId: defaults.vendor.id,
    activeModelId: defaults.model.id,
    vendors: [defaults.vendor],
    managedModels: [defaults.model],
    skills: [],
  };
}

export const DEFAULT_SETTINGS: AppSettings = createInitialSettings();

export function generateVendorId(): string {
  return `vendor-${Date.now()}`;
}

export function generateManagedModelId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `model-${crypto.randomUUID()}`;
  }
  return `model-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

export function createVendorConfig(
  name: string,
  protocol: VendorProtocol,
  baseUrl: string,
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
  source: ManagedModelSource = "manual",
): ManagedModel {
  const timestamp = nowIso();
  return {
    id: generateManagedModelId(),
    vendorId,
    name: name.trim(),
    source,
    supportsThinking: false,
    thinkingLevel: DEFAULT_MANAGED_MODEL_THINKING_LEVEL,
    metaSettings: createDefaultManagedModelMetaSettings(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function normalizeVendor(raw: unknown): VendorConfig | null {
  if (!isRecord(raw) || typeof raw.id !== "string") return null;
  const createdAt = typeof raw.createdAt === "string" ? raw.createdAt : nowIso();
  const updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : createdAt;
  const protocol = raw.protocol;
  const normalizedProtocol: VendorProtocol =
    protocol === "openai-responses" || protocol === "anthropic-messages"
      ? protocol
      : "openai-chat-completions";
  return {
    id: raw.id,
    name: typeof raw.name === "string" ? raw.name : "供应商",
    protocol: normalizedProtocol,
    baseUrl:
      typeof raw.baseUrl === "string" && raw.baseUrl.trim()
        ? normalizeBaseUrl(raw.baseUrl)
        : DEFAULT_BASE_URL,
    createdAt,
    updatedAt,
  };
}

function normalizeManagedModel(raw: unknown): ManagedModel | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.vendorId !== "string") {
    return null;
  }
  const createdAt = typeof raw.createdAt === "string" ? raw.createdAt : nowIso();
  const updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : createdAt;
  return {
    id: raw.id,
    vendorId: raw.vendorId,
    name: typeof raw.name === "string" ? raw.name : DEFAULT_MODEL_NAME,
    source: raw.source === "fetched" ? "fetched" : "manual",
    supportsThinking: raw.supportsThinking === true,
    thinkingLevel: normalizeManagedModelThinkingLevel(raw.thinkingLevel),
    metaSettings: normalizeManagedModelMetaSettings(raw.metaSettings),
    createdAt,
    updatedAt,
  };
}

export function getVendorById(
  settings: Pick<AppSettings, "vendors">,
  vendorId?: string | null,
): VendorConfig | null {
  if (!vendorId) return null;
  return settings.vendors.find((vendor) => vendor.id === vendorId) || null;
}

export function getManagedModelById(
  settings: Pick<AppSettings, "managedModels">,
  modelId?: string | null,
): ManagedModel | null {
  if (!modelId) return null;
  return settings.managedModels.find((model) => model.id === modelId) || null;
}

export function listManagedModelsForVendor(
  settings: Pick<AppSettings, "managedModels">,
  vendorId?: string | null,
): ManagedModel[] {
  if (!vendorId) return [];
  return settings.managedModels.filter((model) => model.vendorId === vendorId);
}

function findFirstAvailableSelection(
  settings: Pick<AppSettings, "vendors" | "managedModels">,
): ResolvedSelection | null {
  for (const vendor of settings.vendors) {
    const managedModel = settings.managedModels.find((model) => model.vendorId === vendor.id);
    if (managedModel) {
      return { vendor, managedModel };
    }
  }

  const fallbackVendor = settings.vendors[0] ?? null;
  const fallbackModel = settings.managedModels[0] ?? null;
  if (fallbackVendor && fallbackModel) {
    return {
      vendor: getVendorById(settings, fallbackModel.vendorId) ?? fallbackVendor,
      managedModel: fallbackModel,
    };
  }
  return null;
}

export function resolveManagedModelSelection(
  settings: Pick<AppSettings, "vendors" | "managedModels">,
  selection?: { vendorId?: string | null; modelId?: string | null } | null,
): ResolvedSelection | null {
  const requestedVendorId = selection?.vendorId ?? null;
  const requestedModelId = selection?.modelId ?? null;

  if (requestedVendorId || requestedModelId) {
    const directModel = getManagedModelById(settings, requestedModelId);
    if (!directModel) {
      return null;
    }

    if (requestedVendorId && directModel.vendorId !== requestedVendorId) {
      return null;
    }

    const directVendor = getVendorById(settings, directModel.vendorId);
    if (!directVendor) {
      return null;
    }

    return { vendor: directVendor, managedModel: directModel };
  }

  return findFirstAvailableSelection(settings);
}

function ensureMinimumResources(settings: AppSettings): AppSettings {
  let vendors = settings.vendors.filter((vendor) => Boolean(vendor.id));
  let managedModels = settings.managedModels.filter((model) => Boolean(model.id));

  if (!vendors.length) {
    vendors = [DEFAULT_SETTINGS.vendors[0]];
  }

  if (!managedModels.length) {
    const fallbackVendor = vendors[0] ?? DEFAULT_SETTINGS.vendors[0];
    managedModels = [
      {
        ...DEFAULT_SETTINGS.managedModels[0],
        vendorId: fallbackVendor.id,
      },
    ];
  }

  return { ...settings, vendors, managedModels };
}

function ensureUniqueManagedModelIds(settings: AppSettings): AppSettings {
  const seenIds = new Set<string>();
  let changed = false;
  const managedModels = settings.managedModels.map((model) => {
    if (!model.id || seenIds.has(model.id)) {
      changed = true;
      let nextId = generateManagedModelId();
      while (seenIds.has(nextId)) {
        nextId = generateManagedModelId();
      }
      seenIds.add(nextId);
      return { ...model, id: nextId };
    }
    seenIds.add(model.id);
    return model;
  });

  return changed ? { ...settings, managedModels } : settings;
}

function withRuntimeSelection(settings: AppSettings, apiKey = settings.apiKey): AppSettings {
  const workspacePath = normalizeWorkspacePath(settings.workspacePath);
  const recentWorkspaces = normalizeRecentWorkspaces(
    settings.recentWorkspaces,
    workspacePath,
  );
  const ensured = ensureMinimumResources({
    ...settings,
    workspacePath,
    recentWorkspaces,
  });
  const normalized = ensureUniqueManagedModelIds(ensured);
  const resolved = resolveManagedModelSelection(normalized, {
    vendorId: normalized.activeVendorId,
    modelId: normalized.activeModelId,
  });

  if (!resolved) {
    return {
      ...DEFAULT_SETTINGS,
      ...normalized,
      apiKey,
    };
  }

  return {
    ...normalized,
    apiKey,
    activeVendorId: resolved.vendor.id,
    activeModelId: resolved.managedModel.id,
    provider: resolved.vendor.name,
    model: resolved.managedModel.name,
    liteLLMBaseUrl: resolved.vendor.baseUrl,
  };
}

export function syncRuntimeSettings(settings: AppSettings, apiKey = settings.apiKey): AppSettings {
  return withRuntimeSelection(settings, apiKey);
}

export function resolveEffectiveContextTokenLimit(
  settings: Pick<AppSettings, "managedModels" | "activeModelId">,
): number {
  const activeModel = getManagedModelById(settings, settings.activeModelId);
  const modelLimit = activeModel?.metaSettings.contextWindowTokens ?? 0;
  return modelLimit > 0 ? modelLimit : 128000;
}

export function updateWorkspacePath(settings: AppSettings, workspacePath: string): AppSettings {
  const normalizedWorkspacePath = normalizeWorkspacePath(workspacePath);
  return syncRuntimeSettings({
    ...settings,
    workspacePath: normalizedWorkspacePath,
    recentWorkspaces: normalizeRecentWorkspaces(
      settings.recentWorkspaces,
      normalizedWorkspacePath,
    ),
  });
}

export function updateToolPermission(
  settings: AppSettings,
  toolKey: keyof AppSettings["toolPermissions"],
  value: ToolPermissionLevel,
): AppSettings {
  return syncRuntimeSettings({
    ...settings,
    toolPermissions: {
      ...settings.toolPermissions,
      [toolKey]: value,
    },
  });
}

export function updateProxySettings(
  settings: AppSettings,
  updates: Partial<ProxySettings>,
): AppSettings {
  return syncRuntimeSettings({
    ...settings,
    proxy: {
      ...settings.proxy,
      ...updates,
    },
  });
}

export function updateContextSettings(
  settings: AppSettings,
  updates: Partial<
    Pick<
      AppSettings,
      | "maxSnippetLines"
      | "sendRelativePathOnly"
    >
  >,
): AppSettings {
  return syncRuntimeSettings({ ...settings, ...updates });
}

export function updateAllowCloudModels(
  settings: AppSettings,
  allowCloudModels: boolean,
): AppSettings {
  return syncRuntimeSettings({ ...settings, allowCloudModels });
}

function resolveLegacyProfileSelection(
  profile: LegacyModelProfile,
  settings: Pick<AppSettings, "vendors" | "managedModels">,
): LegacyProfileSelection | null {
  const directModel = getManagedModelById(settings, typeof profile.modelId === "string" ? profile.modelId : null);
  const directVendor = getVendorById(
    settings,
    directModel?.vendorId ?? (typeof profile.vendorId === "string" ? profile.vendorId : null),
  );
  if (directModel && directVendor) {
    return {
      vendorId: directVendor.id,
      modelId: directModel.id,
      vendorName: directVendor.name,
      modelName: directModel.name,
    };
  }

  const profileModelName = typeof profile.model === "string" ? profile.model.trim() : "";
  const scopedVendorId = typeof profile.vendorId === "string" ? profile.vendorId : null;
  const scopedModels = scopedVendorId
    ? settings.managedModels.filter((entry) => entry.vendorId === scopedVendorId)
    : [];
  const matchedModel =
    (profileModelName ? scopedModels.find((entry) => entry.name === profileModelName) : undefined) ||
    (profileModelName ? settings.managedModels.find((entry) => entry.name === profileModelName) : undefined);
  const matchedVendor =
    getVendorById(settings, matchedModel?.vendorId) ||
    getVendorById(settings, scopedVendorId);
  if (matchedModel && matchedVendor) {
    return {
      vendorId: matchedVendor.id,
      modelId: matchedModel.id,
      vendorName: matchedVendor.name,
      modelName: matchedModel.name,
    };
  }

  const fallback = findFirstAvailableSelection(settings);
  if (!fallback) return null;
  return {
    vendorId: fallback.vendor.id,
    modelId: fallback.managedModel.id,
    vendorName: fallback.vendor.name,
    modelName: fallback.managedModel.name,
  };
}

function migrateLegacyProfilesToManagedResources(parsed: Partial<PersistedSettings>): {
  vendors: VendorConfig[];
  managedModels: ManagedModel[];
  activeVendorId: string | null;
  activeModelId: string | null;
  legacyProfileSelections: Record<string, LegacyProfileSelection>;
} {
  const rawProfiles = Array.isArray((parsed as Record<string, unknown>).profiles)
    ? ((parsed as Record<string, unknown>).profiles as LegacyModelProfile[])
    : [];

  const sourceProfiles = rawProfiles.length > 0
    ? rawProfiles
    : [
      {
        id: "profile-default",
        name: "默认配置",
        provider: parsed.provider,
        model: parsed.model,
        liteLLMBaseUrl: parsed.liteLLMBaseUrl,
      },
    ];

  const vendors: VendorConfig[] = [];
  const managedModels: ManagedModel[] = [];
  const legacyProfileSelections: Record<string, LegacyProfileSelection> = {};

  for (const sourceProfile of sourceProfiles) {
    const profileId = sourceProfile.id?.trim() || `profile-${vendors.length}`;
    const timestamp = sourceProfile.updatedAt || sourceProfile.createdAt || nowIso();
    const vendorId = sourceProfile.vendorId || `vendor-${profileId}`;
    const modelId = sourceProfile.modelId || `model-${profileId}`;
    const vendor: VendorConfig = {
      id: vendorId,
      name:
        sourceProfile.name?.trim() === "默认配置"
          ? "默认供应商"
          : `${sourceProfile.name?.trim() || profileId} 供应商`,
      protocol: "openai-chat-completions",
      baseUrl:
        normalizeBaseUrl(sourceProfile.liteLLMBaseUrl || parsed.liteLLMBaseUrl || DEFAULT_BASE_URL) ||
        DEFAULT_BASE_URL,
      createdAt: sourceProfile.createdAt || timestamp,
      updatedAt: timestamp,
    };
    const managedModel: ManagedModel = {
      id: modelId,
      vendorId,
      name: formatLegacyModelRef(sourceProfile.provider, sourceProfile.model),
      source: "manual",
      supportsThinking: false,
      thinkingLevel: DEFAULT_MANAGED_MODEL_THINKING_LEVEL,
      metaSettings: createDefaultManagedModelMetaSettings(),
      createdAt: sourceProfile.createdAt || timestamp,
      updatedAt: timestamp,
    };

    vendors.push(vendor);
    managedModels.push(managedModel);
    legacyProfileSelections[profileId] = {
      vendorId,
      modelId,
      vendorName: vendor.name,
      modelName: managedModel.name,
    };
  }

  const legacyActiveProfileId =
    typeof (parsed as Record<string, unknown>).activeProfileId === "string"
      ? ((parsed as Record<string, unknown>).activeProfileId as string)
      : null;
  const activeSelection =
    (legacyActiveProfileId ? legacyProfileSelections[legacyActiveProfileId] : undefined) ||
    Object.values(legacyProfileSelections)[0] ||
    null;

  return {
    vendors,
    managedModels,
    activeVendorId: activeSelection?.vendorId ?? null,
    activeModelId: activeSelection?.modelId ?? null,
    legacyProfileSelections,
  };
}

function sanitizePersistedToolPermissions(raw: unknown): ToolPermissions {
  const result: ToolPermissions = { ...DEFAULT_TOOL_PERMISSIONS };
  if (!isRecord(raw)) return result;
  const knownKeys = Object.keys(DEFAULT_TOOL_PERMISSIONS) as Array<keyof ToolPermissions>;
  for (const key of knownKeys) {
    const value = raw[key];
    if (value === "auto" || value === "ask") {
      result[key] = value;
    }
  }
  return result;
}

function normalizeSkillEntries(raw: unknown): SkillEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (item): item is Record<string, unknown> =>
        isRecord(item) && typeof item.id === "string",
    )
    .map((item) => ({
      id: item.id as string,
      name: typeof item.name === "string" ? item.name : "Skill",
      description: typeof item.description === "string" ? item.description : "",
      filePath: typeof item.filePath === "string" ? item.filePath : undefined,
      instructions: typeof item.instructions === "string" ? item.instructions : undefined,
      source: (
        item.source === "global" ||
        item.source === "workspace" ||
        item.source === "cofreerc" ||
        item.source === "custom"
      )
        ? (item.source as SkillEntry["source"])
        : ("custom" as const),
      enabled: item.enabled !== false,
      filePatterns: Array.isArray(item.filePatterns)
        ? item.filePatterns.filter((pattern): pattern is string => typeof pattern === "string")
        : undefined,
      keywords: Array.isArray(item.keywords)
        ? item.keywords.filter((keyword): keyword is string => typeof keyword === "string")
        : undefined,
      createdAt: typeof item.createdAt === "string" ? item.createdAt : nowIso(),
    }));
}

function normalizeLoadedSettings(parsed: Partial<PersistedSettings>): {
  settings: AppSettings;
  legacyProfileSelections: Record<string, LegacyProfileSelection>;
} {
  const normalizedWorkspacePath = normalizeWorkspacePath(parsed.workspacePath);
  const normalizedRecentWorkspaces = normalizeRecentWorkspaces(
    (parsed as Record<string, unknown>).recentWorkspaces,
    normalizedWorkspacePath,
  );
  const normalizedVendors = Array.isArray(parsed.vendors)
    ? parsed.vendors.map(normalizeVendor).filter((value): value is VendorConfig => Boolean(value))
    : [];
  const normalizedManagedModels = Array.isArray(parsed.managedModels)
    ? parsed.managedModels
      .map(normalizeManagedModel)
      .filter((value): value is ManagedModel => Boolean(value))
    : [];

  const legacyMigration = (!normalizedVendors.length || !normalizedManagedModels.length)
    ? migrateLegacyProfilesToManagedResources(parsed)
    : null;

  const baseSettings: AppSettings = {
    ...DEFAULT_SETTINGS,
    ...parsed,
    apiKey: "",
    debugMode: parsed.debugMode === true,
    workspacePath: normalizedWorkspacePath,
    recentWorkspaces: normalizedRecentWorkspaces,
    activeVendorId:
      typeof parsed.activeVendorId === "string"
        ? parsed.activeVendorId
        : legacyMigration?.activeVendorId ?? DEFAULT_SETTINGS.activeVendorId,
    activeModelId:
      typeof parsed.activeModelId === "string"
        ? parsed.activeModelId
        : legacyMigration?.activeModelId ?? DEFAULT_SETTINGS.activeModelId,
    vendors: legacyMigration?.vendors ?? normalizedVendors,
    managedModels: legacyMigration?.managedModels ?? normalizedManagedModels,
    proxy: {
      ...DEFAULT_SETTINGS.proxy,
      ...(isRecord(parsed.proxy) ? parsed.proxy : {}),
    },
    toolPermissions: sanitizePersistedToolPermissions(parsed.toolPermissions),
  };

  const legacyModelContextWindow = normalizeIntegerTokenLimit(
    (parsed as Record<string, unknown>).modelContextWindowTokens,
  );
  const legacyModelMaxOutput = normalizeIntegerTokenLimit(
    (parsed as Record<string, unknown>).modelMaxOutputTokens,
  );
  const hasLegacyModelMeta = legacyModelContextWindow > 0 || legacyModelMaxOutput > 0;
  const withLegacyModelMeta = hasLegacyModelMeta
    ? {
      ...baseSettings,
      managedModels: baseSettings.managedModels.map((model) => {
        const alreadyConfigured =
          model.metaSettings.contextWindowTokens > 0 ||
          model.metaSettings.maxOutputTokens > 0;
        if (alreadyConfigured) {
          return model;
        }
        return {
          ...model,
          metaSettings: {
            ...model.metaSettings,
            contextWindowTokens: legacyModelContextWindow,
            maxOutputTokens: legacyModelMaxOutput,
          },
        };
      }),
    }
    : baseSettings;

  const legacyProfileSelections = legacyMigration?.legacyProfileSelections ?? (() => {
    const rawProfiles = Array.isArray((parsed as Record<string, unknown>).profiles)
      ? ((parsed as Record<string, unknown>).profiles as LegacyModelProfile[])
      : [];
    return Object.fromEntries(
      rawProfiles.flatMap((profile) => {
        const profileId = profile.id?.trim();
        if (!profileId) return [];
        const selection = resolveLegacyProfileSelection(profile, withLegacyModelMeta);
        return selection ? [[profileId, selection]] : [];
      }),
    );
  })();

  const finalSettings: AppSettings = {
    ...withLegacyModelMeta,
    skills: normalizeSkillEntries((parsed as Record<string, unknown>).skills),
  };

  // Strip legacy custom-agent fields that may have been spread in from older
  // persisted settings via `...parsed`. The feature has been removed; leaving
  // the keys around would cause them to be re-serialized on save.
  const record = finalSettings as unknown as Record<string, unknown>;
  delete record.customAgents;
  delete record.builtinAgentOverrides;
  delete record.activeAgentId;

  return {
    settings: syncRuntimeSettings(finalSettings),
    legacyProfileSelections,
  };
}

export function loadSettings(): AppSettings {
  if (typeof window === "undefined") {
    return DEFAULT_SETTINGS;
  }

  const readAndNormalize = (raw: string | null): AppSettings | null => {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<PersistedSettings>;
      const { settings, legacyProfileSelections } = normalizeLoadedSettings(parsed);
      if (Object.keys(legacyProfileSelections).length > 0) {
        migrateLegacyConversationBindings(legacyProfileSelections);
      }
      return settings;
    } catch {
      return null;
    }
  };

  const v3 = readAndNormalize(window.localStorage.getItem(SETTINGS_STORAGE_KEY_V3));
  if (v3) {
    return v3;
  }

  const v2 = readAndNormalize(window.localStorage.getItem(SETTINGS_STORAGE_KEY_V2));
  if (v2) {
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY_V3,
      JSON.stringify({ ...v2, apiKey: "", lastSavedAt: nowIso() }),
    );
    window.localStorage.removeItem(SETTINGS_STORAGE_KEY_V2);
    return v2;
  }

  const v1 = readAndNormalize(window.localStorage.getItem(SETTINGS_STORAGE_KEY));
  if (v1) {
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY_V3,
      JSON.stringify({ ...v1, apiKey: "", lastSavedAt: nowIso() }),
    );
    window.localStorage.removeItem(SETTINGS_STORAGE_KEY);
    return v1;
  }

  return DEFAULT_SETTINGS;
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

  window.localStorage.setItem(SETTINGS_STORAGE_KEY_V3, JSON.stringify(withTimestamp));
}
