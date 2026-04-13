import { invoke } from "@tauri-apps/api/core";
import { Suspense, type ReactElement, lazy, useEffect, useState } from "react";
import {
  createLiteLLMClientConfig,
  fetchVendorModelIds,
} from "../../lib/piAiBridge";
import {
  type AppSettings,
  type VendorConfig,
  type VendorProtocol,
  addModelsToVendor,
  cloneAgentAsCustom,
  createCustomAgent,
  createVendor,
  deleteCustomAgent,
  deleteManagedModel,
  deleteVendor,
  deleteVendorApiKey,
  getActiveManagedModel,
  getActiveVendor,
  getVendorById,
  listManagedModelsForVendor,
  loadVendorApiKey,
  resetBuiltinAgentOverride,
  setActiveManagedModelSelection,
  setActiveVendorSelection,
  syncRuntimeSettings,
  updateAllowCloudModels,
  updateBuiltinAgentOverride,
  updateContextSettings,
  updateCustomAgent,
  updateManagedModel,
  updateProxySettings,
  updateToolPermission,
  updateVendor,
  updateWorkspacePath,
} from "../../lib/settingsStore";
import {
  clearWorkspaceTeamTrustMode,
  loadWorkspaceTeamTrustMode,
  saveWorkspaceTeamTrustMode,
  type WorkspaceTeamTrustMode,
} from "../../lib/workspaceTeamTrustStore";
import {
  getAllChatAgents,
  getBuiltinChatAgent,
  hasBuiltinOverride,
} from "../../agents/builtinChatAgents";
import { AGENT_TOOL_CATALOG, type SubAgentRole } from "../../agents/types";
import {
  clearAllConversations,
  clearWorkspaceConversations,
} from "../../lib/conversationMaintenance";
import { SettingsNav as SettingsNavRail } from "./SettingsNav";
import { SettingsFooter as SettingsPageFooter } from "./SettingsFooter";
import { ToolPermissionRow as SettingsToolPermissionRow } from "./ToolPermissionRow";
import {
  SUB_AGENT_ROLES,
  type AgentEditorProps,
  type ModelPickerOverlayProps,
  type SettingsPageProps,
  type SettingsTab,
  type WorkspaceInfo,
} from "./settingsTypes";
import { useTheme, getThemeLabel, type ThemeMode } from "../../hooks/useTheme";

const SettingsModelTab = lazy(() =>
  import("./ModelTab").then((module) => ({ default: module.ModelTab }))
);

function ModelTabFallback(): ReactElement {
  return (
    <div style={{ padding: "16px 0" }}>
      <p className="status-note">模型设置加载中…</p>
    </div>
  );
}

export function resolveSelectedVendorId(
  settings: Pick<AppSettings, "vendors" | "activeVendorId" | "activeModelId" | "managedModels">,
  currentSelectedVendorId?: string | null,
): string | null {
  if (getVendorById(settings, currentSelectedVendorId)) {
    return currentSelectedVendorId ?? null;
  }
  return getVendorById(settings, settings.activeVendorId)?.id ?? settings.vendors[0]?.id ?? null;
}

function getWorkspaceTeamTrustModeLabel(
  mode: WorkspaceTeamTrustMode | null,
): string {
  if (mode === "team_yolo") {
    return "YOLO";
  }
  if (mode === "team_manual") {
    return "审批";
  }
  return "未设置（首次进入编排时询问）";
}

export function WorkspaceTeamTrustModeField({
  workspacePath,
  mode,
  onChange,
}: {
  workspacePath: string;
  mode: WorkspaceTeamTrustMode | null;
  onChange: (mode: WorkspaceTeamTrustMode | null) => void;
}): ReactElement {
  const disabled = !workspacePath.trim();

  return (
    <div className="settings-card">
      <div className="settings-card-header">
        <div>
          <h3 className="settings-card-title">编排执行模式</h3>
          <p className="settings-card-desc">
            按工作区决定编排（子 Agent / 专家团）相关敏感动作是自动执行还是逐条审批。
          </p>
        </div>
      </div>
      <div className="field">
        <label className="field-label">当前工作区</label>
        <select
          className="select"
          value={mode ?? ""}
          disabled={disabled}
          onChange={(event) => {
            const value = event.target.value;
            if (value === "team_yolo" || value === "team_manual") {
              onChange(value);
              return;
            }
            onChange(null);
          }}
        >
          <option value="">未设置（首次进入编排时询问）</option>
          <option value="team_yolo">YOLO</option>
          <option value="team_manual">审批</option>
        </select>
      </div>
      <div className="settings-inline-feedback">
        {disabled
          ? "该设置按工作区存储；请先选择工作区。"
          : `当前模式：${getWorkspaceTeamTrustModeLabel(mode)}`}
      </div>
    </div>
  );
}

export function SettingsPage({
  settings,
  onSave,
  onClose,
}: SettingsPageProps): ReactElement {
  const [activeTab, setActiveTab] = useState<SettingsTab>("agents");
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [saveMessage, setSaveMessage] = useState<string>("");
  const [workspaceInfo, setWorkspaceInfo] = useState<WorkspaceInfo | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string>("");
  const [workspaceTeamTrustMode, setWorkspaceTeamTrustMode] =
    useState<WorkspaceTeamTrustMode | null>(() =>
      loadWorkspaceTeamTrustMode(settings.workspacePath),
    );
  const [clearScope, setClearScope] = useState<"workspace" | "all">("workspace");
  const [confirmClearScope, setConfirmClearScope] = useState<"workspace" | "all" | null>(null);

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

  // Agent management states
  const allAgents = getAllChatAgents(draft);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(
    allAgents[0]?.id ?? null,
  );
  const selectedAgent = allAgents.find((a) => a.id === selectedAgentId) ?? null;
  const isSelectedBuiltin = selectedAgent?.builtin === true;
  const isSelectedOverridden = isSelectedBuiltin && selectedAgentId
    ? hasBuiltinOverride(selectedAgentId, draft)
    : false;
  const originalBuiltin = selectedAgentId
    ? getBuiltinChatAgent(selectedAgentId)
    : null;
  const [showNewAgent, setShowNewAgent] = useState(false);
  const [newAgentName, setNewAgentName] = useState("");
  const [confirmDeleteAgentId, setConfirmDeleteAgentId] = useState<string | null>(null);

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
    setWorkspaceTeamTrustMode(loadWorkspaceTeamTrustMode(draft.workspacePath || ""));
  }, [draft.workspacePath]);

  useEffect(() => {
    setDraft(settings);
    setSelectedVendorId((current) => resolveSelectedVendorId(settings, current));
    setVendorApiKeys({});
    setWorkspaceTeamTrustMode(loadWorkspaceTeamTrustMode(settings.workspacePath));
  }, [settings]);

  const activeManagedModel = getActiveManagedModel(draft);
  const activeVendor = getActiveVendor(draft);
  const selectedVendor = getVendorById(draft, selectedVendorId);
  const activeVendorModels = listManagedModelsForVendor(draft, activeVendor?.id);
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
        const updated = updateWorkspacePath(draft, path);
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

  const handleWorkspaceTeamTrustModeChange = (
    mode: WorkspaceTeamTrustMode | null,
  ): void => {
    const workspacePath = draft.workspacePath.trim();
    if (!workspacePath) {
      setSaveMessage("请先选择工作区后再设置编排执行模式");
      setTimeout(() => setSaveMessage(""), 3000);
      return;
    }

    if (mode === null) {
      clearWorkspaceTeamTrustMode(workspacePath);
      setWorkspaceTeamTrustMode(null);
      setSaveMessage("已重置当前工作区的编排执行模式");
      setTimeout(() => setSaveMessage(""), 3000);
      return;
    }

    const saved = saveWorkspaceTeamTrustMode(workspacePath, mode);
    if (!saved) {
      setSaveMessage("保存当前工作区的编排执行模式失败");
      setTimeout(() => setSaveMessage(""), 3000);
      return;
    }

    setWorkspaceTeamTrustMode(mode);
    setSaveMessage(
      mode === "team_yolo"
        ? "当前工作区已启用编排 YOLO 模式"
        : "当前工作区将继续使用编排审批模式",
    );
    setTimeout(() => setSaveMessage(""), 3000);
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
      setVendorMessage("唯一供应商不能删除");
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
    setVendorMessage("供应商已删除，相关 Agent/全局模型已自动回退到可用模型");
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

  const handleUpdateModelThinking = (
    modelId: string,
    updates: Partial<
      Pick<AppSettings["managedModels"][number], "supportsThinking" | "thinkingLevel">
    >,
  ) => {
    setDraft((current) => updateManagedModel(current, modelId, updates));
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
    setVendorMessage("模型已删除，受影响 Agent/全局模型已自动回退");
    setTimeout(() => setVendorMessage(""), 4000);
  };

  const handleAssignFirstModelForVendor = (vendorId: string) => {
    const [firstModel] = listManagedModelsForVendor(draft, vendorId);
    if (!firstModel) {
      return;
    }
    setDraft((current) => setActiveVendorSelection(current, vendorId));
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
    if (selectedVendor.id === draft.activeVendorId && added[0]) {
      nextSettings = setActiveManagedModelSelection(updatedSettings, added[0].id);
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

  const handleSetActiveModel = (modelId: string) => {
    setDraft((current) => setActiveManagedModelSelection(current, modelId));
  };

  const handleSelectedVendorApiKeyChange = (value: string) => {
    if (!selectedVendor) {
      return;
    }
    const normalizedValue = value.trim();
    setVendorApiKeys((current) => ({
      ...current,
      [selectedVendor.id]: normalizedValue,
    }));
    if (activeVendor?.id === selectedVendor.id) {
      setDraft((current) => ({ ...current, apiKey: normalizedValue }));
    }
  };

  const handleUpdateSelectedVendor = (
    updates: Partial<Omit<VendorConfig, "id" | "createdAt">>,
  ) => {
    if (!selectedVendor) {
      return;
    }
    setDraft((current) => updateVendor(current, selectedVendor.id, updates));
  };

  const handleUpdateProxy = (updates: Partial<AppSettings["proxy"]>) => {
    setDraft((current) => updateProxySettings(current, updates));
  };

  const handleUpdateModelMetaSettings = (
    modelId: string,
    updates: Partial<AppSettings["managedModels"][number]["metaSettings"]>,
  ) => {
    setDraft((current) =>
      updateManagedModel(current, modelId, {
        metaSettings: {
          ...(
            current.managedModels.find((entry) => entry.id === modelId)?.metaSettings ?? {
              contextWindowTokens: 0,
              maxOutputTokens: 0,
              temperature: null,
              topP: null,
              frequencyPenalty: null,
              presencePenalty: null,
              seed: null,
            }
          ),
          ...updates,
        },
      }),
    );
  };

  const handleClearWorkspaceHistory = () => {
    clearWorkspaceConversations(draft.workspacePath);
    setConfirmClearScope(null);
    setSaveMessage("已清空当前工作区的所有对话记录");
    setTimeout(() => setSaveMessage(""), 3000);
  };

  const handleClearAllHistory = () => {
    clearAllConversations();
    setConfirmClearScope(null);
    setSaveMessage("已清空所有工作区的对话记录");
    setTimeout(() => setSaveMessage(""), 3000);
  };

  const runtimeConfig = createLiteLLMClientConfig(draft);
  const selectedVendorApiKey =
    (selectedVendorId && vendorApiKeys[selectedVendorId]) ?? "";

  return (
    <div className="settings-layout">
      <SettingsNavRail
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onClose={onClose}
      />

      {/* Right content */}
      <section className="settings-panel">
        <div className="settings-pane">
          {activeTab === "agents" && (
            <>
              <header className="settings-pane-header">
                <h2 className="settings-pane-title">Agent 管理</h2>
                <p className="settings-pane-desc">
                  每个 Agent 有独立的系统提示词、工具策略和子 Agent 权限。可编辑内置 Agent 或创建自定义 Agent。
                </p>
              </header>

              <div className="agent-card-list">
                {allAgents.map((agent) => {
                  const isActive = agent.id === selectedAgentId;
                  const overridden = agent.builtin && hasBuiltinOverride(agent.id, draft);
                  return (
                    <button
                      key={agent.id}
                      className={`agent-card${isActive ? " active" : ""}`}
                      onClick={() => { setSelectedAgentId(agent.id); setConfirmDeleteAgentId(null); }}
                      type="button"
                    >
                      <div className="agent-card-header">
                        <span className="agent-card-name">{agent.name}</span>
                        <span className={`agent-card-badge${agent.builtin ? "" : " custom"}`}>
                          {agent.builtin ? (overridden ? "内置 · 已修改" : "内置") : "自定义"}
                        </span>
                      </div>
                      <span className="agent-card-desc">{agent.description || "暂无描述"}</span>
                    </button>
                  );
                })}
              </div>

              {showNewAgent ? (
                <div className="settings-inline-form">
                  <input
                    className="input"
                    placeholder="新 Agent 名称"
                    value={newAgentName}
                    onChange={(e) => setNewAgentName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        const { settings: next, agent } = createCustomAgent(draft, {
                          name: newAgentName,
                        });
                        setDraft(next);
                        setSelectedAgentId(agent.id);
                        setShowNewAgent(false);
                        setNewAgentName("");
                      }
                    }}
                    type="text"
                    autoFocus
                  />
                  <div className="btn-row">
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => {
                        const { settings: next, agent } = createCustomAgent(draft, {
                          name: newAgentName,
                        });
                        setDraft(next);
                        setSelectedAgentId(agent.id);
                        setShowNewAgent(false);
                        setNewAgentName("");
                      }}
                      type="button"
                    >
                      创建
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => { setShowNewAgent(false); setNewAgentName(""); }}
                      type="button"
                    >
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  className="btn btn-ghost btn-sm settings-inline-action"
                  onClick={() => setShowNewAgent(true)}
                  type="button"
                >
                  + 新建 Agent
                </button>
              )}

              {selectedAgent && (
                <AgentEditor
                  agent={selectedAgent}
                  isBuiltin={isSelectedBuiltin}
                  isOverridden={isSelectedOverridden}
                  originalBuiltin={originalBuiltin}
                  vendors={draft.vendors}
                  managedModels={draft.managedModels}
                  confirmDeleteId={confirmDeleteAgentId}
                  onUpdate={(updates) => {
                    if (isSelectedBuiltin) {
                      setDraft((prev) =>
                        updateBuiltinAgentOverride(prev, selectedAgent.id, updates),
                      );
                    } else {
                      setDraft((prev) =>
                        updateCustomAgent(prev, selectedAgent.id, updates),
                      );
                    }
                  }}
                  onReset={() => {
                    setDraft((prev) => resetBuiltinAgentOverride(prev, selectedAgent.id));
                  }}
                  onClone={() => {
                    const { settings: next, agent } = cloneAgentAsCustom(
                      draft,
                      selectedAgent,
                      `${selectedAgent.name} (副本)`,
                    );
                    setDraft(next);
                    setSelectedAgentId(agent.id);
                  }}
                  onConfirmDelete={() => setConfirmDeleteAgentId(selectedAgent.id)}
                  onDelete={() => {
                    const next = deleteCustomAgent(draft, selectedAgent.id);
                    setDraft(next);
                    setSelectedAgentId(allAgents[0]?.id ?? null);
                    setConfirmDeleteAgentId(null);
                  }}
                  onCancelDelete={() => setConfirmDeleteAgentId(null)}
                />
              )}

            </>
          )}

          {activeTab === "model" && (
            <Suspense fallback={<ModelTabFallback />}>
              <SettingsModelTab
                draft={draft}
                runtimeEndpoint={runtimeConfig.endpoint}
                activeVendor={activeVendor}
                activeModelId={activeManagedModel?.id ?? null}
                activeVendorModels={activeVendorModels}
                selectedVendorId={selectedVendorId}
                selectedVendor={selectedVendor}
                selectedVendorApiKey={selectedVendorApiKey}
                selectedVendorModels={selectedVendorModels}
                showNewVendor={showNewVendor}
                newVendorName={newVendorName}
                newVendorProtocol={newVendorProtocol}
                newVendorBaseUrl={newVendorBaseUrl}
                manualModelName={manualModelName}
                editingModelId={editingModelId}
                editingModelName={editingModelName}
                confirmDeleteVendorId={confirmDeleteVendorId}
                confirmDeleteModelId={confirmDeleteModelId}
                vendorMessage={vendorMessage}
                fetchingVendorId={fetchingVendorId}
                onSelectVendor={setSelectedVendorId}
                onSelectedVendorApiKeyChange={handleSelectedVendorApiKeyChange}
                onShowNewVendorChange={setShowNewVendor}
                onNewVendorNameChange={setNewVendorName}
                onNewVendorProtocolChange={setNewVendorProtocol}
                onNewVendorBaseUrlChange={setNewVendorBaseUrl}
                onManualModelNameChange={setManualModelName}
                onEditingModelIdChange={setEditingModelId}
                onEditingModelNameChange={setEditingModelName}
                onConfirmDeleteVendorChange={setConfirmDeleteVendorId}
                onConfirmDeleteModelChange={setConfirmDeleteModelId}
                onUpdateSelectedVendor={handleUpdateSelectedVendor}
                onUpdateProxy={handleUpdateProxy}
                onCreateVendor={handleCreateVendor}
                onDeleteVendor={handleDeleteVendor}
                onRenameModel={handleRenameModel}
                onDeleteModel={handleDeleteModel}
                onUpdateModelThinking={handleUpdateModelThinking}
                onUpdateModelMetaSettings={handleUpdateModelMetaSettings}
                onAssignFirstModelForVendor={handleAssignFirstModelForVendor}
                onFetchVendorModels={handleFetchVendorModels}
                onAddManualModel={handleAddManualModel}
                onSetActiveModel={handleSetActiveModel}
              />
            </Suspense>
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
                      <SettingsToolPermissionRow
                        key={key}
                        toolKey={key}
                        description={description}
                        value={draft.toolPermissions[key]}
                        onChange={(value) =>
                          setDraft((current) => updateToolPermission(current, key, value))
                        }
                      />
                    ))}
                  </div>
                ))}
              </div>
            </>
          )}

          {activeTab === "advanced" && (
            <AdvancedTab
              draft={draft}
              setDraft={setDraft}
              workspaceInfo={workspaceInfo}
              workspaceError={workspaceError}
              workspaceTeamTrustMode={workspaceTeamTrustMode}
              clearScope={clearScope}
              setClearScope={setClearScope}
              confirmClearScope={confirmClearScope}
              setConfirmClearScope={setConfirmClearScope}
              onWorkspaceTeamTrustModeChange={handleWorkspaceTeamTrustModeChange}
              onSelectWorkspace={handleSelectWorkspace}
              onClearWorkspaceHistory={handleClearWorkspaceHistory}
              onClearAllHistory={handleClearAllHistory}
              saveMessage={saveMessage}
              setSaveMessage={setSaveMessage}
            />
          )}
        </div>

        <SettingsPageFooter saveMessage={saveMessage} onSave={handleSave} />
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

function AgentEditor({
  agent,
  isBuiltin,
  isOverridden,
  originalBuiltin,
  vendors,
  managedModels,
  confirmDeleteId,
  onUpdate,
  onReset,
  onClone,
  onConfirmDelete,
  onDelete,
  onCancelDelete,
}: AgentEditorProps): ReactElement {
  const modelOptions = vendors.flatMap((vendor) =>
    managedModels
      .filter((managedModel) => managedModel.vendorId === vendor.id)
      .map((managedModel) => ({
        key: `${vendor.id}::${managedModel.id}`,
        label: managedModel.name,
        detail: vendor.name,
        selection: {
          vendorId: vendor.id,
          modelId: managedModel.id,
        },
      })),
  );
  const enabledTools = new Set(
    agent.toolPolicy.enabledTools && agent.toolPolicy.enabledTools.length > 0
      ? agent.toolPolicy.enabledTools
      : AGENT_TOOL_CATALOG.map((t) => t.name),
  );
  const allToolsEnabled =
    !agent.toolPolicy.enabledTools || agent.toolPolicy.enabledTools.length === 0;
  const handoffPolicy = agent.handoffPolicy ?? "none";
  const delegationEnabled = handoffPolicy !== "none" && agent.allowedSubAgents.length > 0;

  const handleToolToggle = (toolName: string, checked: boolean) => {
    let next: string[];
    if (allToolsEnabled) {
      next = AGENT_TOOL_CATALOG.map((t) => t.name).filter(
        (t) => (t === toolName ? checked : true),
      );
    } else {
      next = checked
        ? [...(agent.toolPolicy.enabledTools ?? []).filter((t) => t !== toolName), toolName]
        : (agent.toolPolicy.enabledTools ?? []).filter((t) => t !== toolName);
    }
    const allSelected = next.length === AGENT_TOOL_CATALOG.length;
    onUpdate({
      toolPolicy: {
        ...agent.toolPolicy,
        enabledTools: allSelected ? undefined : next,
      },
    });
  };

  const handleSubAgentToggle = (role: SubAgentRole, checked: boolean) => {
    const current = agent.allowedSubAgents ?? [];
    const next = checked
      ? [...current.filter((r) => r !== role), role]
      : current.filter((r) => r !== role);
    onUpdate({ allowedSubAgents: next });
  };

  return (
    <div className="settings-card agent-editor">
      <div className="settings-card-header">
        <div>
          <h3 className="settings-card-title">
            编辑 Agent
            {isBuiltin && (
              <span className="settings-section-tag">
                {isOverridden ? "内置 · 已修改" : "内置"}
              </span>
            )}
          </h3>
        </div>
      </div>

      <div className="settings-fields">
        <div className="grid-2">
          <div className="field">
            <label className="field-label">名称</label>
            <input
              className="input"
              value={agent.name}
              onChange={(e) => onUpdate({ name: e.target.value })}
              type="text"
              placeholder="Agent 名称"
            />
          </div>
          <div className="field">
            <label className="field-label">模型设置</label>
            <div className="agent-model-section">
              <label className="agent-model-checkbox">
                <input
                  type="checkbox"
                  checked={agent.useGlobalModel !== false}
                  onChange={(e) => {
                    const useGlobalModel = e.target.checked;
                    if (useGlobalModel) {
                      onUpdate({ useGlobalModel: true, modelSelection: undefined });
                    } else {
                      onUpdate({ useGlobalModel: false });
                    }
                  }}
                />
                <span>使用全局模型设置</span>
              </label>
              <div className="agent-field-hint">
                启用时，该Agent将使用您在"模型配置"中设置的全局模型。
              </div>
            </div>
            
            {agent.useGlobalModel === false && (
              <div className="agent-specific-model">
                <label className="field-label">固定模型</label>
                <select
                  className="select"
                  value={
                    agent.modelSelection
                      ? `${agent.modelSelection.vendorId}::${agent.modelSelection.modelId}`
                      : ""
                  }
                  onChange={(e) => {
                    const value = e.target.value;
                    if (!value) {
                      onUpdate({ modelSelection: undefined });
                      return;
                    }
                    const option = modelOptions.find((entry) => entry.key === value);
                    onUpdate({ modelSelection: option?.selection });
                  }}
                >
                  <option value="">选择模型</option>
                  {modelOptions.map((option) => (
                    <option key={option.key} value={option.key}>
                      {option.label} · {option.detail}
                    </option>
                  ))}
                </select>
                <div className="agent-field-hint">
                  为该Agent指定专用模型，将覆盖全局模型设置。
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="field">
          <label className="field-label">描述</label>
          <input
            className="input"
            value={agent.description}
            onChange={(e) => onUpdate({ description: e.target.value })}
            type="text"
            placeholder="简短描述该 Agent 的用途"
          />
        </div>

        <div className="field">
          <label className="field-label">系统提示词</label>
          <textarea
            className="input agent-prompt-textarea"
            value={agent.systemPromptTemplate}
            onChange={(e) => onUpdate({ systemPromptTemplate: e.target.value })}
            placeholder="定义该 Agent 的角色、行为和约束..."
            rows={6}
          />
          {isBuiltin && isOverridden && originalBuiltin && (
            <div className="agent-prompt-diff-hint">
              已修改。原始提示词共 {originalBuiltin.systemPromptTemplate.length} 字。
            </div>
          )}
        </div>

        <div className="field">
          <label className="field-label">
            可用工具
            {allToolsEnabled && (
              <span className="agent-tool-hint">全部启用</span>
            )}
          </label>
          <div className="agent-tool-grid">
            {AGENT_TOOL_CATALOG.map((tool) => (
              <label key={tool.name} className="agent-tool-item">
                <input
                  type="checkbox"
                  checked={enabledTools.has(tool.name)}
                  onChange={(e) => handleToolToggle(tool.name, e.target.checked)}
                />
                <span className="agent-tool-name">{tool.name}</span>
                <span className="agent-tool-label">{tool.label}</span>
              </label>
            ))}
          </div>
          <div className="agent-field-hint">
            `task` 的真实可用性由下面的“委派策略”和“可委派的子 Agent”共同决定；当策略为
            `none` 时，运行时不会暴露 `task`。
          </div>
        </div>

        <div className="field">
          <label className="field-label">委派策略</label>
          <select
            className="input"
            value={handoffPolicy}
            onChange={(e) =>
              onUpdate({
                handoffPolicy:
                  e.target.value === "parallel"
                    ? "parallel"
                    : e.target.value === "sequential"
                      ? "sequential"
                      : "none",
              })
            }
          >
            <option value="none">none: 禁用子 Agent / team 委派</option>
            <option value="sequential">sequential: 允许委派，按顺序执行</option>
            <option value="parallel">parallel: 允许并行委派（实验性）</option>
          </select>
          <div className="agent-field-hint">
            当前内置 Agent 默认使用 `none`，这是为了避免在配置、恢复和审批可观测性尚未完全收口前误触发多 Agent 自动化。
          </div>
          <div className="agent-field-hint">
            {delegationEnabled
              ? `当前策略会暴露 task 工具；允许委派给 ${agent.allowedSubAgents.length} 个子 Agent 角色。`
              : agent.allowedSubAgents.length === 0
                ? "当前未选择任何可委派角色，即使切换到 sequential/parallel 也不会暴露 task。"
                : "当前策略已禁用委派；如果需要启用多 Agent，请切换到 sequential 或 parallel。"}
          </div>
        </div>

        <div className="field">
          <label className="field-label">可委派的子 Agent</label>
          <div className="agent-subagent-row">
            {SUB_AGENT_ROLES.map(({ role, label }) => (
              <label key={role} className="agent-tool-item">
                <input
                  type="checkbox"
                  checked={agent.allowedSubAgents.includes(role)}
                  onChange={(e) => handleSubAgentToggle(role, e.target.checked)}
                />
                <span className="agent-tool-name">{label}</span>
              </label>
            ))}
          </div>
        </div>
      </div>

      <div className="agent-editor-actions">
        <button
          className="btn btn-ghost btn-sm"
          onClick={onClone}
          type="button"
          title="克隆为自定义 Agent"
        >
          克隆为自定义
        </button>
        {isBuiltin && isOverridden && (
          <button
            className="btn btn-ghost btn-sm"
            onClick={onReset}
            type="button"
          >
            重置为默认
          </button>
        )}
        {!isBuiltin && (
          <>
            {confirmDeleteId === agent.id ? (
              <>
                <span className="settings-delete-confirm-text">确认删除？</span>
                <button
                  className="btn btn-danger btn-sm"
                  onClick={onDelete}
                  type="button"
                >
                  删除
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={onCancelDelete}
                  type="button"
                >
                  取消
                </button>
              </>
            ) : (
              <button
                className="btn btn-danger btn-sm"
                onClick={onConfirmDelete}
                type="button"
              >
                删除 Agent
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
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

interface AdvancedTabProps {
  draft: AppSettings;
  setDraft: React.Dispatch<React.SetStateAction<AppSettings>>;
  workspaceInfo: WorkspaceInfo | null;
  workspaceError: string;
  workspaceTeamTrustMode: WorkspaceTeamTrustMode | null;
  clearScope: "workspace" | "all";
  setClearScope: (scope: "workspace" | "all") => void;
  confirmClearScope: "workspace" | "all" | null;
  setConfirmClearScope: (scope: "workspace" | "all" | null) => void;
  onWorkspaceTeamTrustModeChange: (mode: WorkspaceTeamTrustMode | null) => void;
  onSelectWorkspace: () => Promise<void>;
  onClearWorkspaceHistory: () => void;
  onClearAllHistory: () => void;
  saveMessage: string;
  setSaveMessage: (message: string) => void;
}

function AdvancedTab({
  draft,
  setDraft,
  workspaceInfo,
  workspaceError,
  workspaceTeamTrustMode,
  clearScope,
  setClearScope,
  confirmClearScope,
  setConfirmClearScope,
  onWorkspaceTeamTrustModeChange,
  onSelectWorkspace,
  onClearWorkspaceHistory,
  onClearAllHistory,
}: AdvancedTabProps): ReactElement {
  const { theme, setTheme } = useTheme();

  return (
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
              <h3 className="settings-card-title">外观</h3>
              <p className="settings-card-desc">
                选择应用的主题外观。
              </p>
            </div>
          </div>
          <div className="field">
            <label className="field-label">主题</label>
            <select
              className="select"
              value={theme}
              onChange={(e) => setTheme(e.target.value as ThemeMode)}
            >
              <option value="dark">{getThemeLabel("dark")}</option>
              <option value="light">{getThemeLabel("light")}</option>
              <option value="system">{getThemeLabel("system")}</option>
            </select>
          </div>
        </div>

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
              onClick={() => void onSelectWorkspace()}
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

        <WorkspaceTeamTrustModeField
          workspacePath={draft.workspacePath}
          mode={workspaceTeamTrustMode}
          onChange={onWorkspaceTeamTrustModeChange}
        />

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
                  setDraft((current) =>
                    updateContextSettings(current, {
                      maxSnippetLines: Number(e.target.value) as AppSettings["maxSnippetLines"],
                    }),
                  )
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
                  setDraft((current) =>
                    updateContextSettings(current, {
                      maxContextTokens: Math.max(0, Number(e.target.value) || 0),
                    }),
                  )
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
                setDraft((current) =>
                  updateContextSettings(current, {
                    sendRelativePathOnly: e.target.checked,
                  }),
                )
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
                setDraft((current) => updateAllowCloudModels(current, e.target.checked))
              }
              type="checkbox"
            />
            <span>允许使用云端模型</span>
          </label>
        </div>

        <div className="settings-card">
          <div className="settings-card-header">
            <div>
              <h3 className="settings-card-title">调试视图</h3>
              <p className="settings-card-desc">
                控制聊天页是否显示模型原始工具请求等调试信息。
              </p>
            </div>
          </div>
          <label className="field-checkbox">
            <input
              checked={draft.debugMode}
              onChange={(e) =>
                setDraft((current) => ({
                  ...current,
                  debugMode: e.target.checked,
                }))
              }
              type="checkbox"
            />
            <span>启用调试模式</span>
          </label>
        </div>

        <div className="settings-card">
          <div className="settings-card-header">
            <div>
              <h3 className="settings-card-title">清空历史</h3>
              <p className="settings-card-desc">
                可按范围删除对话记录，以及你在审批时保存的本地信任规则。当前工作区清理只影响本工作区；全局清理会删除所有工作区记录。
              </p>
            </div>
          </div>
          <div className="field">
            <label className="field-label">清理范围</label>
            <select
              className="select"
              value={clearScope}
              onChange={(e) =>
                setClearScope(e.target.value as "workspace" | "all")
              }
            >
              <option value="workspace">当前工作区</option>
              <option value="all">所有工作区</option>
            </select>
          </div>
          {confirmClearScope === clearScope ? (
            <div className="btn-row">
              <button
                className="btn btn-danger btn-sm"
                onClick={() => {
                  if (clearScope === "workspace") {
                    onClearWorkspaceHistory();
                  } else {
                    onClearAllHistory();
                  }
                }}
                type="button"
              >
                确认清空
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setConfirmClearScope(null)}
                type="button"
              >
                取消
              </button>
            </div>
          ) : (
            <button
              className="btn btn-danger btn-sm"
              onClick={() => setConfirmClearScope(clearScope)}
              type="button"
            >
              {clearScope === "workspace"
                ? "清空当前工作区数据"
                : "清空所有工作区数据"}
            </button>
          )}
        </div>
      </div>
    </>
  );
}
