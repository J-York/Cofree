import { invoke } from "@tauri-apps/api/core";
import { type ReactElement, useEffect, useState } from "react";
import {
  VENDOR_PROTOCOLS,
  createLiteLLMClientConfig,
  fetchVendorModelIds,
  getProtocolLabel,
} from "../../lib/litellm";
import {
  type AppSettings,
  type ManagedModel,
  type ModelProfile,
  type ToolPermissionLevel,
  type VendorProtocol,
  DEFAULT_TOOL_PERMISSIONS,
  addModelsToVendor,
  createProfile,
  createVendor,
  deleteProfile,
  getActiveProfile,
  getActiveVendor,
  getVendorById,
  listManagedModelsForVendor,
  loadVendorApiKey,
  maskApiKey,
  setProfileModelSelection,
  switchProfile,
  syncRuntimeSettings,
  updateProfile,
  updateVendor,
} from "../../lib/settingsStore";
import { clearAllConversations } from "../../lib/conversationStore";

interface WorkspaceInfo {
  git_branch?: string;
  repo_name?: string;
}

interface SettingsPageProps {
  settings: AppSettings;
  onSave: (
    settings: AppSettings,
    vendorApiKeys?: Record<string, string>
  ) => Promise<void>;
  onClose?: () => void;
}

type SettingsTab = "profiles" | "model" | "tools" | "advanced";

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "profiles", label: "配置档案" },
  { id: "model", label: "模型配置" },
  { id: "tools", label: "工具权限" },
  { id: "advanced", label: "高级" },
];

export function SettingsPage({
  settings,
  onSave,
  onClose,
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
  const [selectedVendorId, setSelectedVendorId] = useState<string | null>(
    getActiveVendor(settings)?.id ?? settings.vendors[0]?.id ?? null
  );
  const [vendorApiKeys, setVendorApiKeys] = useState<Record<string, string>>({});
  const [showNewVendor, setShowNewVendor] = useState(false);
  const [newVendorName, setNewVendorName] = useState("");
  const [newVendorProtocol, setNewVendorProtocol] =
    useState<VendorProtocol>("openai-chat-completions");
  const [newVendorBaseUrl, setNewVendorBaseUrl] = useState("https://");
  const [manualModelName, setManualModelName] = useState("");
  const [vendorMessage, setVendorMessage] = useState("");
  const [fetchingVendorId, setFetchingVendorId] = useState<string | null>(null);

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
    setSelectedVendorId(getActiveVendor(settings)?.id ?? settings.vendors[0]?.id ?? null);
    setVendorApiKeys({});
  }, [settings]);

  const activeProfile = getActiveProfile(draft);
  const activeVendor = getActiveVendor(draft);
  const selectedVendor = getVendorById(draft, selectedVendorId);
  const activeVendorModels = listManagedModelsForVendor(draft, activeProfile?.vendorId);
  const selectedVendorModels = listManagedModelsForVendor(draft, selectedVendorId);

  useEffect(() => {
    if (!selectedVendorId || vendorApiKeys[selectedVendorId] !== undefined) {
      return;
    }
    let cancelled = false;
    loadVendorApiKey(selectedVendorId)
      .then((apiKey) => {
        if (cancelled) {
          return;
        }
        setVendorApiKeys((current) =>
          current[selectedVendorId] === undefined
            ? { ...current, [selectedVendorId]: apiKey }
            : current
        );
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setVendorApiKeys((current) =>
          current[selectedVendorId] === undefined
            ? { ...current, [selectedVendorId]: "" }
            : current
        );
      });
    return () => {
      cancelled = true;
    };
  }, [selectedVendorId, vendorApiKeys]);

  const handleSave = async (): Promise<void> => {
    const normalized = syncRuntimeSettings({
      ...draft,
      apiKey: activeVendor
        ? vendorApiKeys[activeVendor.id] ?? draft.apiKey
        : draft.apiKey,
    });
    try {
      await onSave(normalized, vendorApiKeys);
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
    const { settings: newSettings } = createProfile(draft, name);
    const switchedVendorId = getActiveVendor(newSettings)?.id ?? null;
    setDraft({
      ...newSettings,
      apiKey: switchedVendorId ? vendorApiKeys[switchedVendorId] ?? "" : "",
    });
    setSelectedVendorId(switchedVendorId);
    setShowNewProfile(false);
    setNewProfileName("");
  };

  const handleSwitchProfile = async (profileId: string) => {
    if (profileId === draft.activeProfileId) return;
    const switched = switchProfile(draft, profileId);
    const vendorId = getActiveVendor(switched)?.id ?? null;
    try {
      const apiKey = await loadVendorApiKey(vendorId);
      if (vendorId) {
        setVendorApiKeys((current) => ({ ...current, [vendorId]: apiKey }));
      }
      setDraft({ ...switched, apiKey });
      setSelectedVendorId(vendorId);
    } catch {
      setDraft({ ...switched, apiKey: "" });
      setSelectedVendorId(vendorId);
    }
  };

  const handleDeleteProfile = async (profileId: string) => {
    if (draft.profiles.length <= 1) return;
    const newSettings = deleteProfile(draft, profileId);
    if (
      newSettings.activeProfileId !== draft.activeProfileId &&
      newSettings.activeProfileId
    ) {
      try {
        const apiKey = await loadVendorApiKey(getActiveVendor(newSettings)?.id);
        setDraft({ ...newSettings, apiKey });
        setSelectedVendorId(getActiveVendor(newSettings)?.id ?? null);
      } catch {
        setDraft({ ...newSettings, apiKey: "" });
        setSelectedVendorId(getActiveVendor(newSettings)?.id ?? null);
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

  const handleCreateVendor = () => {
    const { settings: nextSettings, vendor } = createVendor(draft, {
      name: newVendorName.trim() || "新供应商",
      protocol: newVendorProtocol,
      baseUrl: newVendorBaseUrl.trim() || "https://",
    });
    setDraft(nextSettings);
    setSelectedVendorId(vendor.id);
    setVendorApiKeys((current) => ({ ...current, [vendor.id]: "" }));
    setShowNewVendor(false);
    setNewVendorName("");
    setNewVendorProtocol("openai-chat-completions");
    setNewVendorBaseUrl("https://");
  };

  const handleAssignFirstModelForVendor = (vendorId: string) => {
    if (!activeProfile) {
      return;
    }
    const [firstModel] = listManagedModelsForVendor(draft, vendorId);
    if (!firstModel) {
      return;
    }
    setDraft((current) =>
      setProfileModelSelection(current, activeProfile.id, firstModel.id)
    );
  };

  const handleFetchVendorModels = async () => {
    if (!selectedVendor) {
      return;
    }
    setFetchingVendorId(selectedVendor.id);
    setVendorMessage("");
    try {
      const modelIds = await fetchVendorModelIds({
        baseUrl: selectedVendor.baseUrl,
        apiKey: vendorApiKeys[selectedVendor.id] ?? "",
        protocol: selectedVendor.protocol,
        proxy: draft.proxy,
      });
      let nextSettings = draft;
      const { settings: updatedSettings, added } = addModelsToVendor(
        draft,
        selectedVendor.id,
        modelIds,
        "fetched"
      );
      nextSettings = updatedSettings;
      if (
        activeProfile &&
        activeProfile.vendorId === selectedVendor.id &&
        !activeProfile.modelId &&
        added[0]
      ) {
        nextSettings = setProfileModelSelection(
          updatedSettings,
          activeProfile.id,
          added[0].id
        );
      }
      setDraft(nextSettings);
      setVendorMessage(
        added.length > 0
          ? `已添加 ${added.length} 个模型`
          : "未发现新模型，已保留现有列表"
      );
    } catch (error) {
      setVendorMessage(
        `拉取失败：${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setFetchingVendorId(null);
      setTimeout(() => setVendorMessage(""), 4000);
    }
  };

  const handleAddManualModel = () => {
    if (!selectedVendor) {
      return;
    }
    const name = manualModelName.trim();
    if (!name) {
      return;
    }
    const { settings: nextSettings, added } = addModelsToVendor(
      draft,
      selectedVendor.id,
      [name],
      "manual"
    );
    setDraft(nextSettings);
    setManualModelName("");
    setVendorMessage(added.length ? "模型已添加" : "该模型已存在");
    setTimeout(() => setVendorMessage(""), 3000);
  };

  const handleSetProfileModel = (modelId: string) => {
    if (!activeProfile) {
      return;
    }
    setDraft((current) => setProfileModelSelection(current, activeProfile.id, modelId));
  };

  const runtimeConfig = createLiteLLMClientConfig(draft);
  const selectedVendorApiKey =
    (selectedVendorId && vendorApiKeys[selectedVendorId]) ?? "";
  const selectedVendorModelCount = selectedVendorModels.length;

  return (
    <div className="settings-layout">
      {/* Left tab rail */}
      <nav className="settings-nav">
        <div className="settings-nav-header">
          <span className="settings-nav-title">设置</span>
          {onClose && (
            <button className="settings-close-btn" onClick={onClose} type="button" aria-label="关闭">
              &times;
            </button>
          )}
        </div>
        <div className="settings-nav-tabs">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              className={`settings-tab-btn${activeTab === tab.id ? " active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
              type="button"
            >
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
                为 Cofree 管理多个供应商，并为当前配置档案选择要使用的模型。
              </p>
            </div>

            <div className="settings-fields">
              <div className="settings-card">
                <div className="settings-card-header">
                  <div>
                    <h3 className="settings-card-title">当前档案使用的模型</h3>
                    <p className="settings-card-desc">
                      当前聊天会使用这里选中的供应商与模型。
                    </p>
                  </div>
                  {activeVendor && (
                    <span className="settings-card-badge">
                      {getProtocolLabel(activeVendor.protocol)}
                    </span>
                  )}
                </div>
                <div className="settings-fields">
                  <div className="field">
                    <label className="field-label">当前供应商</label>
                    <select
                      className="select"
                      value={activeProfile?.vendorId ?? ""}
                      onChange={(e) => handleAssignFirstModelForVendor(e.target.value)}
                    >
                      {draft.vendors.map((vendor) => (
                        <option key={vendor.id} value={vendor.id}>
                          {vendor.name} · {getProtocolLabel(vendor.protocol)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label className="field-label">当前模型</label>
                    <select
                      className="select"
                      value={activeProfile?.modelId ?? ""}
                      onChange={(e) => handleSetProfileModel(e.target.value)}
                    >
                      {activeVendorModels.length > 0 ? (
                        activeVendorModels.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.name}
                          </option>
                        ))
                      ) : (
                        <option value="">该供应商下暂无模型</option>
                      )}
                    </select>
                  </div>
                </div>
              </div>

              <div className="settings-card">
                <div className="settings-card-header">
                  <div>
                    <h3 className="settings-card-title">供应商管理</h3>
                    <p className="settings-card-desc">
                      每个供应商独立配置 Base URL、API Key 与 API 协议。
                    </p>
                  </div>
                </div>

                <div className="vendor-card-list">
                  {draft.vendors.map((vendor) => (
                    <button
                      key={vendor.id}
                      className={`vendor-card${selectedVendorId === vendor.id ? " active" : ""}`}
                      onClick={() => setSelectedVendorId(vendor.id)}
                      type="button"
                    >
                      <div className="vendor-card-header">
                        <span className="vendor-card-name">{vendor.name}</span>
                        <span className="vendor-card-badge">
                          {getProtocolLabel(vendor.protocol)}
                        </span>
                      </div>
                      <span className="vendor-card-url">{vendor.baseUrl}</span>
                      <span className="vendor-card-meta">
                        {listManagedModelsForVendor(draft, vendor.id).length} 个模型
                      </span>
                    </button>
                  ))}
                </div>

                {showNewVendor ? (
                  <div className="settings-card-subsection">
                    <div className="grid-2">
                      <input
                        className="input"
                        value={newVendorName}
                        onChange={(e) => setNewVendorName(e.target.value)}
                        placeholder="供应商名称，如 OpenAI Official"
                        type="text"
                      />
                      <select
                        className="select"
                        value={newVendorProtocol}
                        onChange={(e) =>
                          setNewVendorProtocol(e.target.value as VendorProtocol)
                        }
                      >
                        {VENDOR_PROTOCOLS.map((protocol) => (
                          <option key={protocol.id} value={protocol.id}>
                            {protocol.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <input
                      className="input"
                      value={newVendorBaseUrl}
                      onChange={(e) => setNewVendorBaseUrl(e.target.value)}
                      placeholder="https://api.example.com/v1"
                      type="text"
                    />
                    <div className="btn-row">
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={handleCreateVendor}
                        type="button"
                      >
                        创建供应商
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => setShowNewVendor(false)}
                        type="button"
                      >
                        取消
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    className="btn btn-ghost btn-sm profile-add-btn"
                    onClick={() => setShowNewVendor(true)}
                    type="button"
                  >
                    + 新建供应商
                  </button>
                )}
              </div>

              {selectedVendor && (
                <div className="settings-card">
                  <div className="settings-card-header">
                    <div>
                      <h3 className="settings-card-title">编辑供应商</h3>
                      <p className="settings-card-desc">
                        可从该供应商按协议拉取模型，也可以手动补充模型。
                      </p>
                    </div>
                    <span className="settings-card-badge">
                      {selectedVendorModelCount} 个模型
                    </span>
                  </div>

                  <div className="settings-fields">
                    <div className="grid-2">
                      <div className="field">
                        <label className="field-label">供应商名称</label>
                        <input
                          className="input"
                          value={selectedVendor.name}
                          onChange={(e) =>
                            setDraft((current) =>
                              updateVendor(current, selectedVendor.id, {
                                name: e.target.value,
                              })
                            )
                          }
                          type="text"
                        />
                      </div>
                      <div className="field">
                        <label className="field-label">API 协议</label>
                        <select
                          className="select"
                          value={selectedVendor.protocol}
                          onChange={(e) =>
                            setDraft((current) =>
                              updateVendor(current, selectedVendor.id, {
                                protocol: e.target.value as VendorProtocol,
                              })
                            )
                          }
                        >
                          {VENDOR_PROTOCOLS.map((protocol) => (
                            <option key={protocol.id} value={protocol.id}>
                              {protocol.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="field">
                      <label className="field-label">Base URL</label>
                      <input
                        className="input"
                        value={selectedVendor.baseUrl}
                        onChange={(e) =>
                          setDraft((current) =>
                            updateVendor(current, selectedVendor.id, {
                              baseUrl: e.target.value,
                            })
                          )
                        }
                        placeholder="https://api.example.com/v1"
                        type="text"
                      />
                    </div>

                    <div className="field">
                      <label className="field-label">API Key</label>
                      <input
                        className="input"
                        value={selectedVendorApiKey}
                        onChange={(e) => {
                          const value = e.target.value.trim();
                          setVendorApiKeys((current) => ({
                            ...current,
                            [selectedVendor.id]: value,
                          }));
                          if (activeVendor?.id === selectedVendor.id) {
                            setDraft((current) => ({ ...current, apiKey: value }));
                          }
                        }}
                        placeholder="sk-..."
                        type="password"
                      />
                      <div className="api-key-display">
                        {maskApiKey(selectedVendorApiKey)}
                      </div>
                    </div>

                    <div className="settings-card-actions">
                      <button
                        className="btn btn-primary btn-sm"
                        disabled={fetchingVendorId === selectedVendor.id}
                        onClick={() => void handleFetchVendorModels()}
                        type="button"
                      >
                        {fetchingVendorId === selectedVendor.id
                          ? "拉取中..."
                          : "Fetch 可用模型"}
                      </button>
                    </div>

                    <div className="field">
                      <label className="field-label">手动添加模型</label>
                      <div className="grid-2">
                        <input
                          className="input"
                          value={manualModelName}
                          onChange={(e) => setManualModelName(e.target.value)}
                          placeholder="如 gpt-4.1、claude-sonnet-4-5 或 openai/gpt-4o"
                          type="text"
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              handleAddManualModel();
                            }
                          }}
                        />
                        <button
                          className="btn btn-ghost"
                          onClick={handleAddManualModel}
                          type="button"
                        >
                          添加模型
                        </button>
                      </div>
                    </div>

                    {vendorMessage && (
                      <div className="settings-inline-feedback">{vendorMessage}</div>
                    )}

                    <div className="field">
                      <label className="field-label">该供应商下的模型</label>
                      {selectedVendorModels.length > 0 ? (
                        <div className="vendor-model-list">
                          {selectedVendorModels.map((model) => (
                            <VendorModelRow
                              key={model.id}
                              model={model}
                              isActive={activeProfile?.modelId === model.id}
                              onSelect={() => handleSetProfileModel(model.id)}
                            />
                          ))}
                        </div>
                      ) : (
                        <div className="settings-empty-hint">
                          暂无模型。你可以先 Fetch，可手动添加。
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

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
              <h2 className="settings-pane-title">高级设置</h2>
              <p className="settings-pane-desc">数据管理与危险操作区域，请谨慎操作。</p>
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
                      className="btn btn-danger btn-sm"
                      onClick={() => {
                        setConfirmClear(false);
                        clearAllConversations();
                        setSaveMessage("已清除所有会话");
                        setTimeout(() => setSaveMessage(""), 3000);
                        window.location.reload();
                      }}
                      type="button"
                    >
                      确认清除
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
                    className="btn btn-danger btn-sm"
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
  const modelDisplay = profile.model;

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
                style={{ color: "var(--color-error)", borderColor: "var(--color-error)", padding: "3px 10px", fontSize: "12px" }}
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
                type="button"
              >
                确认
              </button>
              <button
                className="btn btn-ghost btn-sm"
                style={{ padding: "3px 10px", fontSize: "12px" }}
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

interface VendorModelRowProps {
  model: ManagedModel;
  isActive: boolean;
  onSelect: () => void;
}

function VendorModelRow({
  model,
  isActive,
  onSelect,
}: VendorModelRowProps): ReactElement {
  return (
    <div className={`vendor-model-row${isActive ? " active" : ""}`}>
      <div className="vendor-model-row-info">
        <span className="vendor-model-row-name">{model.name}</span>
        <span className="vendor-model-row-source">
          {model.source === "fetched" ? "Fetch" : "Manual"}
        </span>
      </div>
      <button
        className={`btn btn-sm ${isActive ? "btn-primary" : "btn-ghost"}`}
        onClick={onSelect}
        type="button"
      >
        {isActive ? "当前使用中" : "用于当前档案"}
      </button>
    </div>
  );
}
