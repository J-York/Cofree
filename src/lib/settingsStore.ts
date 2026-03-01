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

export interface AppSettings {
  apiKey: string;
  liteLLMBaseUrl: string;
  provider: string;
  model: string;
  allowCloudModels: boolean;
  maxSnippetLines: 200 | 500 | 2000;
  maxContextTokens: number;
  sendRelativePathOnly: boolean;
  lastSavedAt: string | null;
  workspacePath: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  apiKey: "",
  liteLLMBaseUrl: "http://localhost:4000",
  provider: "openai",
  model: defaultModelForProvider("openai"),
  allowCloudModels: true,
  maxSnippetLines: 500,
  maxContextTokens: 128000,
  sendRelativePathOnly: true,
  lastSavedAt: null,
  workspacePath: "",
};

type PersistedSettings = Omit<AppSettings, "apiKey"> & { apiKey?: string };

export function loadSettings(): AppSettings {
  if (typeof window === "undefined") {
    return DEFAULT_SETTINGS;
  }

  const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);

  if (!raw) {
    return DEFAULT_SETTINGS;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<PersistedSettings>;
    const provider = parsed.provider ?? DEFAULT_SETTINGS.provider;
    if (typeof parsed.apiKey === "string" && parsed.apiKey) {
      const migrated: PersistedSettings = {
        ...DEFAULT_SETTINGS,
        ...parsed,
        apiKey: "",
        provider,
        model: parsed.model?.trim() || defaultModelForProvider(provider)
      };
      window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(migrated));
    }

    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      apiKey: "",
      provider,
      model: parsed.model?.trim() || defaultModelForProvider(provider)
    };
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
    lastSavedAt: new Date().toISOString()
  };

  window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(withTimestamp));
}

export async function loadSecureApiKey(): Promise<string> {
  try {
    const value = await invoke<string>("load_secure_api_key");
    return typeof value === "string" ? value : "";
  } catch (_error) {
    return "";
  }
}

export async function saveSecureApiKey(apiKey: string): Promise<void> {
  await invoke("save_secure_api_key", { apiKey });
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
