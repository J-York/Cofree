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
  createVendor,
  deleteManagedModel,
  deleteVendor,
  deleteVendorApiKey,
  getActiveManagedModel,
  getActiveVendor,
  getVendorById,
  listManagedModelsForVendor,
  loadVendorApiKey,
  setActiveManagedModelSelection,
  setActiveVendorSelection,
  syncRuntimeSettings,
  updateAllowCloudModels,
  updateContextSettings,
  updateManagedModel,
  updateProxySettings,
  updateToolPermission,
  updateVendor,
  updateWorkspacePath,
} from "../../lib/settingsStore";
import {
  clearAllConversations,
  clearWorkspaceConversations,
} from "../../lib/conversationMaintenance";
import { SettingsNav as SettingsNavRail } from "./SettingsNav";
import { SettingsFooter as SettingsPageFooter } from "./SettingsFooter";
import { ToolPermissionRow as SettingsToolPermissionRow } from "./ToolPermissionRow";
import {
  type ModelPickerOverlayProps,
  type SettingsPageProps,
  type SettingsTab,
  type WorkspaceInfo,
} from "./settingsTypes";
import { useTheme, getThemeLabel, type ThemeMode } from "../../hooks/useTheme";
import { SkillTab } from "./SkillTab";
import { SnippetTab } from "./SnippetTab";
import { AuditTab } from "./AuditTab";

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

export function SettingsPage({
  settings,
  onSave,
  onClose,
}: SettingsPageProps): ReactElement {
  const [activeTab, setActiveTab] = useState<SettingsTab>("model");
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [saveMessage, setSaveMessage] = useState<string>("");
  const [workspaceInfo, setWorkspaceInfo] = useState<WorkspaceInfo | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string>("");
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
    setSelectedVendorId((current) => resolveSelectedVendorId(settings, current));
    setVendorApiKeys({});
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
      Pick<
        AppSettings["managedModels"][number],
        "supportsThinking" | "thinkingLevel" | "thinkingBudgetTokens"
      >
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
          {activeTab === "skills" && (
            <SkillTab draft={draft} setDraft={setDraft} />
          )}

          {activeTab === "snippets" && (
            <SnippetTab draft={draft} setDraft={setDraft} />
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
              clearScope={clearScope}
              setClearScope={setClearScope}
              confirmClearScope={confirmClearScope}
              setConfirmClearScope={setConfirmClearScope}
              onSelectWorkspace={handleSelectWorkspace}
              onClearWorkspaceHistory={handleClearWorkspaceHistory}
              onClearAllHistory={handleClearAllHistory}
              onUpdateProxy={handleUpdateProxy}
              onOpenAudit={() => setActiveTab("audit")}
              saveMessage={saveMessage}
              setSaveMessage={setSaveMessage}
            />
          )}

          {activeTab === "audit" && <AuditTab onBack={() => setActiveTab("advanced")} />}
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
  clearScope: "workspace" | "all";
  setClearScope: (scope: "workspace" | "all") => void;
  confirmClearScope: "workspace" | "all" | null;
  setConfirmClearScope: (scope: "workspace" | "all" | null) => void;
  onSelectWorkspace: () => Promise<void>;
  onClearWorkspaceHistory: () => void;
  onClearAllHistory: () => void;
  onUpdateProxy: (updates: Partial<AppSettings["proxy"]>) => void;
  onOpenAudit: () => void;
  saveMessage: string;
  setSaveMessage: (message: string) => void;
}

function AdvancedTab({
  draft,
  setDraft,
  workspaceInfo,
  workspaceError,
  clearScope,
  setClearScope,
  confirmClearScope,
  setConfirmClearScope,
  onSelectWorkspace,
  onClearWorkspaceHistory,
  onClearAllHistory,
  onUpdateProxy,
  onOpenAudit,
}: AdvancedTabProps): ReactElement {
  const { theme, setTheme } = useTheme();

  return (
    <>
      <header className="settings-pane-header">
        <h2 className="settings-pane-title">高级</h2>
        <p className="settings-pane-desc">
          外观、工作区、网络代理以及历史清理。更细的开发者选项在下方折叠区内。
        </p>
      </header>

      <div className="settings-fields">
        <div className="settings-card">
          <div className="settings-card-header">
            <div>
              <h3 className="settings-card-title">外观</h3>
              <p className="settings-card-desc">选择应用的主题外观。</p>
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

        <div className="settings-card">
          <div className="settings-card-header">
            <div>
              <h3 className="settings-card-title">网络代理</h3>
              <p className="settings-card-desc">
                仅在 Tauri 桌面端生效。关闭时将遵循系统代理。
              </p>
            </div>
          </div>
          <div className="grid-2">
            <div className="field">
              <label className="field-label">代理模式</label>
              <select
                className="select"
                value={draft.proxy.mode}
                onChange={(e) =>
                  onUpdateProxy({
                    mode: e.target.value as AppSettings["proxy"]["mode"],
                  })
                }
              >
                <option value="off">关闭</option>
                <option value="http">HTTP</option>
                <option value="https">HTTPS</option>
                <option value="socks5">SOCKS5</option>
              </select>
            </div>
            <div className="field">
              <label className="field-label">代理地址</label>
              <input
                className="input"
                value={draft.proxy.url}
                onChange={(e) => onUpdateProxy({ url: e.target.value })}
                placeholder="http://127.0.0.1:7890"
                type="text"
              />
            </div>
          </div>
        </div>

        <div className="settings-card">
          <div className="settings-card-header">
            <div>
              <h3 className="settings-card-title">清空历史</h3>
              <p className="settings-card-desc">
                按范围删除对话记录及审批时保存的本地信任规则。当前工作区清理只影响本工作区；全局清理会删除所有工作区记录。
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

        <details className="settings-dev-details">
          <summary className="settings-dev-summary">
            <span className="settings-dev-summary-title">开发者选项</span>
            <span className="settings-dev-summary-hint">
              上下文、调试与审计日志
            </span>
          </summary>

          <div className="settings-dev-body">
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
                    关闭后将阻止非本地模型在当前环境中发送请求。
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
                  <h3 className="settings-card-title">审计日志</h3>
                  <p className="settings-card-desc">
                    查看工具调用、错误与审批事件的历史记录。
                  </p>
                </div>
              </div>
              <div className="btn-row">
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={onOpenAudit}
                  type="button"
                >
                  打开审计日志
                </button>
              </div>
            </div>
          </div>
        </details>
      </div>
    </>
  );
}
