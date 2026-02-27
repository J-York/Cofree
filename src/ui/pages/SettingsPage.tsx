/**
 * Cofree - AI Programming Cafe
 * File: src/ui/pages/SettingsPage.tsx
 * Milestone: 1
 * Task: 1.3
 * Status: Completed
 * Owner: Codex-GPT-5
 * Last Modified: 2026-02-27
 * Description: Settings page for API key persistence and LiteLLM model config.
 */

import { type ReactElement, useEffect, useMemo, useState } from "react";
import {
  MODEL_PROVIDERS,
  createLiteLLMClientConfig,
  defaultModelForProvider,
  listModelsByProvider
} from "../../lib/litellm";
import { type AppSettings, maskApiKey } from "../../lib/settingsStore";

interface SettingsPageProps {
  settings: AppSettings;
  onSave: (settings: AppSettings) => void;
}

export function SettingsPage({ settings, onSave }: SettingsPageProps): ReactElement {
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [saveMessage, setSaveMessage] = useState<string>("");

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  const availableModels = useMemo(
    () => listModelsByProvider(draft.provider),
    [draft.provider]
  );

  const handleProviderChange = (provider: string): void => {
    setDraft((previous) => ({
      ...previous,
      provider,
      model: defaultModelForProvider(provider)
    }));
  };

  const handleSave = (): void => {
    onSave(draft);
    setSaveMessage("设置已保存到本地存储。敏感动作仍需审批门确认。");
  };

  const runtimeConfig = createLiteLLMClientConfig(draft);

  return (
    <div className="page-stack">
      <article className="panel-card">
        <h2>设置</h2>
        <p className="status-note">用于 Milestone 1 的 API Key 与 LiteLLM 多模型配置。</p>
      </article>

      <article className="panel-card page-stack">
        <label>
          LiteLLM Base URL
          <input
            className="input"
            value={draft.liteLLMBaseUrl}
            onChange={(event) =>
              setDraft((previous) => ({ ...previous, liteLLMBaseUrl: event.target.value }))
            }
            placeholder="http://localhost:4000"
            type="text"
          />
        </label>

        <label>
          API Key
          <input
            className="input"
            value={draft.apiKey}
            onChange={(event) =>
              setDraft((previous) => ({ ...previous, apiKey: event.target.value.trim() }))
            }
            placeholder="sk-..."
            type="password"
          />
        </label>

        <div className="inline-row">
          <label>
            Provider
            <select
              className="select"
              value={draft.provider}
              onChange={(event) => handleProviderChange(event.target.value)}
            >
              {MODEL_PROVIDERS.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.label}
                </option>
              ))}
            </select>
          </label>

          <label>
            Model
            <select
              className="select"
              value={draft.model}
              onChange={(event) =>
                setDraft((previous) => ({ ...previous, model: event.target.value }))
              }
            >
              {availableModels.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="inline-row">
          <label>
            Max snippet lines
            <select
              className="select"
              value={draft.maxSnippetLines}
              onChange={(event) =>
                setDraft((previous) => ({
                  ...previous,
                  maxSnippetLines: Number(event.target.value) as AppSettings["maxSnippetLines"]
                }))
              }
            >
              <option value={200}>200</option>
              <option value={500}>500</option>
              <option value={2000}>2000</option>
            </select>
          </label>

          <label>
            Path egress mode
            <select
              className="select"
              value={draft.sendRelativePathOnly ? "relative" : "full"}
              onChange={(event) =>
                setDraft((previous) => ({
                  ...previous,
                  sendRelativePathOnly: event.target.value === "relative"
                }))
              }
            >
              <option value="relative">Relative only (default)</option>
              <option value="full">Allow full path</option>
            </select>
          </label>
        </div>

        <label>
          <input
            checked={draft.allowCloudModels}
            onChange={(event) =>
              setDraft((previous) => ({ ...previous, allowCloudModels: event.target.checked }))
            }
            type="checkbox"
          />
          {" "}Allow cloud models
        </label>

        <div className="actions">
          <button className="button" onClick={handleSave} type="button">
            保存设置
          </button>
          <button
            className="button secondary"
            onClick={() => {
              setDraft(settings);
              setSaveMessage("已重置到最近保存版本。");
            }}
            type="button"
          >
            重置
          </button>
        </div>

        <p className="status-note">当前 API Key：{maskApiKey(draft.apiKey)}</p>
        <p className="status-note">LiteLLM Endpoint：{runtimeConfig.endpoint}</p>
        {saveMessage ? <p className="status-note">{saveMessage}</p> : null}
      </article>
    </div>
  );
}
