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
  addModelsToVendor,
  createProfile,
  createVendor,
  deleteManagedModel,
  deleteProfile,
  deleteVendor,
  deleteVendorApiKey,
  getActiveProfile,
  getActiveVendor,
  getVendorById,
  listManagedModelsForVendor,
  loadVendorApiKey,
  maskApiKey,
  setProfileModelSelection,
  switchProfile,
  syncRuntimeSettings,
  updateManagedModel,
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
  const [editingModelId, setEditingModelId] = useState<string | null>(null);
  const [editingModelName, setEditingModelName] = useState("");
  const [confirmDeleteVendorId, setConfirmDeleteVendorId] = useState<string | null>(null);
  const [confirmDeleteModelId, setConfirmDeleteModelId] = useState<string | null>(null);
  const [vendorMessage, setVendorMessage] = useState("");
  const [fetchingVendorId, setFetchingVendorId] = useState<string | null>(null);
  const [fetchedModelIds, setFetchedModelIds] = useState<string[]>([]);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [modelPickerSearch, setModelPickerSearch] = useState("");
  const [modelPickerSelected, setModelPickerSelected] = useState<Set<string>>(new Set());

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
    if (!selectedVendorId) {
      return;
    }

    let cancelled = false;
    setVendorApiKeys((current) => {
      if (current[selectedVendorId] !== undefined) {
        cancelled = true;
      }
      return current;
    });
    if (cancelled) {
      return;
    }

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
  }, [selectedVendorId]);

  useEffect(() => {
    setShowModelPicker(false);
    setFetchedModelIds([]);
    setModelPickerSelected(new Set());
    setModelPickerSearch("");
  }, [selectedVendorId]);

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

  const handleDeleteVendor = async (vendorId: string) => {
    const nextSettings = deleteVendor(draft, vendorId);
    if (nextSettings === draft) {
      setVendorMessage("默认供应商或唯一供应商不能删除");
      setTimeout(() => setVendorMessage(""), 3000);
      return;
    }

    await deleteVendorApiKey(vendorId).catch(() => undefined);
    setVendorApiKeys((current) => {
      const next = { ...current };
      delete next[vendorId];
      return next;
    });

    const nextVendorId =
      getActiveVendor(nextSettings)?.id ?? nextSettings.vendors[0]?.id ?? null;
    setDraft(nextSettings);
    setSelectedVendorId(nextVendorId);
    setConfirmDeleteVendorId(null);
    setConfirmDeleteModelId(null);
    setEditingModelId(null);
    setEditingModelName("");
    setVendorMessage("供应商已删除，相关档案已自动迁移到可用模型");
    setTimeout(() => setVendorMessage(""), 4000);
  };

  const handleRenameModel = (modelId: string) => {
    const name = editingModelName.trim();
    if (!name) {
      setEditingModelId(null);
      setEditingModelName("");
      return;
    }
    setDraft((current) => updateManagedModel(current, modelId, { name }));
    setEditingModelId(null);
    setEditingModelName("");
  };

  const handleDeleteModel = (modelId: string) => {
    const nextSettings = deleteManagedModel(draft, modelId);
    if (nextSettings === draft) {
      setVendorMessage("每个供应商至少需要保留一个模型");
      setTimeout(() => setVendorMessage(""), 3000);
      return;
    }

    setDraft(nextSettings);
    setConfirmDeleteModelId(null);
    setEditingModelId(null);
    setEditingModelName("");
    setVendorMessage("模型已删除，受影响档案已自动迁移");
    setTimeout(() => setVendorMessage(""), 4000);
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
      setFetchedModelIds(modelIds);
      setModelPickerSearch("");
      setModelPickerSelected(new Set());
      setShowModelPicker(true);
    } catch (error) {
      setVendorMessage(
        `拉取失败：${error instanceof Error ? error.message : String(error)}`
      );
      setTimeout(() => setVendorMessage(""), 4000);
    } finally {
      setFetchingVendorId(null);
    }
  };

  const handleConfirmModelPick = () => {
    if (!selectedVendor || modelPickerSelected.size === 0) {
      setShowModelPicker(false);
      return;
    }
    const modelNames = Array.from(modelPickerSelected);
    let nextSettings = draft;
    const { settings: updatedSettings, added } = addModelsToVendor(
      draft,
      selectedVendor.id,
      modelNames,
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
    setShowModelPicker(false);
    setFetchedModelIds([]);
    setModelPickerSelected(new Set());
    setModelPickerSearch("");
    setVendorMessage(
      added.length > 0
        ? `已添加 ${added.length} 个模型`
        : "所选模型均已存在"
    );
    setTimeout(() => setVendorMessage(""), 4000);
  };

  const handleCloseModelPicker = () => {
    setShowModelPicker(false);
    setFetchedModelIds([]);
    setModelPickerSelected(new Set());
    setModelPickerSearch("");
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
          <span className="settings-nav-title">偏好设置</span>
          {onClose && (
            <button className="settings-close-btn" onClick={onClose} type="button">
              ×
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
              <span className="settings-tab-icon">
                {tab.id === "profiles"
                  ? "📋"
                  : tab.id === "model"
                    ? "🤖"
                    : tab.id === "tools"
                      ? "🛠"
                      : "⚙️"}
              </span>
              <span className="settings-tab-label">{tab.label}</span>
            </button>
          ))}
        </div>

      </nav>

      {/* Right content */}
      <section className="settings-panel">
        <div className="settings-pane">
          {activeTab === "profiles" && (
            <>
              <header className="settings-pane-header">
                <h2 className="settings-pane-title">配置档案</h2>
                <p className="settings-pane-desc">
                  配置档案是唯一的运行时入口。当前聊天始终使用当前档案绑定的供应商与模型。
                </p>
              </header>

              <div className="profile-list">
                {draft.profiles.map((profile) => (
                  <ProfileCard
                    key={profile.id}
                    profile={profile}
                    isActive={profile.id === draft.activeProfileId}
                    isEditing={editingProfileId === profile.id}
                    canDelete={draft.profiles.length > 1}
                    confirmDelete={confirmDeleteId === profile.id}
                    editingName={editingProfileId === profile.id ? editingProfileName : ""}
                    onClick={() => void handleSwitchProfile(profile.id)}
                    onStartEdit={() => {
                      setEditingProfileId(profile.id);
                      setEditingProfileName(profile.name);
                    }}
                    onEditChange={setEditingProfileName}
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

              {showNewProfile ? (
                <div className="profile-new-form">
                  <input
                    className="input"
                    placeholder="配置档案名称，如 本地开发 / OpenAI / Claude"
                    value={newProfileName}
                    onChange={(e) => setNewProfileName(e.target.value)}
                    type="text"
                  />
                  <div className="btn-row">
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={handleCreateProfile}
                      type="button"
                    >
                      创建配置档案
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => setShowNewProfile(false)}
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
            </>
          )}

          {activeTab === "model" && (
            <>
              <header className="settings-pane-header">
                <h2 className="settings-pane-title">
                  模型配置
                  {activeProfile && (
                    <span className="settings-section-tag">{activeProfile.name}</span>
                  )}
                </h2>
                <p className="settings-pane-desc">
                  先维护供应商和模型资源池，再为当前档案指定实际要使用的供应商与模型。
                </p>
              </header>

              <div className="settings-runtime-info">
                <span className="settings-runtime-label">当前请求入口</span>
                <span className="settings-runtime-value">{runtimeConfig.endpoint}</span>
              </div>

              <div className="settings-fields">
                <div className="settings-card">
                  <div className="settings-card-header">
                    <div>
                      <h3 className="settings-card-title">当前档案使用的模型</h3>
                      <p className="settings-card-desc">
                        这里是唯一的运行时选择入口。当前聊天将使用此档案绑定的供应商与模型。
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
                        这里只维护供应商配置与模型列表，不会直接切换当前档案正在使用的模型。
                      </p>
                    </div>
                  </div>

                  <div className="vendor-card-list">
                    {draft.vendors.map((vendor) => {
                      const canDeleteVendor =
                        draft.vendors.length > 1 && vendor.id !== "vendor-default";
                      return (
                        <div
                          key={vendor.id}
                          className={`vendor-card${selectedVendorId === vendor.id ? " active" : ""}`}
                        >
                          <button
                            className="vendor-card-main"
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
                          <div className="vendor-card-actions">
                            {confirmDeleteVendorId === vendor.id ? (
                              <>
                                <button
                                  className="btn btn-danger btn-sm"
                                  onClick={() => void handleDeleteVendor(vendor.id)}
                                  type="button"
                                >
                                  确认删除
                                </button>
                                <button
                                  className="btn btn-ghost btn-sm"
                                  onClick={() => setConfirmDeleteVendorId(null)}
                                  type="button"
                                >
                                  取消
                                </button>
                              </>
                            ) : (
                              <button
                                className="btn btn-ghost btn-sm"
                                disabled={!canDeleteVendor}
                                onClick={() => setConfirmDeleteVendorId(vendor.id)}
                                type="button"
                                title={canDeleteVendor ? "删除供应商" : "默认供应商或唯一供应商不能删除"}
                              >
                                删除供应商
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
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
                                isEditing={editingModelId === model.id}
                                editingName={editingModelId === model.id ? editingModelName : ""}
                                confirmDelete={confirmDeleteModelId === model.id}
                                canDelete={selectedVendorModels.length > 1}
                                onStartEdit={() => {
                                  setEditingModelId(model.id);
                                  setEditingModelName(model.name);
                                }}
                                onEditChange={setEditingModelName}
                                onSaveEdit={() => handleRenameModel(model.id)}
                                onCancelEdit={() => {
                                  setEditingModelId(null);
                                  setEditingModelName("");
                                }}
                                onConfirmDelete={() => setConfirmDeleteModelId(model.id)}
                                onDelete={() => handleDeleteModel(model.id)}
                                onCancelDelete={() => setConfirmDeleteModelId(null)}
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
              </div>
            </>
          )}

          {activeTab === "tools" && (
            <>
              <header className="settings-pane-header">
                <h2 className="settings-pane-title">工具权限</h2>
                <p className="settings-pane-desc">
                  控制 Agent 在规划与执行阶段对各类工具的默认权限。
                </p>
              </header>

              <div className="tool-permissions">
                {(
                  [
                    {
                      key: "read",
                      label: "读取类工具",
                      tone: "safe" as const,
                      items: [
                        ["list_files", "列出工作区文件与目录"],
                        ["read_file", "读取文件内容"],
                        ["grep", "全文搜索"],
                        ["glob", "按模式匹配文件"],
                        ["git_status", "查看 Git 状态"],
                        ["git_diff", "查看 Git 改动"],
                        ["diagnostics", "运行静态诊断"],
                      ] as Array<[keyof AppSettings["toolPermissions"], string]>,
                    },
                    {
                      key: "write",
                      label: "写入 / 执行类工具",
                      tone: "warn" as const,
                      items: [
                        ["propose_file_edit", "写入文件内容"],
                        ["propose_apply_patch", "应用补丁修改文件"],
                        ["propose_shell", "执行 shell 命令"],
                        ["fetch", "访问网络资源"],
                      ] as Array<[keyof AppSettings["toolPermissions"], string]>,
                    },
                  ] as const
                ).map((group) => (
                  <div className="tool-group" key={group.key}>
                    <div className="tool-group-header">
                      <span className="tool-group-label">{group.label}</span>
                      <span className={`tool-group-badge ${group.tone}`}>
                        {group.tone === "safe" ? "默认自动" : "建议谨慎"}
                      </span>
                    </div>
                    {group.items.map(([key, description]) => (
                      <ToolPermissionRow
                        key={key}
                        toolKey={key}
                        description={description}
                        value={draft.toolPermissions[key]}
                        onChange={(value) =>
                          setDraft((current) => ({
                            ...current,
                            toolPermissions: { ...current.toolPermissions, [key]: value },
                          }))
                        }
                      />
                    ))}
                  </div>
                ))}
              </div>
            </>
          )}

          {activeTab === "advanced" && (
            <>
              <header className="settings-pane-header">
                <h2 className="settings-pane-title">高级</h2>
                <p className="settings-pane-desc">
                  工作区、上下文和全局历史等高级设置。
                </p>
              </header>

              <div className="settings-fields">
                <div className="settings-card">
                  <div className="settings-card-header">
                    <div>
                      <h3 className="settings-card-title">工作区</h3>
                      <p className="settings-card-desc">
                        Agent 只会读取和修改当前工作区中的文件。
                      </p>
                    </div>
                  </div>
                  <div className="field">
                    <label className="field-label">工作区路径</label>
                    <input
                      className="input"
                      value={draft.workspacePath}
                      placeholder="请选择一个 Git 仓库文件夹"
                      readOnly
                      type="text"
                    />
                  </div>
                  <div className="btn-row">
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => void handleSelectWorkspace()}
                      type="button"
                    >
                      选择工作区
                    </button>
                  </div>
                  {workspaceInfo?.git_branch && (
                    <div className="settings-inline-feedback">
                      当前仓库：{workspaceInfo.repo_name || "未命名仓库"} · 分支：
                      {workspaceInfo.git_branch}
                    </div>
                  )}
                  {workspaceError && (
                    <div className="settings-empty-hint">{workspaceError}</div>
                  )}
                </div>

                <div className="settings-card">
                  <div className="settings-card-header">
                    <div>
                      <h3 className="settings-card-title">上下文限制</h3>
                      <p className="settings-card-desc">
                        控制自动读取时的片段大小和总体上下文预算。
                      </p>
                    </div>
                  </div>
                  <div className="grid-2">
                    <div className="field">
                      <label className="field-label">单次代码片段最大行数</label>
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
                        <option value={200}>200 行</option>
                        <option value={500}>500 行</option>
                        <option value={2000}>2000 行</option>
                      </select>
                    </div>
                    <div className="field">
                      <label className="field-label">上下文 Token 上限</label>
                      <input
                        className="input"
                        value={draft.maxContextTokens}
                        onChange={(e) =>
                          setDraft((p) => ({
                            ...p,
                            maxContextTokens: Math.max(0, Number(e.target.value) || 0),
                          }))
                        }
                        type="number"
                        min={0}
                      />
                    </div>
                  </div>
                  <label className="field-checkbox">
                    <input
                      checked={draft.sendRelativePathOnly}
                      onChange={(e) =>
                        setDraft((p) => ({
                          ...p,
                          sendRelativePathOnly: e.target.checked,
                        }))
                      }
                      type="checkbox"
                    />
                    <span>尽量只向模型发送相对路径，减少泄露绝对路径</span>
                  </label>
                </div>

                <div className="settings-card">
                  <div className="settings-card-header">
                    <div>
                      <h3 className="settings-card-title">云模型限制</h3>
                      <p className="settings-card-desc">
                        开启后可阻止非本地模型在当前环境中发送请求。
                      </p>
                    </div>
                  </div>
                  <label className="field-checkbox">
                    <input
                      checked={draft.allowCloudModels}
                      onChange={(e) =>
                        setDraft((p) => ({
                          ...p,
                          allowCloudModels: e.target.checked,
                        }))
                      }
                      type="checkbox"
                    />
                    <span>允许使用云端模型</span>
                  </label>
                </div>

                <div className="settings-card">
                  <div className="settings-card-header">
                    <div>
                      <h3 className="settings-card-title">清空历史</h3>
                      <p className="settings-card-desc">
                        删除当前工作区下的所有会话记录。此操作不可撤销。
                      </p>
                    </div>
                  </div>
                  {confirmClear ? (
                    <div className="btn-row">
                      <button
                        className="btn btn-danger btn-sm"
                        onClick={async () => {
                          clearAllConversations();
                          setConfirmClear(false);
                          setSaveMessage("已清空当前工作区的所有对话记录");
                          setTimeout(() => setSaveMessage(""), 3000);
                        }}
                        type="button"
                      >
                        确认清空
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
                      清空当前工作区对话记录
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        <footer className="settings-footer">
          <button className="btn btn-primary" onClick={() => void handleSave()} type="button">
            保存设置
          </button>
          {saveMessage && <span className="save-feedback">{saveMessage}</span>}
        </footer>
      </section>

      {showModelPicker && selectedVendor && (
        <ModelPickerOverlay
          fetchedModelIds={fetchedModelIds}
          existingModelNames={new Set(selectedVendorModels.map((m) => m.name))}
          search={modelPickerSearch}
          onSearchChange={setModelPickerSearch}
          selected={modelPickerSelected}
          onToggle={(modelId) => {
            setModelPickerSelected((prev) => {
              const next = new Set(prev);
              if (next.has(modelId)) {
                next.delete(modelId);
              } else {
                next.add(modelId);
              }
              return next;
            });
          }}
          onSelectAllNew={() => {
            const existingNames = new Set(selectedVendorModels.map((m) => m.name));
            setModelPickerSelected(
              new Set(fetchedModelIds.filter((id) => !existingNames.has(id)))
            );
          }}
          onDeselectAll={() => setModelPickerSelected(new Set())}
          onConfirm={handleConfirmModelPick}
          onCancel={handleCloseModelPicker}
        />
      )}
    </div>
  );
}

interface ToolPermissionRowProps {
  toolKey: keyof AppSettings["toolPermissions"];
  description: string;
  value: ToolPermissionLevel;
  onChange: (value: ToolPermissionLevel) => void;
}

function ToolPermissionRow({
  toolKey,
  description,
  value,
  onChange,
}: ToolPermissionRowProps): ReactElement {
  return (
    <div className="tool-permission-row">
      <div className="tool-permission-info">
        <span className="tool-permission-name">{toolKey}</span>
        <span className="tool-permission-desc">{description}</span>
      </div>
      <div className="tool-permission-toggle">
        {(["auto", "ask"] as ToolPermissionLevel[]).map((option) => (
          <button
            key={option}
            className={`tool-toggle-btn${value === option ? " active" : ""}`}
            onClick={() => onChange(option)}
            type="button"
          >
            {option === "auto" ? "Auto" : "Ask"}
          </button>
        ))}
      </div>
    </div>
  );
}

interface ProfileCardProps {
  profile: ModelProfile;
  isActive: boolean;
  isEditing: boolean;
  canDelete: boolean;
  confirmDelete: boolean;
  editingName: string;
  onClick: () => void;
  onStartEdit: () => void;
  onEditChange: (value: string) => void;
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
  canDelete,
  confirmDelete,
  editingName,
  onClick,
  onStartEdit,
  onEditChange,
  onSaveEdit,
  onCancelEdit,
  onConfirmDelete,
  onDelete,
  onCancelDelete,
}: ProfileCardProps): ReactElement {
  const isInteractive = !isActive && !isEditing && !confirmDelete;

  return (
    <div
      className={`profile-card${isActive ? " active" : ""}`}
      onClick={isInteractive ? onClick : undefined}
      role={isInteractive ? "button" : undefined}
      tabIndex={isInteractive ? 0 : undefined}
      aria-disabled={isInteractive ? undefined : true}
      onKeyDown={
        isInteractive
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      <div className="profile-card-indicator">
        <span className={`profile-dot${isActive ? " active" : ""}`} />
      </div>

      {isEditing ? (
        <div className="profile-edit-row" onClick={(e) => e.stopPropagation()}>
          <input
            className="input profile-edit-input"
            value={editingName}
            onChange={(e) => onEditChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                onSaveEdit();
              }
              if (e.key === "Escape") {
                onCancelEdit();
              }
            }}
            autoFocus
          />
          <button className="btn btn-primary btn-sm" onClick={onSaveEdit} type="button">
            保存
          </button>
          <button className="btn btn-ghost btn-sm" onClick={onCancelEdit} type="button">
            取消
          </button>
        </div>
      ) : confirmDelete ? (
        <div className="profile-edit-row" onClick={(e) => e.stopPropagation()}>
          <span className="profile-delete-confirm-text">确认删除该配置档案？</span>
          <button className="btn btn-danger btn-sm" onClick={onDelete} type="button">
            删除
          </button>
          <button className="btn btn-ghost btn-sm" onClick={onCancelDelete} type="button">
            取消
          </button>
        </div>
      ) : (
        <>
          <div className="profile-card-body">
            <span className="profile-card-name">{profile.name}</span>
            <span className="profile-card-model">{profile.model}</span>
          </div>
          <div className="profile-card-actions" onClick={(e) => e.stopPropagation()}>
            <button
              className="profile-action-btn"
              title="重命名"
              onClick={onStartEdit}
              type="button"
            >
              ✏️
            </button>
            {canDelete && (
              <button
                className="profile-action-btn danger"
                title="删除"
                onClick={onConfirmDelete}
                type="button"
              >
                🗑
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

interface VendorModelRowProps {
  model: ManagedModel;
  isEditing: boolean;
  editingName: string;
  confirmDelete: boolean;
  canDelete: boolean;
  onStartEdit: () => void;
  onEditChange: (value: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onConfirmDelete: () => void;
  onDelete: () => void;
  onCancelDelete: () => void;
}

function VendorModelRow({
  model,
  isEditing,
  editingName,
  confirmDelete,
  canDelete,
  onStartEdit,
  onEditChange,
  onSaveEdit,
  onCancelEdit,
  onConfirmDelete,
  onDelete,
  onCancelDelete,
}: VendorModelRowProps): ReactElement {
  return (
    <div className="vendor-model-row">
      {isEditing ? (
        <div className="vendor-model-inline-editor">
          <input
            className="input vendor-model-inline-input"
            value={editingName}
            onChange={(e) => onEditChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                onSaveEdit();
              }
              if (e.key === "Escape") {
                onCancelEdit();
              }
            }}
            autoFocus
          />
          <button className="btn btn-primary btn-sm" onClick={onSaveEdit} type="button">
            保存
          </button>
          <button className="btn btn-ghost btn-sm" onClick={onCancelEdit} type="button">
            取消
          </button>
        </div>
      ) : confirmDelete ? (
        <div className="vendor-model-inline-editor">
          <span className="profile-delete-confirm-text">确认删除该模型？</span>
          <button className="btn btn-danger btn-sm" onClick={onDelete} type="button">
            删除
          </button>
          <button className="btn btn-ghost btn-sm" onClick={onCancelDelete} type="button">
            取消
          </button>
        </div>
      ) : (
        <>
          <div className="vendor-model-row-info">
            <span className="vendor-model-row-name">{model.name}</span>
            <span className="vendor-model-row-source">
              {model.source === "fetched" ? "Fetch" : "Manual"}
            </span>
          </div>
          <div className="vendor-model-row-actions">
            <button className="btn btn-ghost btn-sm" onClick={onStartEdit} type="button">
              重命名
            </button>
            <button
              className="btn btn-ghost btn-sm"
              disabled={!canDelete}
              onClick={onConfirmDelete}
              type="button"
              title={canDelete ? "删除模型" : "每个供应商至少需要保留一个模型"}
            >
              删除
            </button>
          </div>
        </>
      )}
    </div>
  );
}

interface ModelPickerOverlayProps {
  fetchedModelIds: string[];
  existingModelNames: Set<string>;
  search: string;
  onSearchChange: (value: string) => void;
  selected: Set<string>;
  onToggle: (modelId: string) => void;
  onSelectAllNew: () => void;
  onDeselectAll: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}

function ModelPickerOverlay({
  fetchedModelIds,
  existingModelNames,
  search,
  onSearchChange,
  selected,
  onToggle,
  onSelectAllNew,
  onDeselectAll,
  onConfirm,
  onCancel,
}: ModelPickerOverlayProps): ReactElement {
  const query = search.toLowerCase().trim();
  const filtered = query
    ? fetchedModelIds.filter((id) => id.toLowerCase().includes(query))
    : fetchedModelIds;
  const newModels = filtered.filter((id) => !existingModelNames.has(id));
  const existingModels = filtered.filter((id) => existingModelNames.has(id));
  const newTotal = fetchedModelIds.filter((id) => !existingModelNames.has(id)).length;
  const selectedNewCount = Array.from(selected).filter(
    (id) => !existingModelNames.has(id)
  ).length;

  return (
    <div className="model-picker-backdrop" onClick={onCancel}>
      <div className="model-picker" onClick={(e) => e.stopPropagation()}>
        <div className="model-picker-header">
          <h3 className="model-picker-title">选择要添加的模型</h3>
          <p className="model-picker-desc">
            共获取到 {fetchedModelIds.length} 个模型，其中 {newTotal} 个为新模型
          </p>
          <input
            className="input model-picker-search"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="搜索模型名称..."
            type="text"
            autoFocus
          />
        </div>

        <div className="model-picker-toolbar">
          <span className="model-picker-stats">
            已选 {selectedNewCount} / {newTotal} 个新模型
          </span>
          <div className="model-picker-toolbar-actions">
            <button
              className="btn btn-ghost btn-sm"
              onClick={onSelectAllNew}
              type="button"
            >
              全选新模型
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={onDeselectAll}
              type="button"
            >
              取消全选
            </button>
          </div>
        </div>

        <div className="model-picker-list">
          {newModels.map((modelId) => {
            const isSelected = selected.has(modelId);
            return (
              <label
                key={modelId}
                className={`model-picker-item${isSelected ? " selected" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => onToggle(modelId)}
                />
                <span className="model-picker-item-name">{modelId}</span>
              </label>
            );
          })}
          {existingModels.length > 0 && (
            <>
              <div className="model-picker-divider">
                <span>已存在的模型</span>
              </div>
              {existingModels.map((modelId) => (
                <label key={modelId} className="model-picker-item exists">
                  <input type="checkbox" checked disabled />
                  <span className="model-picker-item-name">{modelId}</span>
                  <span className="model-picker-item-badge">已添加</span>
                </label>
              ))}
            </>
          )}
          {filtered.length === 0 && (
            <div className="model-picker-empty">
              {query ? "没有匹配的模型" : "没有可用模型"}
            </div>
          )}
        </div>

        <div className="model-picker-footer">
          <button
            className="btn btn-primary btn-sm"
            disabled={selectedNewCount === 0}
            onClick={onConfirm}
            type="button"
          >
            添加所选模型 ({selectedNewCount})
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={onCancel}
            type="button"
          >
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
