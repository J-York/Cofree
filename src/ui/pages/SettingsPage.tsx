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

type SettingsTab = "profiles" | "model" | "tools" | "advanced";

const TABS: { id: SettingsTab; label: string; icon: string }[] = [
  { id: "profiles", label: "配置档案", icon: "◈" },
  { id: "model", label: "模型配置", icon: "⬡" },
  { id: "tools", label: "工具权限", icon: "⚙" },
  { id: "advanced", label: "高级", icon: "⚑" },
];

export function SettingsPage({
  settings,
  onSave,
}: SettingsPageProps): ReactElement {
  const [activeTab, setActiveTab] = useState<SettingsTab>("profiles");
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [saveMessage, setSaveMessage] = useState<string>("");
  const [workspaceInfo, setWorkspaceInfo] = useState<WorkspaceInfo | null>(null);
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
    if (draft.profiles.length <= 1) return;
    const newSettings = deleteProfile(draft, profileId);
    try {
      await deleteSecureApiKey(profileId);
    } catch {
      // ignore
    }
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
    <div className="settings-layout">
      {/* Left tab rail */}
      <nav className="settings-nav">
        <div className="settings-nav-header">
          <span className="settings-nav-title">设置</span>
        </div>
        <div className="settings-nav-tabs">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              className={`settings-tab-btn${activeTab === tab.id ? " active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
              type="button"
            >
              <span className="settings-tab-icon">{tab.icon}</span>
              <span className="settings-tab-label">{tab.label}</span>
            </button>
          ))}
        </div>

        {/* Workspace pinned at bottom of nav */}
        <div className="settings-nav-workspace">
          <div className="settings-workspace-mini">
            <span className="settings-workspace-mini-icon">📁</span>
            <div className="settings-workspace-mini-info">
              <span className="settings-workspace-mini-path">
                {draft.workspacePath
                  ? draft.workspacePath.split("/").pop() || draft.workspacePath
                  : "未选择"}
              </span>
              {workspaceInfo?.git_branch && (
                <span className="settings-workspace-mini-branch">
                  🌿 {workspaceInfo.git_branch}
                </span>
              )}
            </div>
            <button
              className="btn btn-ghost btn-xs"
              onClick={handleSelectWorkspace}
              type="button"
              title="选择工作区目录"
            >
              更改
            </button>
          </div>
          {workspaceError && (
            <p className="settings-workspace-error">⚠ {workspaceError}</p>
          )}
        </div>
      </nav>

      {/* Right content panel */}
      <div className="settings-panel">
        {/* ── Tab: Profiles ── */}
        {activeTab === "profiles" && (
          <div className="settings-pane">
            <div className="settings-pane-header">
              <h2 className="settings-pane-title">配置档案</h2>
              <p className="settings-pane-desc">
                每个档案独立保存模型、API Key 和代理配置，可随时切换。
              </p>
            </div>

            <div className="profile-list">
              {draft.profiles.length > 0 ? (
                draft.profiles.map((profile) => (
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
                ))
              ) : (
                <p className="profile-empty-hint">
                  暂无配置档案，创建第一个配置以开始使用
                </p>
              )}
            </div>

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
        )}

        {/* ── Tab: Model ── */}
        {activeTab === "model" && (
          <div className="settings-pane">
            <div className="settings-pane-header">
              <h2 className="settings-pane-title">
                模型配置
                {activeProfile && (
                  <span className="settings-section-tag">{activeProfile.name}</span>
                )}
              </h2>
              <p className="settings-pane-desc">
                配置 LiteLLM 代理地址、API Key 和模型名称。
              </p>
            </div>

            <div className="settings-fields">
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

              <div className="settings-divider">
                <span>代理设置</span>
              </div>

              <div className="field">
                <label className="field-label">代理模式</label>
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
                    placeholder="http://127.0.0.1:7890"
                    type="text"
                  />
                </div>
              </div>

              {draft.proxy.mode !== "off" && (
                <>
                  <div className="field">
                    <label className="field-label">代理认证（可选）</label>
                    <div className="grid-2">
                      <input
                        className="input"
                        value={draft.proxy.username ?? ""}
                        onChange={(e) =>
                          setDraft((p) => ({
                            ...p,
                            proxy: { ...p.proxy, username: e.target.value },
                          }))
                        }
                        placeholder="用户名"
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
                        placeholder="密码"
                        type="password"
                        autoComplete="off"
                      />
                    </div>
                  </div>

                  <div className="field">
                    <label className="field-label">No Proxy（可选）</label>
                    <input
                      className="input"
                      value={draft.proxy.noProxy ?? ""}
                      onChange={(e) =>
                        setDraft((p) => ({
                          ...p,
                          proxy: { ...p.proxy, noProxy: e.target.value },
                        }))
                      }
                      placeholder="localhost,127.0.0.1,*.local"
                      type="text"
                    />
                  </div>
                </>
              )}

              <div className="settings-divider">
                <span>上下文限制</span>
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
                    placeholder="128000"
                    value={draft.maxContextTokens || ""}
                    onChange={(e) =>
                      setDraft((p) => ({
                        ...p,
                        maxContextTokens: Number(e.target.value) || 128000,
                      }))
                    }
                  />
                </div>
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

              <div className="settings-runtime-info">
                <span className="settings-runtime-label">当前 Endpoint</span>
                <code className="settings-runtime-value">{runtimeConfig.endpoint}</code>
              </div>
            </div>
          </div>
        )}

        {/* ── Tab: Tools ── */}
        {activeTab === "tools" && (
          <div className="settings-pane">
            <div className="settings-pane-header">
              <h2 className="settings-pane-title">工具权限</h2>
              <p className="settings-pane-desc">
                控制 AI 可以自动执行哪些操作，写入类工具建议设为「需要审批」。
              </p>
            </div>

            <ToolPermissionsPanel draft={draft} setDraft={setDraft} />
          </div>
        )}

        {/* ── Tab: Advanced ── */}
        {activeTab === "advanced" && (
          <div className="settings-pane">
            <div className="settings-pane-header">
              <h2 className="settings-pane-title">高级</h2>
              <p className="settings-pane-desc">危险操作与数据管理。</p>
            </div>

            <div className="settings-danger-zone">
              <div className="settings-danger-item">
                <div className="settings-danger-info">
                  <p className="settings-danger-title">清除所有会话记录</p>
                  <p className="settings-danger-desc">
                    删除所有工作区的所有对话数据，此操作不可撤销。
                  </p>
                </div>
                {confirmClear ? (
                  <div className="settings-danger-confirm">
                    <span className="settings-danger-confirm-text">确认清除？</span>
                    <button
                      className="btn btn-ghost btn-sm"
                      style={{ color: "var(--color-error)", borderColor: "var(--color-error)" }}
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
                    className="btn btn-ghost btn-sm"
                    style={{ color: "var(--color-error)", borderColor: "var(--color-error)" }}
                    onClick={() => setConfirmClear(true)}
                    type="button"
                  >
                    清除会话
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Sticky footer: save / reset */}
        <div className="settings-footer">
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
          {saveMessage && (
            <span className="save-feedback">✓ {saveMessage}</span>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Tool Permissions Panel ──────────────────────────────── */

const READ_TOOLS: { name: string; desc: string }[] = [
  { name: "list_files", desc: "列出目录文件" },
  { name: "read_file", desc: "读取文件内容" },
  { name: "grep", desc: "正则搜索文件内容" },
  { name: "glob", desc: "Glob 模式匹配文件路径" },
  { name: "git_status", desc: "查看 Git 状态" },
  { name: "git_diff", desc: "查看 Git 差异" },
];

const WRITE_TOOLS: { name: string; desc: string }[] = [
  { name: "propose_file_edit", desc: "结构化文件编辑" },
  { name: "propose_apply_patch", desc: "应用 Patch 补丁" },
  { name: "propose_shell", desc: "执行 Shell 命令" },
];

interface ToolPermissionsPanelProps {
  draft: AppSettings;
  setDraft: React.Dispatch<React.SetStateAction<AppSettings>>;
}

function ToolPermissionsPanel({ draft, setDraft }: ToolPermissionsPanelProps): ReactElement {
  const permissions = draft.toolPermissions ?? DEFAULT_TOOL_PERMISSIONS;

  const setPermission = (toolName: string, value: ToolPermissionLevel) => {
    setDraft((p) => ({
      ...p,
      toolPermissions: {
        ...(p.toolPermissions ?? DEFAULT_TOOL_PERMISSIONS),
        [toolName]: value,
      },
    }));
  };

  return (
    <div className="tool-permissions">
      <div className="tool-group">
        <div className="tool-group-header">
          <span className="tool-group-label">只读工具</span>
          <span className="tool-group-badge safe">低风险</span>
        </div>
        {READ_TOOLS.map(({ name, desc }) => (
          <ToolPermissionRow
            key={name}
            name={name}
            desc={desc}
            value={permissions[name as keyof typeof permissions] ?? "auto"}
            onChange={(v) => setPermission(name, v)}
          />
        ))}
      </div>

      <div className="tool-group">
        <div className="tool-group-header">
          <span className="tool-group-label">写入工具</span>
          <span className="tool-group-badge warn">需谨慎</span>
        </div>
        {WRITE_TOOLS.map(({ name, desc }) => (
          <ToolPermissionRow
            key={name}
            name={name}
            desc={desc}
            value={permissions[name as keyof typeof permissions] ?? "ask"}
            onChange={(v) => setPermission(name, v)}
          />
        ))}
      </div>

      <p className="tool-permissions-warning">
        ⚠ 将写入工具设为「自动执行」意味着 LLM 可以直接修改文件和执行命令，请确保你信任当前使用的模型。
      </p>
    </div>
  );
}

interface ToolPermissionRowProps {
  name: string;
  desc: string;
  value: ToolPermissionLevel;
  onChange: (v: ToolPermissionLevel) => void;
}

function ToolPermissionRow({ name, desc, value, onChange }: ToolPermissionRowProps): ReactElement {
  return (
    <div className="tool-permission-row">
      <div className="tool-permission-info">
        <code className="tool-permission-name">{name}</code>
        <span className="tool-permission-desc">{desc}</span>
      </div>
      <div className="tool-permission-toggle">
        <button
          className={`tool-toggle-btn${value === "auto" ? " active" : ""}`}
          onClick={() => onChange("auto")}
          type="button"
        >
          自动
        </button>
        <button
          className={`tool-toggle-btn${value === "ask" ? " active ask" : ""}`}
          onClick={() => onChange("ask")}
          type="button"
        >
          审批
        </button>
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
              onClick={(e) => { e.stopPropagation(); onSaveEdit(); }}
              type="button"
            >
              保存
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={(e) => { e.stopPropagation(); onCancelEdit(); }}
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
                style={{ color: "var(--color-error)", borderColor: "var(--color-error)", padding: "2px 8px", fontSize: "11px" }}
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
                type="button"
              >
                确认
              </button>
              <button
                className="btn btn-ghost btn-sm"
                style={{ padding: "2px 8px", fontSize: "11px" }}
                onClick={(e) => { e.stopPropagation(); onCancelDelete(); }}
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
                onClick={(e) => { e.stopPropagation(); onStartEdit(); }}
                type="button"
              >
                ✏️
              </button>
              {canDelete && (
                <button
                  className="profile-action-btn danger"
                  title="删除"
                  onClick={(e) => { e.stopPropagation(); onConfirmDelete(); }}
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
