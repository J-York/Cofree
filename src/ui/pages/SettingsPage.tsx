/**
 * Cofree - AI Programming Cafe
 * File: src/ui/pages/SettingsPage.tsx
 * Milestone: 2.5
 * Task: 2.5.4
 * Status: Completed
 * Owner: Codex-GPT-5
 * Last Modified: 2026-02-27
 * Description: Settings page for API key persistence, LiteLLM model config, and workspace selection.
 */
import { invoke } from "@tauri-apps/api/core";
import { type ReactElement, useEffect, useState } from "react";
import {
  createLiteLLMClientConfig,
  } from "../../lib/litellm";
import { type AppSettings, maskApiKey } from "../../lib/settingsStore";

interface WorkspaceInfo {
  git_branch?: string;
  repo_name?: string;
}

interface SettingsPageProps {
  settings: AppSettings;
  onSave: (settings: AppSettings) => void;
}

export function SettingsPage({ settings, onSave }: SettingsPageProps): ReactElement {
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [saveMessage, setSaveMessage] = useState<string>("");
  const [workspaceInfo, setWorkspaceInfo] = useState<WorkspaceInfo | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string>("");

  const loadWorkspaceInfo = async (path: string) => {
    if (!path) {
      setWorkspaceInfo(null);
      setWorkspaceError("");
      return;
    }
    try {
      const isGitRepo = await invoke<boolean>("validate_git_repo", { path });
      if (isGitRepo) {
        const info = await invoke<WorkspaceInfo>("get_workspace_info", { path });
        setWorkspaceInfo(info);
        setWorkspaceError("");
      } else {
        setWorkspaceInfo(null);
        setWorkspaceError("选择的目录不是一个有效的 Git 仓库");
      }
    } catch (error) {
      console.error("Failed to load workspace info:", error);
      setWorkspaceInfo(null);
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    loadWorkspaceInfo(draft.workspacePath || "");
  }, [draft.workspacePath]);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  const handleSave = (): void => {
    onSave(draft);
    setSaveMessage("设置已保存到本地存储。敏感动作仍需审批门确认。");
  };

  const handleSelectWorkspace = async () => {
    try {
      const path = await invoke<string | null>("select_workspace_folder");
      if (path) {
        const updatedDraft = { ...draft, workspacePath: path };
        setDraft(updatedDraft);
        onSave(updatedDraft);
      }
    } catch (error) {
      console.error("Failed to select workspace:", error);
      setWorkspaceError("选择工作区失败: " + (error instanceof Error ? error.message : String(error)));
    }
  };

  const runtimeConfig = createLiteLLMClientConfig(draft);

  return (
    <div className="page-stack">
      <article className="panel-card">
        <h2>设置</h2>
        <p className="status-note">用于 Milestone 1 的 API Key 与 LiteLLM 多模型配置。</p>
      </article>

      <article className="panel-card page-stack">
        <h2>工作区设置</h2>
        <div className="inline-row">
          <div style={{ flex: 1 }}>
            <p className="status-note" style={{ margin: 0, fontSize: "1.1em", color: "var(--text-1)" }}>
              {draft.workspacePath || "未选择工作区"}
            </p>
            {workspaceInfo && (
              <p className="status-note" style={{ margin: "0.5rem 0 0 0" }}>
                📦 {workspaceInfo.repo_name} | 🌿 {workspaceInfo.git_branch}
              </p>
            )}
            {workspaceError && (
              <p className="status-note" style={{ margin: "0.5rem 0 0 0", color: "var(--color-error)" }}>
                ⚠️ {workspaceError}
              </p>
            )}
          </div>
          <button className="button" onClick={handleSelectWorkspace} type="button">
            选择工作区
          </button>
        </div>
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
            Model Name
            <input
              className="input"
              value={draft.model}
              onChange={(event) =>
                setDraft((previous) => ({ ...previous, model: event.target.value }))
              }
              placeholder="e.g. openai/gpt-4o"
              type="text"
            />
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
