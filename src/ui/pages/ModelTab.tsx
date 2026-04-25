import { useMemo, useState, type ReactElement } from "react";
import { VENDOR_PROTOCOLS, getProtocolLabel } from "../../lib/piAiBridge";
import { maskApiKey } from "../../lib/settingsStore";
import { VendorModelRow as SettingsVendorModelRow } from "./VendorModelRow";
import type { ModelTabProps } from "./settingsTypes";

export function ModelTab({
  draft,
  runtimeEndpoint,
  activeVendor,
  activeModelId,
  activeVendorModels,
  selectedVendorId,
  selectedVendor,
  selectedVendorApiKey,
  selectedVendorModels,
  showNewVendor,
  newVendorName,
  newVendorProtocol,
  newVendorBaseUrl,
  manualModelName,
  editingModelId,
  editingModelName,
  confirmDeleteVendorId,
  confirmDeleteModelId,
  vendorMessage,
  fetchingVendorId,
  onSelectVendor,
  onSelectedVendorApiKeyChange,
  onShowNewVendorChange,
  onNewVendorNameChange,
  onNewVendorProtocolChange,
  onNewVendorBaseUrlChange,
  onManualModelNameChange,
  onEditingModelIdChange,
  onEditingModelNameChange,
  onConfirmDeleteVendorChange,
  onConfirmDeleteModelChange,
  onUpdateSelectedVendor,
  onCreateVendor,
  onDeleteVendor,
  onRenameModel,
  onDeleteModel,
  onUpdateModelThinking,
  onUpdateModelMetaSettings,
  onAssignFirstModelForVendor,
  onFetchVendorModels,
  onAddManualModel,
  onSetActiveModel,
}: ModelTabProps): ReactElement {
  const [metaEditorModelId, setMetaEditorModelId] = useState<string | null>(null);
  const [metaContextWindowTokens, setMetaContextWindowTokens] = useState("0");
  const [metaMaxOutputTokens, setMetaMaxOutputTokens] = useState("0");
  const [metaTemperature, setMetaTemperature] = useState("");
  const [metaTopP, setMetaTopP] = useState("");
  const [metaFrequencyPenalty, setMetaFrequencyPenalty] = useState("");
  const [metaPresencePenalty, setMetaPresencePenalty] = useState("");
  const [metaSeed, setMetaSeed] = useState("");

  const metaEditorModel = useMemo(
    () => draft.managedModels.find((model) => model.id === metaEditorModelId) ?? null,
    [draft.managedModels, metaEditorModelId],
  );

  const openMetaEditor = (modelId: string) => {
    const target = draft.managedModels.find((model) => model.id === modelId);
    if (!target) {
      return;
    }
    setMetaEditorModelId(modelId);
    setMetaContextWindowTokens(String(target.metaSettings.contextWindowTokens));
    setMetaMaxOutputTokens(String(target.metaSettings.maxOutputTokens));
    setMetaTemperature(
      target.metaSettings.temperature !== null ? String(target.metaSettings.temperature) : "",
    );
    setMetaTopP(target.metaSettings.topP !== null ? String(target.metaSettings.topP) : "");
    setMetaFrequencyPenalty(
      target.metaSettings.frequencyPenalty !== null
        ? String(target.metaSettings.frequencyPenalty)
        : "",
    );
    setMetaPresencePenalty(
      target.metaSettings.presencePenalty !== null
        ? String(target.metaSettings.presencePenalty)
        : "",
    );
    setMetaSeed(target.metaSettings.seed !== null ? String(target.metaSettings.seed) : "");
  };

  const parseOptionalNumber = (raw: string): number | null => {
    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const saveMetaEditor = () => {
    if (!metaEditorModel) {
      return;
    }
    onUpdateModelMetaSettings(metaEditorModel.id, {
      contextWindowTokens: Math.max(0, Math.floor(Number(metaContextWindowTokens) || 0)),
      maxOutputTokens: Math.max(0, Math.floor(Number(metaMaxOutputTokens) || 0)),
      temperature: parseOptionalNumber(metaTemperature),
      topP: parseOptionalNumber(metaTopP),
      frequencyPenalty: parseOptionalNumber(metaFrequencyPenalty),
      presencePenalty: parseOptionalNumber(metaPresencePenalty),
      seed: parseOptionalNumber(metaSeed),
    });
    setMetaEditorModelId(null);
  };

  return (
    <>
      <header className="settings-pane-header">
        <h2 className="settings-pane-title">模型配置</h2>
        <p className="settings-pane-desc">
          先维护供应商和模型资源池，再为当前全局运行时指定实际要使用的供应商与模型。
        </p>
      </header>

      <div className="settings-runtime-info">
        <span className="settings-runtime-label">当前请求入口</span>
        <span className="settings-runtime-value">{runtimeEndpoint}</span>
      </div>

      <div className="settings-fields">
        <div className="settings-card">
          <div className="settings-card-header">
            <div>
              <h3 className="settings-card-title">当前全局模型</h3>
              <p className="settings-card-desc">
                所有Agent默认使用这里的全局模型设置。您可以在Agent管理中为特定Agent指定专用模型。
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
                value={activeVendor?.id ?? ""}
                onChange={(e) => onAssignFirstModelForVendor(e.target.value)}
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
                value={activeModelId ?? ""}
                onChange={(e) => onSetActiveModel(e.target.value)}
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

        <div className="vendor-master-detail">
          <aside className="vendor-master">
            <div className="vendor-master-header">
              <h3 className="settings-card-title">供应商管理</h3>
              <p className="settings-card-desc">维护供应商与模型资源池。</p>
            </div>

            <div className="vendor-master-list">
              {draft.vendors.map((vendor) => {
                const modelCount = draft.managedModels.filter(
                  (model) => model.vendorId === vendor.id,
                ).length;
                const isSelected = !showNewVendor && selectedVendorId === vendor.id;
                return (
                  <button
                    key={vendor.id}
                    className={`vendor-master-item${isSelected ? " active" : ""}`}
                    onClick={() => {
                      onShowNewVendorChange(false);
                      onSelectVendor(vendor.id);
                    }}
                    type="button"
                    title={`${vendor.name} · ${getProtocolLabel(vendor.protocol)}`}
                  >
                    <span className="vendor-master-item-name">{vendor.name}</span>
                    <span className="vendor-card-url">{vendor.baseUrl}</span>
                    <span className="vendor-card-meta">{modelCount} 个模型</span>
                  </button>
                );
              })}
            </div>

            <button
              className={`btn btn-ghost btn-sm vendor-master-new${showNewVendor ? " active" : ""}`}
              onClick={() => onShowNewVendorChange(true)}
              type="button"
            >
              + 新建供应商
            </button>
          </aside>

          <div className="vendor-detail">
            {showNewVendor ? (
              <>
                <div className="settings-card-header">
                  <div>
                    <h3 className="settings-card-title">新建供应商</h3>
                    <p className="settings-card-desc">
                      填写供应商基础信息，创建后可在右侧继续配置 API Key 与模型列表。
                    </p>
                  </div>
                </div>
                <div className="settings-fields">
                  <div className="grid-2">
                    <div className="field">
                      <label className="field-label">供应商名称</label>
                      <input
                        className="input"
                        value={newVendorName}
                        onChange={(e) => onNewVendorNameChange(e.target.value)}
                        placeholder="如 OpenAI Official"
                        type="text"
                      />
                    </div>
                    <div className="field">
                      <label className="field-label">API 协议</label>
                      <select
                        className="select"
                        value={newVendorProtocol}
                        onChange={(e) =>
                          onNewVendorProtocolChange(e.target.value as typeof newVendorProtocol)
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
                      value={newVendorBaseUrl}
                      onChange={(e) => onNewVendorBaseUrlChange(e.target.value)}
                      placeholder="https://api.example.com/v1"
                      type="text"
                    />
                  </div>
                  <div className="btn-row">
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={onCreateVendor}
                      type="button"
                    >
                      创建供应商
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => onShowNewVendorChange(false)}
                      type="button"
                    >
                      取消
                    </button>
                  </div>
                </div>
              </>
            ) : selectedVendor ? (
              <>
                <div className="settings-card-header">
                  <div>
                    <h3 className="settings-card-title">编辑供应商</h3>
                    <p className="settings-card-desc">
                      可从该供应商按协议拉取模型，也可以手动补充模型。
                    </p>
                  </div>
                  <span className="settings-card-badge">
                    {selectedVendorModels.length} 个模型
                  </span>
                </div>

                <div className="settings-fields">
                  <div className="grid-2">
                    <div className="field">
                      <label className="field-label">供应商名称</label>
                      <input
                        className="input"
                        value={selectedVendor.name}
                        onChange={(e) => onUpdateSelectedVendor({ name: e.target.value })}
                        type="text"
                      />
                    </div>
                    <div className="field">
                      <label className="field-label">API 协议</label>
                      <select
                        className="select"
                        value={selectedVendor.protocol}
                        onChange={(e) =>
                          onUpdateSelectedVendor({
                            protocol: e.target.value as typeof selectedVendor.protocol,
                          })
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
                      onChange={(e) => onUpdateSelectedVendor({ baseUrl: e.target.value })}
                      placeholder="https://api.example.com/v1"
                      type="text"
                    />
                  </div>

                  <div className="field">
                    <label className="field-label">API Key</label>
                    <input
                      className="input"
                      value={selectedVendorApiKey}
                      onChange={(e) => onSelectedVendorApiKeyChange(e.target.value)}
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
                      onClick={() => void onFetchVendorModels()}
                      type="button"
                    >
                      {fetchingVendorId === selectedVendor.id ? "拉取中..." : "Fetch 可用模型"}
                    </button>
                  </div>

                  <div className="field">
                    <label className="field-label">手动添加模型</label>
                    <div className="grid-2">
                      <input
                        className="input"
                        value={manualModelName}
                        onChange={(e) => onManualModelNameChange(e.target.value)}
                        placeholder="如 gpt-4.1、claude-sonnet-4-5 或 openai/gpt-4o"
                        type="text"
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            onAddManualModel();
                          }
                        }}
                      />
                      <button className="btn btn-ghost" onClick={onAddManualModel} type="button">
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
                          <SettingsVendorModelRow
                            key={model.id}
                            model={model}
                            isEditing={editingModelId === model.id}
                            editingName={editingModelId === model.id ? editingModelName : ""}
                            confirmDelete={confirmDeleteModelId === model.id}
                            canDelete={selectedVendorModels.length > 1}
                            onStartEdit={() => {
                              onEditingModelIdChange(model.id);
                              onEditingModelNameChange(model.name);
                            }}
                            onEditChange={onEditingModelNameChange}
                            onSaveEdit={() => onRenameModel(model.id)}
                            onCancelEdit={() => {
                              onEditingModelIdChange(null);
                              onEditingModelNameChange("");
                            }}
                            onConfirmDelete={() => onConfirmDeleteModelChange(model.id)}
                            onDelete={() => onDeleteModel(model.id)}
                            onCancelDelete={() => onConfirmDeleteModelChange(null)}
                            onThinkingSupportChange={(value) =>
                              onUpdateModelThinking(model.id, { supportsThinking: value })
                            }
                            onThinkingLevelChange={(value) =>
                              onUpdateModelThinking(model.id, { thinkingLevel: value })
                            }
                            onOpenMetaSettings={() => openMetaEditor(model.id)}
                          />
                        ))}
                      </div>
                    ) : (
                      <div className="settings-empty-hint">
                        暂无模型。你可以先 Fetch，可手动添加。
                      </div>
                    )}
                  </div>

                  <div className="vendor-detail-danger">
                    {confirmDeleteVendorId === selectedVendor.id ? (
                      <div className="btn-row">
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => void onDeleteVendor(selectedVendor.id)}
                          type="button"
                        >
                          确认删除该供应商
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => onConfirmDeleteVendorChange(null)}
                          type="button"
                        >
                          取消
                        </button>
                      </div>
                    ) : (
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={draft.vendors.length <= 1}
                        onClick={() => onConfirmDeleteVendorChange(selectedVendor.id)}
                        type="button"
                        title={
                          draft.vendors.length > 1
                            ? "删除该供应商及其所有模型"
                            : "唯一供应商不能删除"
                        }
                      >
                        删除该供应商
                      </button>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <div className="vendor-detail-empty">请从左侧选择或新建供应商</div>
            )}
          </div>
        </div>

      </div>

      {metaEditorModel && (
        <div className="model-picker-backdrop" role="presentation">
          <div className="model-picker model-meta-editor">
            <div className="model-picker-header">
              <h3 className="model-picker-title">模型元设置 · {metaEditorModel.name}</h3>
              <p className="model-picker-desc">
                每个模型独立生效。留空表示自动值，Token 设为 0 表示不强制覆盖。
              </p>
            </div>

            <div className="model-meta-editor-body">
              <div className="grid-2">
                <div className="field">
                  <label className="field-label">上下文窗口 Token</label>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    step={1024}
                    value={metaContextWindowTokens}
                    onChange={(e) => setMetaContextWindowTokens(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label className="field-label">最大输出 Token</label>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    step={128}
                    value={metaMaxOutputTokens}
                    onChange={(e) => setMetaMaxOutputTokens(e.target.value)}
                  />
                </div>
              </div>

              <div className="grid-2">
                <div className="field">
                  <label className="field-label">Temperature (0-2)</label>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    max={2}
                    step={0.1}
                    value={metaTemperature}
                    onChange={(e) => setMetaTemperature(e.target.value)}
                    placeholder="自动"
                  />
                </div>
                <div className="field">
                  <label className="field-label">Top P (0-1)</label>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={metaTopP}
                    onChange={(e) => setMetaTopP(e.target.value)}
                    placeholder="自动"
                  />
                </div>
              </div>

              <div className="grid-2">
                <div className="field">
                  <label className="field-label">Frequency Penalty (-2 到 2)</label>
                  <input
                    className="input"
                    type="number"
                    min={-2}
                    max={2}
                    step={0.1}
                    value={metaFrequencyPenalty}
                    onChange={(e) => setMetaFrequencyPenalty(e.target.value)}
                    placeholder="自动"
                  />
                </div>
                <div className="field">
                  <label className="field-label">Presence Penalty (-2 到 2)</label>
                  <input
                    className="input"
                    type="number"
                    min={-2}
                    max={2}
                    step={0.1}
                    value={metaPresencePenalty}
                    onChange={(e) => setMetaPresencePenalty(e.target.value)}
                    placeholder="自动"
                  />
                </div>
              </div>

              <div className="field">
                <label className="field-label">Seed（可复现）</label>
                <input
                  className="input"
                  type="number"
                  min={0}
                  step={1}
                  value={metaSeed}
                  onChange={(e) => setMetaSeed(e.target.value)}
                  placeholder="自动"
                />
              </div>
            </div>

            <div className="model-picker-footer">
              <button className="btn btn-primary btn-sm" onClick={saveMetaEditor} type="button">
                保存
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setMetaEditorModelId(null)} type="button">
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
