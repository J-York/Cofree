import { invoke } from "@tauri-apps/api/core";
import { type ReactElement, useEffect, useState } from "react";
import { createLiteLLMClientConfig, formatModelRef, parseModelRef } from "../../lib/litellm";
import {
  type AppSettings,
  type ToolPermissionLevel,
  DEFAULT_TOOL_PERMISSIONS,
  maskApiKey
} from "../../lib/settingsStore";

interface WorkspaceInfo {
  git_branch?: string;
  repo_name?: string;
}

interface SettingsPageProps {
  settings: AppSettings;
  onSave: (settings: AppSettings) => Promise<void>;
}

export function SettingsPage({ settings, onSave }: SettingsPageProps): ReactElement {
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [saveMessage, setSaveMessage] = useState<string>("");
  const [workspaceInfo, setWorkspaceInfo] = useState<WorkspaceInfo | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string>("");

  const loadWorkspaceInfo = async (path: string) => {
    if (!path) { setWorkspaceInfo(null); setWorkspaceError(""); return; }
    try {
      const info = await invoke<WorkspaceInfo>("get_workspace_info", { path });
      setWorkspaceInfo(info);
      setWorkspaceError("");
    } catch (error) {
      setWorkspaceInfo(null);
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => { void loadWorkspaceInfo(draft.workspacePath || ""); }, [draft.workspacePath]);
  useEffect(() => { setDraft(settings); }, [settings]);

  const handleSave = async (): Promise<void> => {
    const parsed = parseModelRef(draft.model);
    const normalized = {
      ...draft,
      provider: parsed.provider || draft.provider || undefined,
      model: parsed.model || draft.model
    };
    try {
      await onSave(normalized);
      setSaveMessage("已保存");
      setTimeout(() => setSaveMessage(""), 3000);
    } catch (error) {
      setSaveMessage(`保存失败：${error instanceof Error ? error.message : String(error)}`);
      setTimeout(() => setSaveMessage(""), 4000);
    }
  };

  const handleSelectWorkspace = async () => {
    try {
      const path = await invoke<string | null>("select_workspace_folder");
      if (path) {
        const updated = { ...draft, workspacePath: path };
        setDraft(updated);
        await onSave(updated);
      }
    } catch (error) {
      setWorkspaceError("选择工作区失败: " + (error instanceof Error ? error.message : String(error)));
    }
  };

  const runtimeConfig = createLiteLLMClientConfig(draft);

  return (
    <div className="page-content">
      <div className="page-header">
        <h1 className="page-title">设置</h1>
        <p className="page-subtitle">API 密钥、模型配置与工作区管理</p>
      </div>

      {/* Workspace */}
      <div className="card">
        <p className="card-title">工作区</p>
        <div className="workspace-card">
          <div className="workspace-icon">📁</div>
          <div className="workspace-info">
            <p className="workspace-path">
              {draft.workspacePath || "未选择工作区"}
            </p>
            {workspaceInfo?.git_branch && (
              <p className="workspace-meta">
                {workspaceInfo.repo_name && `📦 ${workspaceInfo.repo_name} · `}🌿 {workspaceInfo.git_branch}
              </p>
            )}
            {workspaceError && (
              <p className="workspace-meta" style={{ color: "var(--color-error)" }}>
                ⚠ {workspaceError}
              </p>
            )}
          </div>
          <button className="btn btn-ghost btn-sm" onClick={handleSelectWorkspace} type="button">
            选择目录
          </button>
        </div>
      </div>

      {/* Model config */}
      <div className="card settings-section">
        <p className="settings-section-title">模型配置</p>

        <div className="field">
          <label className="field-label">LiteLLM Base URL</label>
          <input
            className="input"
            value={draft.liteLLMBaseUrl}
            onChange={(e) => setDraft((p) => ({ ...p, liteLLMBaseUrl: e.target.value }))}
            placeholder="http://localhost:4000"
            type="text"
          />
        </div>

        <div className="field">
          <label className="field-label">API Key</label>
          <input
            className="input"
            value={draft.apiKey}
            onChange={(e) => setDraft((p) => ({ ...p, apiKey: e.target.value.trim() }))}
            placeholder="sk-..."
            type="password"
          />
          <div className="api-key-display">{maskApiKey(draft.apiKey)}</div>
        </div>

        <div className="field">
          <label className="field-label">Model Name</label>
          <input
            className="input"
            value={formatModelRef(draft.provider || "", draft.model)}
            onChange={(e) => {
              const input = e.target.value;
              const parsed = parseModelRef(input);
              setDraft((p) => ({
                ...p,
                provider: parsed.provider,
                model: parsed.model
              }));
            }}
            placeholder="e.g. openai/gpt-4o"
            type="text"
          />
        </div>

        <div className="grid-2">
          <div className="field">
            <label className="field-label">Max Snippet Lines</label>
            <select
              className="select"
              value={draft.maxSnippetLines}
              onChange={(e) =>
                setDraft((p) => ({
                  ...p,
                  maxSnippetLines: Number(e.target.value) as AppSettings["maxSnippetLines"],
                }))
              }
            >
              <option value={200}>200</option>
              <option value={500}>500</option>
              <option value={2000}>2000</option>
            </select>
          </div>

          <div className="field">
            <label className="field-label">Max Context Tokens</label>
            <input
              type="number"
              className="input"
              placeholder="Default: 128000"
              value={draft.maxContextTokens || ""}
              onChange={(e) =>
                setDraft((p) => ({
                  ...p,
                  maxContextTokens: Number(e.target.value) || 128000,
                }))
              }
            />
            <span className="field-hint" style={{ fontSize: "11px", color: "var(--text-3)", marginTop: "4px", display: "block" }}>Used for truncating chat history</span>
          </div>

          <div className="field">
            <label className="field-label">Path Egress Mode</label>
            <select
              className="select"
              value={draft.sendRelativePathOnly ? "relative" : "full"}
              onChange={(e) =>
                setDraft((p) => ({ ...p, sendRelativePathOnly: e.target.value === "relative" }))
              }
            >
              <option value="relative">Relative only (default)</option>
              <option value="full">Allow full path</option>
            </select>
          </div>
        </div>

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={draft.allowCloudModels}
            onChange={(e) => setDraft((p) => ({ ...p, allowCloudModels: e.target.checked }))}
          />
          <span className="checkbox-label">允许云端模型</span>
        </label>
      </div>

      {/* Tool Permissions */}
      <div className="card settings-section">
        <p className="settings-section-title">工具权限</p>

        <p className="field-label" style={{ marginBottom: "8px" }}>只读工具</p>
        {(["list_files", "read_file", "grep", "glob", "git_status", "git_diff"] as const).map((toolName) => {
          const descriptions: Record<string, string> = {
            list_files: "列出目录文件",
            read_file: "读取文件内容",
            grep: "正则搜索文件内容",
            glob: "Glob 模式匹配文件路径",
            git_status: "查看 Git 状态",
            git_diff: "查看 Git 差异",
          };
          const permissions = draft.toolPermissions ?? DEFAULT_TOOL_PERMISSIONS;
          return (
            <div key={toolName} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 0" }}>
              <span style={{ fontSize: "13px" }}>
                <code style={{ fontSize: "12px", background: "var(--bg-2)", padding: "1px 4px", borderRadius: "3px" }}>{toolName}</code>
                <span style={{ color: "var(--text-3)", marginLeft: "6px" }}>{descriptions[toolName]}</span>
              </span>
              <select
                className="select"
                style={{ width: "120px", fontSize: "12px" }}
                value={permissions[toolName]}
                onChange={(e) =>
                  setDraft((p) => ({
                    ...p,
                    toolPermissions: {
                      ...(p.toolPermissions ?? DEFAULT_TOOL_PERMISSIONS),
                      [toolName]: e.target.value as ToolPermissionLevel,
                    },
                  }))
                }
              >
                <option value="auto">自动执行</option>
                <option value="ask">需要审批</option>
              </select>
            </div>
          );
        })}

        <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "12px 0" }} />

        <p className="field-label" style={{ marginBottom: "8px" }}>写入工具</p>
        {(["propose_file_edit", "propose_apply_patch", "propose_shell"] as const).map((toolName) => {
          const descriptions: Record<string, string> = {
            propose_file_edit: "结构化文件编辑",
            propose_apply_patch: "应用 Patch 补丁",
            propose_shell: "执行 Shell 命令",
          };
          const permissions = draft.toolPermissions ?? DEFAULT_TOOL_PERMISSIONS;
          return (
            <div key={toolName} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 0" }}>
              <span style={{ fontSize: "13px" }}>
                <code style={{ fontSize: "12px", background: "var(--bg-2)", padding: "1px 4px", borderRadius: "3px" }}>{toolName}</code>
                <span style={{ color: "var(--text-3)", marginLeft: "6px" }}>{descriptions[toolName]}</span>
              </span>
              <select
                className="select"
                style={{ width: "120px", fontSize: "12px" }}
                value={permissions[toolName]}
                onChange={(e) =>
                  setDraft((p) => ({
                    ...p,
                    toolPermissions: {
                      ...(p.toolPermissions ?? DEFAULT_TOOL_PERMISSIONS),
                      [toolName]: e.target.value as ToolPermissionLevel,
                    },
                  }))
                }
              >
                <option value="auto">自动执行</option>
                <option value="ask">需要审批</option>
              </select>
            </div>
          );
        })}

        <p style={{ fontSize: "11px", color: "var(--color-warning, #e6a700)", marginTop: "12px", lineHeight: "1.5" }}>
          ⚠ 将写入工具设为自动执行意味着 LLM 可以直接修改文件和执行命令，请确保你信任当前使用的模型。
        </p>
      </div>

      {/* Runtime info */}
      <div className="card card-sm">
        <p className="card-title">运行时信息</p>
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <div className="api-key-display">Endpoint: {runtimeConfig.endpoint}</div>
        </div>
      </div>

      {/* Actions */}
      <div className="btn-row">
        <button className="btn btn-primary" onClick={() => void handleSave()} type="button">
          保存设置
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => { setDraft(settings); setSaveMessage("已重置"); setTimeout(() => setSaveMessage(""), 2000); }}
          type="button"
        >
          重置
        </button>
        {saveMessage && (
          <span className="save-feedback">✓ {saveMessage}</span>
        )}
      </div>
    </div>
  );
}
