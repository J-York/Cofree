import { invoke } from "@tauri-apps/api/core";
import { migrateLegacyConversationBindings } from "./conversationMaintenance";
import type { ModelSelection } from "./modelSelection";
import type {
  ChatAgentDefinition,
  ChatAgentOverride,
  SubAgentRole,
  ChatAgentToolPolicy,
} from "../agents/types";

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
  supportsThinking: boolean;
  thinkingLevel: ManagedModelThinkingLevel;
  createdAt: string;
  updatedAt: string;
}

export interface AppSettings {
  apiKey: string;
  liteLLMBaseUrl: string;
  provider?: string;
  model: string;
  debugMode: boolean;
  allowCloudModels: boolean;
  maxSnippetLines: 200 | 500 | 2000;
  maxContextTokens: number;
  sendRelativePathOnly: boolean;
  lastSavedAt: string | null;
  workspacePath: string;
  recentWorkspaces: string[];
  toolPermissions: ToolPermissions;
  proxy: ProxySettings;
  activeVendorId: string | null;
  activeModelId: string | null;
  activeAgentId: string | null;
  vendors: VendorConfig[];
  managedModels: ManagedModel[];
  customAgents: ChatAgentDefinition[];
  builtinAgentOverrides: Record<string, ChatAgentOverride>;
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
    maxContextTokens: 128000,
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
    activeAgentId: null,
    vendors: [defaults.vendor],
    managedModels: [defaults.model],
    customAgents: [],
    builtinAgentOverrides: {},
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

function normalizeModelSelection(
  settings: Pick<AppSettings, "vendors" | "managedModels">,
  selection?: ModelSelection,
): ModelSelection | undefined {
  if (!selection) return undefined;
  const resolved = resolveManagedModelSelection(settings, selection);
  const directModel = getManagedModelById(settings, selection.modelId);
  if (!resolved || !directModel) {
    return undefined;
  }
  return {
    vendorId: resolved.vendor.id,
    modelId: directModel.id,
  };
}

function withNormalizedAgentSelections(settings: AppSettings): AppSettings {
  const customAgents = settings.customAgents.map((agent) => ({
    ...agent,
    modelSelection: normalizeModelSelection(settings, agent.modelSelection),
  }));

  const builtinAgentOverrides = Object.fromEntries(
    Object.entries(settings.builtinAgentOverrides).flatMap(([agentId, override]) => {
      const nextOverride: ChatAgentOverride = { ...override };
      const normalizedSelection = normalizeModelSelection(settings, override.modelSelection);
      if (normalizedSelection) {
        nextOverride.modelSelection = normalizedSelection;
      } else {
        delete nextOverride.modelSelection;
      }
      return Object.keys(nextOverride).length > 0 ? [[agentId, nextOverride]] : [];
    }),
  );

  return {
    ...settings,
    customAgents,
    builtinAgentOverrides,
  };
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

  return withNormalizedAgentSelections({
    ...normalized,
    apiKey,
    activeVendorId: resolved.vendor.id,
    activeModelId: resolved.managedModel.id,
    provider: resolved.vendor.name,
    model: resolved.managedModel.name,
    liteLLMBaseUrl: resolved.vendor.baseUrl,
  });
}

export function syncRuntimeSettings(settings: AppSettings, apiKey = settings.apiKey): AppSettings {
  return withRuntimeSelection(settings, apiKey);
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
    Pick<AppSettings, "maxSnippetLines" | "maxContextTokens" | "sendRelativePathOnly">
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

function isValidSubAgentRole(v: unknown): v is SubAgentRole {
  return v === "planner" || v === "coder" || v === "tester";
}

function normalizeToolPolicy(raw: unknown): ChatAgentToolPolicy {
  if (!isRecord(raw)) return {};
  const result: ChatAgentToolPolicy = {};
  if (Array.isArray(raw.enabledTools)) {
    result.enabledTools = raw.enabledTools.filter((value): value is string => typeof value === "string");
  }
  if (isRecord(raw.toolPermissionOverrides)) {
    result.toolPermissionOverrides = Object.fromEntries(
      Object.entries(raw.toolPermissionOverrides)
        .filter(([, value]) => value === "auto" || value === "ask"),
    ) as ChatAgentToolPolicy["toolPermissionOverrides"];
  }
  return result;
}

function normalizeAgentModelSelection(
  raw: Record<string, unknown>,
  legacyProfileSelections: Record<string, LegacyProfileSelection>,
): ModelSelection | undefined {
  if (isRecord(raw.modelSelection)) {
    const vendorId = typeof raw.modelSelection.vendorId === "string"
      ? raw.modelSelection.vendorId
      : undefined;
    const modelId = typeof raw.modelSelection.modelId === "string"
      ? raw.modelSelection.modelId
      : undefined;
    if (vendorId && modelId) {
      return { vendorId, modelId };
    }
  }

  if (typeof raw.defaultProfileId === "string") {
    const migrated = legacyProfileSelections[raw.defaultProfileId];
    if (migrated) {
      return {
        vendorId: migrated.vendorId,
        modelId: migrated.modelId,
      };
    }
  }

  return undefined;
}

function normalizeCustomAgents(
  raw: unknown,
  legacyProfileSelections: Record<string, LegacyProfileSelection>,
): ChatAgentDefinition[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => isRecord(item) && typeof item.id === "string")
    .map((item) => ({
      id: item.id as string,
      name: typeof item.name === "string" ? item.name : "Agent",
      description: typeof item.description === "string" ? item.description : "",
      icon: typeof item.icon === "string" ? item.icon : undefined,
      systemPromptTemplate:
        typeof item.systemPromptTemplate === "string" ? item.systemPromptTemplate : "",
      toolPolicy: normalizeToolPolicy(item.toolPolicy),
      modelSelection: normalizeAgentModelSelection(item, legacyProfileSelections),
      allowedSubAgents: Array.isArray(item.allowedSubAgents)
        ? (item.allowedSubAgents as unknown[]).filter(isValidSubAgentRole)
        : ["planner", "coder", "tester"],
      handoffPolicy: undefined,
      builtin: false as const,
    }));
}

function normalizeBuiltinAgentOverrides(
  raw: unknown,
  legacyProfileSelections: Record<string, LegacyProfileSelection>,
): Record<string, ChatAgentOverride> {
  if (!isRecord(raw)) return {};
  const result: Record<string, ChatAgentOverride> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    const entry: ChatAgentOverride = {};
    if (typeof value.name === "string") entry.name = value.name;
    if (typeof value.description === "string") entry.description = value.description;
    if (typeof value.systemPromptTemplate === "string") {
      entry.systemPromptTemplate = value.systemPromptTemplate;
    }
    const modelSelection = normalizeAgentModelSelection(value, legacyProfileSelections);
    if (modelSelection) {
      entry.modelSelection = modelSelection;
    }
    if (value.toolPolicy) entry.toolPolicy = normalizeToolPolicy(value.toolPolicy);
    if (Array.isArray(value.allowedSubAgents)) {
      entry.allowedSubAgents = (value.allowedSubAgents as unknown[]).filter(isValidSubAgentRole);
    }
    if (Object.keys(entry).length > 0) result[key] = entry;
  }
  return result;
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

  const baseWithoutAgents: AppSettings = {
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
    activeAgentId:
      typeof (parsed as Record<string, unknown>).activeAgentId === "string"
        ? ((parsed as Record<string, unknown>).activeAgentId as string)
        : null,
    vendors: legacyMigration?.vendors ?? normalizedVendors,
    managedModels: legacyMigration?.managedModels ?? normalizedManagedModels,
    customAgents: [],
    builtinAgentOverrides: {},
    proxy: {
      ...DEFAULT_SETTINGS.proxy,
      ...(isRecord(parsed.proxy) ? parsed.proxy : {}),
    },
    toolPermissions: {
      ...DEFAULT_TOOL_PERMISSIONS,
      ...(isRecord(parsed.toolPermissions) ? parsed.toolPermissions : {}),
    } as ToolPermissions,
  };

  const legacyProfileSelections = legacyMigration?.legacyProfileSelections ?? (() => {
    const rawProfiles = Array.isArray((parsed as Record<string, unknown>).profiles)
      ? ((parsed as Record<string, unknown>).profiles as LegacyModelProfile[])
      : [];
    return Object.fromEntries(
      rawProfiles.flatMap((profile) => {
        const profileId = profile.id?.trim();
        if (!profileId) return [];
        const selection = resolveLegacyProfileSelection(profile, baseWithoutAgents);
        return selection ? [[profileId, selection]] : [];
      }),
    );
  })();

  const withAgents: AppSettings = {
    ...baseWithoutAgents,
    customAgents: normalizeCustomAgents(
      (parsed as Record<string, unknown>).customAgents,
      legacyProfileSelections,
    ),
    builtinAgentOverrides: normalizeBuiltinAgentOverrides(
      (parsed as Record<string, unknown>).builtinAgentOverrides,
      legacyProfileSelections,
    ),
  };

  return {
    settings: syncRuntimeSettings(withAgents),
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

export async function loadSecureApiKey(secretSlot?: string | null): Promise<string> {
  try {
    const value = await invoke<string>("load_secure_api_key", { profileId: secretSlot || null });
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

export async function saveSecureApiKey(apiKey: string, secretSlot?: string | null): Promise<void> {
  await invoke("save_secure_api_key", {
    profileId: secretSlot || null,
    apiKey,
  });
}

export async function deleteSecureApiKey(secretSlot: string): Promise<void> {
  await invoke("delete_secure_api_key", { profileId: secretSlot });
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
    // ignore secure-storage migration failures and still return the recovered key
  }

  return legacyKey;
}

export async function saveVendorApiKey(vendorId: string, apiKey: string): Promise<void> {
  await saveSecureApiKey(apiKey, vendorSecretSlot(vendorId));
}

export async function deleteVendorApiKey(vendorId: string): Promise<void> {
  await deleteSecureApiKey(vendorSecretSlot(vendorId));
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

export function setActiveVendorSelection(settings: AppSettings, vendorId: string): AppSettings {
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

export function setActiveManagedModelSelection(settings: AppSettings, modelId: string): AppSettings {
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

export function switchAgent(settings: AppSettings, agentId: string): AppSettings {
  return { ...settings, activeAgentId: agentId };
}

export function generateAgentId(): string {
  return `agent-custom-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
}

export function createCustomAgent(
  settings: AppSettings,
  params: {
    name: string;
    description?: string;
    systemPromptTemplate?: string;
    enabledTools?: string[];
    allowedSubAgents?: SubAgentRole[];
    modelSelection?: ModelSelection;
    useGlobalModel?: boolean;
  },
): { settings: AppSettings; agent: ChatAgentDefinition } {
  const agent: ChatAgentDefinition = {
    id: generateAgentId(),
    name: params.name.trim() || "新 Agent",
    description: params.description?.trim() || "",
    systemPromptTemplate: params.systemPromptTemplate?.trim() || "",
    toolPolicy: params.enabledTools ? { enabledTools: params.enabledTools } : {},
    modelSelection: normalizeModelSelection(settings, params.modelSelection),
    useGlobalModel: params.useGlobalModel !== undefined ? params.useGlobalModel : true,
    allowedSubAgents: params.allowedSubAgents ?? ["planner", "coder", "tester"],
    builtin: false,
  };
  return {
    agent,
    settings: {
      ...settings,
      customAgents: [...settings.customAgents, agent],
      activeAgentId: agent.id,
    },
  };
}

export function updateCustomAgent(
  settings: AppSettings,
  agentId: string,
  updates: Partial<Omit<ChatAgentDefinition, "id" | "builtin">>,
): AppSettings {
  return syncRuntimeSettings({
    ...settings,
    customAgents: settings.customAgents.map((agent) =>
      agent.id === agentId
        ? {
          ...agent,
          ...updates,
          modelSelection: normalizeModelSelection(
            settings,
            updates.modelSelection ?? agent.modelSelection,
          ),
        }
        : agent,
    ),
  });
}

export function deleteCustomAgent(settings: AppSettings, agentId: string): AppSettings {
  const next = {
    ...settings,
    customAgents: settings.customAgents.filter((agent) => agent.id !== agentId),
  };
  if (next.activeAgentId === agentId) {
    next.activeAgentId = null;
  }
  return next;
}

export function cloneAgentAsCustom(
  settings: AppSettings,
  source: ChatAgentDefinition,
  name: string,
): { settings: AppSettings; agent: ChatAgentDefinition } {
  const agent: ChatAgentDefinition = {
    ...source,
    id: generateAgentId(),
    name: name.trim() || `${source.name} (副本)`,
    builtin: false,
    modelSelection: normalizeModelSelection(settings, source.modelSelection),
  };
  return {
    agent,
    settings: {
      ...settings,
      customAgents: [...settings.customAgents, agent],
      activeAgentId: agent.id,
    },
  };
}

export function updateBuiltinAgentOverride(
  settings: AppSettings,
  agentId: string,
  override: Partial<Omit<ChatAgentDefinition, "id" | "builtin">>,
): AppSettings {
  const normalizedOverride: ChatAgentOverride = {
    ...override,
    modelSelection: normalizeModelSelection(settings, override.modelSelection),
  };
  if (!normalizedOverride.modelSelection) {
    delete normalizedOverride.modelSelection;
  }
  return syncRuntimeSettings({
    ...settings,
    builtinAgentOverrides: {
      ...settings.builtinAgentOverrides,
      [agentId]: { ...settings.builtinAgentOverrides[agentId], ...normalizedOverride },
    },
  });
}

export function resetBuiltinAgentOverride(settings: AppSettings, agentId: string): AppSettings {
  const next = { ...settings.builtinAgentOverrides };
  delete next[agentId];
  return { ...settings, builtinAgentOverrides: next };
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

  const customAgents = settings.customAgents.map((agent) => ({
    ...agent,
    modelSelection:
      agent.modelSelection &&
        (agent.modelSelection.vendorId === removedVendorId ||
          removedModelIds.has(agent.modelSelection.modelId))
        ? undefined
        : agent.modelSelection,
  }));

  const builtinAgentOverrides = Object.fromEntries(
    Object.entries(settings.builtinAgentOverrides).flatMap(([agentId, override]) => {
      const shouldClear =
        override.modelSelection &&
        (override.modelSelection.vendorId === removedVendorId ||
          removedModelIds.has(override.modelSelection.modelId));
      const nextOverride = shouldClear
        ? Object.fromEntries(
          Object.entries(override).filter(([key]) => key !== "modelSelection"),
        )
        : override;
      return Object.keys(nextOverride).length > 0 ? [[agentId, nextOverride]] : [];
    }),
  );

  return {
    ...settings,
    activeVendorId,
    activeModelId,
    customAgents,
    builtinAgentOverrides,
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

  const vendorModels = settings.managedModels.filter((model) => model.vendorId === managedModel.vendorId);
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

export function maskApiKey(key: string): string {
  if (!key) {
    return "未设置";
  }

  if (key.length <= 8) {
    return "*".repeat(key.length);
  }

  return `${key.slice(0, 4)}${"*".repeat(Math.max(4, key.length - 8))}${key.slice(-4)}`;
}
