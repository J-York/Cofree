/**
 * Cofree - AI Programming Cafe
 * File: src/lib/settingsStore.ts
 * Milestone: 1
 * Task: 1.3
 * Status: Completed
 * Owner: Codex-GPT-5
 * Last Modified: 2026-02-27
 * Description: Local persistence for API key and model settings.
 */

import { invoke } from "@tauri-apps/api/core";
import { defaultModelForProvider } from "./litellm";

export const SETTINGS_STORAGE_KEY = "cofree.settings.v1";
export const SETTINGS_STORAGE_KEY_V2 = "cofree.settings.v2";

export type ToolPermissionLevel = "auto" | "ask";

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

export type ProxyMode = "off" | "http" | "https" | "socks5";

export interface ProxySettings {
  mode: ProxyMode;
  url: string; // e.g. http://127.0.0.1:7890, socks5://127.0.0.1:1080
  username?: string;
  password?: string;
  // Comma-separated host patterns, e.g. "localhost,127.0.0.1,*.local"
  // (We keep it as a string to simplify the UI; Rust side can split/trim.)
  noProxy?: string;
}

/** 单个模型配置档案 */
export interface ModelProfile {
  id: string;                   // 唯一ID: "profile-{timestamp}"
  name: string;                 // 用户命名: "Claude 日常", "GPT-4 生产"
  provider?: string;            // 供应商: "anthropic", "openai", "ollama"
  model: string;                // 模型名
  liteLLMBaseUrl: string;       // Base URL
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
  // V2 新增字段
  activeProfileId: string | null;
  profiles: ModelProfile[];
}

export const DEFAULT_SETTINGS: AppSettings = {
  apiKey: "",
  liteLLMBaseUrl: "http://localhost:4000",
  model: defaultModelForProvider("openai"),
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
  activeProfileId: null,
  profiles: [],
};

type PersistedSettings = Omit<AppSettings, "apiKey"> & { apiKey?: string };

/** 生成唯一的 profile ID */
export function generateProfileId(): string {
  return `profile-${Date.now()}`;
}

/** 创建默认的 profile */
export function createDefaultProfile(
  id: string,
  name: string,
  baseUrl: string,
  provider?: string,
  model?: string
): ModelProfile {
  const now = new Date().toISOString();
  return {
    id,
    name,
    provider,
    model: model || defaultModelForProvider(provider || "openai"),
    liteLLMBaseUrl: baseUrl,
    createdAt: now,
    updatedAt: now,
  };
}

/** 从 V1 设置迁移到 V2 */
function migrateSettingsV1ToV2(v1Settings: Partial<PersistedSettings>): AppSettings {
  const legacyProfileId = "profile-legacy";
  const now = new Date().toISOString();

  const legacyProfile: ModelProfile = {
    id: legacyProfileId,
    name: "默认配置",
    provider: v1Settings.provider,
    model: v1Settings.model?.trim() || defaultModelForProvider(v1Settings.provider || "openai"),
    liteLLMBaseUrl: v1Settings.liteLLMBaseUrl || DEFAULT_SETTINGS.liteLLMBaseUrl,
    createdAt: now,
    updatedAt: now,
  };

  return {
    ...DEFAULT_SETTINGS,
    ...v1Settings,
    apiKey: "",
    activeProfileId: legacyProfileId,
    profiles: [legacyProfile],
  };
}

export function loadSettings(): AppSettings {
  if (typeof window === "undefined") {
    return DEFAULT_SETTINGS;
  }

  // 优先尝试加载 V2 设置
  const rawV2 = window.localStorage.getItem(SETTINGS_STORAGE_KEY_V2);
  if (rawV2) {
    try {
      const parsed = JSON.parse(rawV2) as Partial<PersistedSettings>;
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        apiKey: "",
        profiles: parsed.profiles || [],
        activeProfileId: parsed.activeProfileId || null,
      };
    } catch (_error) {
      // V2 解析失败，继续尝试 V1
    }
  }

  // 尝试加载 V1 设置并迁移
  const rawV1 = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
  if (!rawV1) {
    return DEFAULT_SETTINGS;
  }

  try {
    const parsed = JSON.parse(rawV1) as Partial<PersistedSettings>;
    const migrated = migrateSettingsV1ToV2(parsed);

    // 保存迁移后的 V2 设置
    window.localStorage.setItem(SETTINGS_STORAGE_KEY_V2, JSON.stringify({
      ...migrated,
      apiKey: "",
      lastSavedAt: new Date().toISOString(),
    }));

    // 删除旧的 V1 设置
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
    ...settings,
    apiKey: "",
    lastSavedAt: new Date().toISOString(),
  };

  window.localStorage.setItem(
    SETTINGS_STORAGE_KEY_V2,
    JSON.stringify(withTimestamp)
  );
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

// ─────────────────────────────────────────────────────────────────────────────
// Profile CRUD 操作
// ─────────────────────────────────────────────────────────────────────────────

/** 创建新的配置档案 */
export function createProfile(
  settings: AppSettings,
  name: string,
  baseUrl: string,
  provider?: string,
  model?: string
): { settings: AppSettings; profile: ModelProfile } {
  const id = generateProfileId();
  const profile = createDefaultProfile(id, name, baseUrl, provider, model);

  const newSettings: AppSettings = {
    ...settings,
    profiles: [...settings.profiles, profile],
    activeProfileId: id,
  };

  return { settings: newSettings, profile };
}

/** 更新配置档案 */
export function updateProfile(
  settings: AppSettings,
  profileId: string,
  updates: Partial<Omit<ModelProfile, "id" | "createdAt">>
): AppSettings {
  const profiles = settings.profiles.map((p) =>
    p.id === profileId
      ? { ...p, ...updates, updatedAt: new Date().toISOString() }
      : p
  );

  return { ...settings, profiles };
}

/** 删除配置档案 */
export function deleteProfile(
  settings: AppSettings,
  profileId: string
): AppSettings {
  const profiles = settings.profiles.filter((p) => p.id !== profileId);

  // 如果删除的是当前激活的配置，切换到第一个可用的配置
  let activeProfileId = settings.activeProfileId;
  if (activeProfileId === profileId) {
    activeProfileId = profiles.length > 0 ? profiles[0].id : null;
  }

  return { ...settings, profiles, activeProfileId };
}

/** 切换到指定的配置档案 */
export function switchProfile(
  settings: AppSettings,
  profileId: string
): AppSettings {
  const profile = settings.profiles.find((p) => p.id === profileId);
  if (!profile) {
    return settings;
  }

  return {
    ...settings,
    activeProfileId: profileId,
    // 同步 profile 的配置到顶层设置
    provider: profile.provider,
    model: profile.model,
    liteLLMBaseUrl: profile.liteLLMBaseUrl,
  };
}

/** 获取当前激活的配置档案 */
export function getActiveProfile(settings: AppSettings): ModelProfile | null {
  if (!settings.activeProfileId) {
    return null;
  }
  return settings.profiles.find((p) => p.id === settings.activeProfileId) || null;
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
