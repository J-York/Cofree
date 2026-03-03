import { invoke } from "@tauri-apps/api/core";
import { type ReactElement, useEffect, useState } from "react";
import {
  createLiteLLMClientConfig,
  formatModelRef,
  parseModelRef,
} from "../../lib/litellm";
import {
  type AppSettings,
  type ModelProfile,
  type ToolPermissionLevel,
  DEFAULT_TOOL_PERMISSIONS,
  createProfile,
  deleteProfile,
  deleteSecureApiKey,
  getActiveProfile,
  loadSecureApiKey,
  maskApiKey,
  switchProfile,
  updateProfile,
} from "../../lib/settingsStore";
import { clearAllConversations } from "../../lib/conversationStore";

interface WorkspaceInfo {
  git_branch?: string;
  repo_name?: string;
}

interface SettingsPageProps {
  settings: AppSettings;
  onSave: (settings: AppSettings) => Promise<void>;
}

export function SettingsPage({
  settings,
  onSave,
}: SettingsPageProps): ReactElement {
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [saveMessage, setSaveMessage] = useState<string>("");
  const [workspaceInfo, setWorkspaceInfo] = useState<WorkspaceInfo | null>(
    null
  );
  const [workspaceError, setWorkspaceError] = useState<string>("");
  const [confirmClear, setConfirmClear] = useState<boolean>(false);

  // Profile management states
  const [showNewProfile, setShowNewProfile] = useState(false);
  const [newProfileName, setNewProfileName] = useState("");
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [editingProfileName, setEditingProfileName] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const loadWorkspaceInfo = async (path: string) => {
    if (!path) {
      setWorkspaceInfo(null);
      setWorkspaceError("");
      return;
    }
    try {
      const info = await invoke<WorkspaceInfo>("get_workspace_info", { path });
      setWorkspaceInfo(info);
      setWorkspaceError("");
    } catch (error) {
      setWorkspaceInfo(null);
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    void loadWorkspaceInfo(draft.workspacePath || "");
  }, [draft.workspacePath]);
  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  const activeProfile = getActiveProfile(draft);

  const handleSave = async (): Promise<void> => {
    let settingsToSave = { ...draft };

    // Sync top-level model config back to active profile
    if (settingsToSave.activeProfileId) {
      settingsToSave = updateProfile(
        settingsToSave,
        settingsToSave.activeProfileId,
        {
          provider: settingsToSave.provider,
          model: settingsToSave.model,
          liteLLMBaseUrl: settingsToSave.liteLLMBaseUrl,
        }
      );
    }

    const parsed = parseModelRef(settingsToSave.model);
    const normalized = {
      ...settingsToSave,
      provider: parsed.provider || settingsToSave.provider || undefined,
      model: parsed.model || settingsToSave.model,
    };
    try {
      await onSave(normalized);
      setSaveMessage("已保存");
      setTimeout(() => setSaveMessage(""), 3000);
    } catch (error) {
      setSaveMessage(
        `保存失败：${error instanceof Error ? error.message : String(error)}`
      );
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
      setWorkspaceError(
        "选择工作区失败: " +
          (error instanceof Error ? error.message : String(error))
      );
    }
  };

  const handleCreateProfile = () => {
    const name = newProfileName.trim() || "新配置";
    const { settings: newSettings } = createProfile(
      draft,
      name,
      draft.liteLLMBaseUrl,
      draft.provider,
      draft.model
    );
    // New profile starts with empty API key
    setDraft({ ...newSettings, apiKey: "" });
    setShowNewProfile(false);
    setNewProfileName("");
  };

  const handleSwitchProfile = async (profileId: string) => {
    if (profileId === draft.activeProfileId) return;
    const switched = switchProfile(draft, profileId);
    try {
      const apiKey = await loadSecureApiKey(profileId);
      setDraft({ ...switched, apiKey });
    } catch {
      setDraft({ ...switched, apiKey: "" });
    }
  };

  const handleDeleteProfile = async (profileId: string) => {
    if (draft.profiles.length <= 1) return; // Don't delete the last profile
    const newSettings = deleteProfile(draft, profileId);
    try {
      await deleteSecureApiKey(profileId);
    } catch {
      // Ignore keychain errors on delete
    }
    // If active profile changed, load new active's API key
    if (
      newSettings.activeProfileId !== draft.activeProfileId &&
      newSettings.activeProfileId
    ) {
      try {
        const apiKey = await loadSecureApiKey(newSettings.activeProfileId);
        setDraft({ ...newSettings, apiKey });
      } catch {
        setDraft({ ...newSettings, apiKey: "" });
      }
    } else {
      setDraft(newSettings);
    }
    setConfirmDeleteId(null);
  };

  const handleRenameProfile = (profileId: string) => {
    const name = editingProfileName.trim();
    if (!name) {
      setEditingProfileId(null);
      return;
    }
    setDraft((prev) => updateProfile(prev, profileId, { name }));
    setEditingProfileId(null);
    setEditingProfileName("");
  };

  const runtimeConfig = createLiteLLMClientConfig(draft);

  return (
    <div className="page-content">
      <div className="page-header">
        <h1 className="page-title">设置</h1>
        <p className="page-subtitle">配置档案、模型设置与工作区管理</p>
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
                {workspaceInfo.repo_name && `📦 ${workspaceInfo.repo_name} · `}
                🌿 {workspaceInfo.git_branch}
              </p>
            )}
            {workspaceError && (
              <p
                className="workspace-meta"
                style={{ color: "var(--color-error)" }}
              >
                ⚠ {workspaceError}
              </p>
            )}
          </div>
          <button
            className="btn btn-ghost btn-sm"
            onClick={handleSelectWorkspace}
            type="button"
          >
            选择目录
          </button>
        </div>
      </div>

      {/* Profile Management */}
      <div className="card settings-section">
        <p className="settings-section-title">配置档案</p>

        {draft.profiles.length > 0 ? (
          <div className="profile-list">
            {draft.profiles.map((profile) => (
              <ProfileCard
                key={profile.id}
                profile={profile}
                isActive={profile.id === draft.activeProfileId}
                isEditing={editingProfileId === profile.id}
                editingName={editingProfileName}
                confirmDelete={confirmDeleteId === profile.id}
                canDelete={draft.profiles.length > 1}
                onSwitch={() => void handleSwitchProfile(profile.id)}
                onStartEdit={() => {
                  setEditingProfileId(profile.id);
                  setEditingProfileName(profile.name);
                }}
                onEditNameChange={setEditingProfileName}
                onSaveEdit={() => handleRenameProfile(profile.id)}
                onCancelEdit={() => {
                  setEditingProfileId(null);
                  setEditingProfileName("");
                }}
                onConfirmDelete={() => setConfirmDeleteId(profile.id)}
                onDelete={() => void handleDeleteProfile(profile.id)}
                onCancelDelete={() => setConfirmDeleteId(null)}
              />
            ))}
          </div>
        ) : (
          <p className="profile-empty-hint">
            暂无配置档案，创建第一个配置以开始使用
          </p>
        )}

        {showNewProfile ? (
          <div className="profile-new-form">
            <input
              className="input"
              value={newProfileName}
              onChange={(e) => setNewProfileName(e.target.value)}
              placeholder="配置名称，如 Claude 日常"
              type="text"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreateProfile();
                if (e.key === "Escape") {
                  setShowNewProfile(false);
                  setNewProfileName("");
                }
              }}
            />
            <div className="btn-row">
              <button
                className="btn btn-primary btn-sm"
                onClick={handleCreateProfile}
                type="button"
              >
                创建
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setShowNewProfile(false);
                  setNewProfileName("");
                }}
                type="button"
              >
                取消
              </button>
            </div>
          </div>
        ) : (
          <button
            className="btn btn-ghost btn-sm profile-add-btn"
            onClick={() => setShowNewProfile(true)}
            type="button"
          >
            + 新建配置档案
          </button>
        )}
      </div>

      {/* Model config — edits the active profile */}
      <div className="card settings-section">
        <p className="settings-section-title">
          模型配置
          {activeProfile && (
            <span className="settings-section-tag">{activeProfile.name}</span>
          )}
        </p>

        {/* Proxy config */}
        <div className="field" style={{ marginTop: "14px" }}>
          <label className="field-label">代理（影响所有网络请求）</label>
          <div className="grid-2">
            <select
              className="select"
              value={draft.proxy.mode}
              onChange={(e) =>
                setDraft((p) => ({
                  ...p,
                  proxy: {
                    ...p.proxy,
                    mode: e.target.value as typeof p.proxy.mode,
                  },
                }))
              }
            >
              <option value="off">关闭</option>
              <option value="http">HTTP</option>
              <option value="https">HTTPS</option>
              <option value="socks5">SOCKS5</option>
            </select>

            <input
              className="input"
              value={draft.proxy.url}
              onChange={(e) =>
                setDraft((p) => ({
                  ...p,
                  proxy: { ...p.proxy, url: e.target.value },
                }))
              }
              placeholder="http://127.0.0.1:7890 / socks5://127.0.0.1:1080"
              type="text"
            />
          </div>

          <div className="grid-2" style={{ marginTop: "8px" }}>
            <input
              className="input"
              value={draft.proxy.username ?? ""}
              onChange={(e) =>
                setDraft((p) => ({
                  ...p,
                  proxy: { ...p.proxy, username: e.target.value },
                }))
              }
              placeholder="用户名（可选）"
              type="text"
              autoComplete="off"
            />
            <input
              className="input"
              value={draft.proxy.password ?? ""}
              onChange={(e) =>
                setDraft((p) => ({
                  ...p,
                  proxy: { ...p.proxy, password: e.target.value },
                }))
              }
              placeholder="密码（可选）"
              type="password"
              autoComplete="off"
            />
          </div>

          <input
            className="input"
            style={{ marginTop: "8px" }}
            value={draft.proxy.noProxy ?? ""}
            onChange={(e) =>
              setDraft((p) => ({
                ...p,
                proxy: { ...p.proxy, noProxy: e.target.value },
              }))
            }
            placeholder="No Proxy（可选）：localhost,127.0.0.1,*.local"
            type="text"
          />
        </div>

        <div className="field">
          <label className="field-label">LiteLLM Base URL</label>
          <input
            className="input"
            value={draft.liteLLMBaseUrl}
            onChange={(e) =>
              setDraft((p) => ({ ...p, liteLLMBaseUrl: e.target.value }))
            }
            placeholder="http://localhost:4000"
            type="text"
          />
        </div>

        <div className="field">
          <label className="field-label">API Key</label>
          <input
            className="input"
            value={draft.apiKey}
            onChange={(e) =>
              setDraft((p) => ({ ...p, apiKey: e.target.value.trim() }))
            }
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
                model: parsed.model,
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
                  maxSnippetLines: Number(
                    e.target.value
                  ) as AppSettings["maxSnippetLines"],
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
            <span
              className="field-hint"
              style={{
                fontSize: "11px",
                color: "var(--text-3)",
                marginTop: "4px",
                display: "block",
              }}
            >
              Used for truncating chat history
            </span>
          </div>

          <div className="field">
            <label className="field-label">Path Egress Mode</label>
            <select
              className="select"
              value={draft.sendRelativePathOnly ? "relative" : "full"}
              onChange={(e) =>
                setDraft((p) => ({
                  ...p,
                  sendRelativePathOnly: e.target.value === "relative",
                }))
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
            onChange={(e) =>
              setDraft((p) => ({ ...p, allowCloudModels: e.target.checked }))
            }
          />
          <span className="checkbox-label">允许云端模型</span>
        </label>
      </div>

      {/* Tool Permissions */}
      <div className="card settings-section">
        <p className="settings-section-title">工具权限</p>

        <p className="field-label" style={{ marginBottom: "8px" }}>
          只读工具
        </p>
        {(
          [
            "list_files",
            "read_file",
            "grep",
            "glob",
            "git_status",
            "git_diff",
          ] as const
        ).map((toolName) => {
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
            <div
              key={toolName}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "4px 0",
              }}
            >
              <span style={{ fontSize: "13px" }}>
                <code
                  style={{
                    fontSize: "12px",
                    background: "var(--bg-2)",
                    padding: "1px 4px",
                    borderRadius: "3px",
                  }}
                >
                  {toolName}
                </code>
                <span style={{ color: "var(--text-3)", marginLeft: "6px" }}>
                  {descriptions[toolName]}
                </span>
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

        <hr
          style={{
            border: "none",
            borderTop: "1px solid var(--border)",
            margin: "12px 0",
          }}
        />

        <p className="field-label" style={{ marginBottom: "8px" }}>
          写入工具
        </p>
        {(
          ["propose_file_edit", "propose_apply_patch", "propose_shell"] as const
        ).map((toolName) => {
          const descriptions: Record<string, string> = {
            propose_file_edit: "结构化文件编辑",
            propose_apply_patch: "应用 Patch 补丁",
            propose_shell: "执行 Shell 命令",
          };
          const permissions = draft.toolPermissions ?? DEFAULT_TOOL_PERMISSIONS;
          return (
            <div
              key={toolName}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "4px 0",
              }}
            >
              <span style={{ fontSize: "13px" }}>
                <code
                  style={{
                    fontSize: "12px",
                    background: "var(--bg-2)",
                    padding: "1px 4px",
                    borderRadius: "3px",
                  }}
                >
                  {toolName}
                </code>
                <span style={{ color: "var(--text-3)", marginLeft: "6px" }}>
                  {descriptions[toolName]}
                </span>
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

        <p
          style={{
            fontSize: "11px",
            color: "var(--color-warning, #e6a700)",
            marginTop: "12px",
            lineHeight: "1.5",
          }}
        >
          ⚠ 将写入工具设为自动执行意味着 LLM
          可以直接修改文件和执行命令，请确保你信任当前使用的模型。
        </p>
      </div>

      {/* Runtime info */}
      <div className="card card-sm">
        <p className="card-title">运行时信息</p>
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <div className="api-key-display">
            Endpoint: {runtimeConfig.endpoint}
          </div>
        </div>
      </div>

      {/* Danger Zone */}
      <div
        className="card card-sm"
        style={{ borderColor: "var(--color-error)" }}
      >
        <p className="card-title" style={{ color: "var(--color-error)" }}>
          危险操作
        </p>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "12px",
          }}
        >
          <div>
            <p style={{ fontSize: "13px", margin: 0 }}>清除所有会话记录</p>
            <p
              style={{
                fontSize: "11px",
                color: "var(--text-3)",
                margin: "4px 0 0 0",
              }}
            >
              删除所有工作区的所有对话数据，此操作不可撤销
            </p>
          </div>
          {confirmClear ? (
            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              <span style={{ fontSize: "12px", color: "var(--color-error)" }}>
                确认清除所有会话？
              </span>
              <button
                className="btn btn-ghost btn-sm"
                style={{
                  color: "var(--color-error)",
                  borderColor: "var(--color-error)",
                }}
                onClick={() => {
                  setConfirmClear(false);
                  clearAllConversations();
                  setSaveMessage("已清除所有会话");
                  setTimeout(() => setSaveMessage(""), 3000);
                  window.location.reload();
                }}
                type="button"
              >
                确认
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setConfirmClear(false)}
                type="button"
              >
                取消
              </button>
            </div>
          ) : (
            <button
              className="btn btn-ghost"
              style={{
                color: "var(--color-error)",
                borderColor: "var(--color-error)",
              }}
              onClick={() => setConfirmClear(true)}
              type="button"
            >
              清除会话
            </button>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="btn-row">
        <button
          className="btn btn-primary"
          onClick={() => void handleSave()}
          type="button"
        >
          保存设置
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => {
            setDraft(settings);
            setSaveMessage("已重置");
            setTimeout(() => setSaveMessage(""), 2000);
          }}
          type="button"
        >
          重置
        </button>
        {saveMessage && <span className="save-feedback">✓ {saveMessage}</span>}
      </div>
    </div>
  );
}

/* ── Profile Card Sub-component ──────────────────────────── */

interface ProfileCardProps {
  profile: ModelProfile;
  isActive: boolean;
  isEditing: boolean;
  editingName: string;
  confirmDelete: boolean;
  canDelete: boolean;
  onSwitch: () => void;
  onStartEdit: () => void;
  onEditNameChange: (name: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onConfirmDelete: () => void;
  onDelete: () => void;
  onCancelDelete: () => void;
}

function ProfileCard({
  profile,
  isActive,
  isEditing,
  editingName,
  confirmDelete,
  canDelete,
  onSwitch,
  onStartEdit,
  onEditNameChange,
  onSaveEdit,
  onCancelEdit,
  onConfirmDelete,
  onDelete,
  onCancelDelete,
}: ProfileCardProps): ReactElement {
  const modelDisplay = formatModelRef(profile.provider || "", profile.model);

  return (
    <div
      className={`profile-card${isActive ? " active" : ""}`}
      onClick={!isActive && !isEditing ? onSwitch : undefined}
      role={!isActive && !isEditing ? "button" : undefined}
      tabIndex={!isActive && !isEditing ? 0 : undefined}
      onKeyDown={
        !isActive && !isEditing
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") onSwitch();
            }
          : undefined
      }
    >
      <div className="profile-card-indicator">
        <div className={`profile-dot${isActive ? " active" : ""}`} />
      </div>
      <div className="profile-card-body">
        {isEditing ? (
          <div className="profile-edit-row">
            <input
              className="input profile-edit-input"
              value={editingName}
              onChange={(e) => onEditNameChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onSaveEdit();
                if (e.key === "Escape") onCancelEdit();
              }}
              autoFocus
              onClick={(e) => e.stopPropagation()}
            />
            <button
              className="btn btn-primary btn-sm"
              onClick={(e) => {
                e.stopPropagation();
                onSaveEdit();
              }}
              type="button"
            >
              保存
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={(e) => {
                e.stopPropagation();
                onCancelEdit();
              }}
              type="button"
            >
              取消
            </button>
          </div>
        ) : (
          <>
            <span className="profile-card-name">{profile.name}</span>
            <span className="profile-card-model">{modelDisplay}</span>
          </>
        )}
      </div>
      {!isEditing && (
        <div className="profile-card-actions">
          {confirmDelete ? (
            <>
              <span className="profile-delete-confirm-text">删除？</span>
              <button
                className="btn btn-ghost btn-sm"
                style={{
                  color: "var(--color-error)",
                  borderColor: "var(--color-error)",
                  padding: "2px 8px",
                  fontSize: "11px",
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete();
                }}
                type="button"
              >
                确认
              </button>
              <button
                className="btn btn-ghost btn-sm"
                style={{ padding: "2px 8px", fontSize: "11px" }}
                onClick={(e) => {
                  e.stopPropagation();
                  onCancelDelete();
                }}
                type="button"
              >
                取消
              </button>
            </>
          ) : (
            <>
              <button
                className="profile-action-btn"
                title="重命名"
                onClick={(e) => {
                  e.stopPropagation();
                  onStartEdit();
                }}
                type="button"
              >
                ✏️
              </button>
              {canDelete && (
                <button
                  className="profile-action-btn danger"
                  title="删除"
                  onClick={(e) => {
                    e.stopPropagation();
                    onConfirmDelete();
                  }}
                  type="button"
                >
                  🗑
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
