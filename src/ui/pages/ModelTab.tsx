import type { ReactElement } from "react";
import { VENDOR_PROTOCOLS, getProtocolLabel } from "../../lib/litellm";
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
  onUpdateProxy,
  onCreateVendor,
  onDeleteVendor,
  onRenameModel,
  onDeleteModel,
  onUpdateModelThinking,
  onAssignFirstModelForVendor,
  onFetchVendorModels,
  onAddManualModel,
  onSetActiveModel,
}: ModelTabProps): ReactElement {
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
                未固定模型的 Agent 会跟随这里的供应商与模型；固定模型的 Agent 会覆盖这里的默认值。
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

        <div className="settings-card">
          <div className="settings-card-header">
            <div>
              <h3 className="settings-card-title">供应商管理</h3>
              <p className="settings-card-desc">
                这里只维护供应商配置与模型列表；全局默认模型和 Agent 固定模型都从这里的资源池中选择。
              </p>
            </div>
          </div>

          <div className="vendor-card-list">
            {draft.vendors.map((vendor) => {
              const canDeleteVendor = draft.vendors.length > 1;
              return (
                <div
                  key={vendor.id}
                  className={`vendor-card${selectedVendorId === vendor.id ? " active" : ""}`}
                >
                  <button
                    className="vendor-card-main"
                    onClick={() => onSelectVendor(vendor.id)}
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
                      {draft.managedModels.filter((model) => model.vendorId === vendor.id).length} 个模型
                    </span>
                  </button>
                  <div className="vendor-card-actions">
                    {confirmDeleteVendorId === vendor.id ? (
                      <>
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => void onDeleteVendor(vendor.id)}
                          type="button"
                        >
                          确认删除
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => onConfirmDeleteVendorChange(null)}
                          type="button"
                        >
                          取消
                        </button>
                      </>
                    ) : (
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={!canDeleteVendor}
                        onClick={() => onConfirmDeleteVendorChange(vendor.id)}
                        type="button"
                        title={canDeleteVendor ? "删除供应商" : "唯一供应商不能删除"}
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
                  onChange={(e) => onNewVendorNameChange(e.target.value)}
                  placeholder="供应商名称，如 OpenAI Official"
                  type="text"
                />
                <select
                  className="select"
                  value={newVendorProtocol}
                  onChange={(e) => onNewVendorProtocolChange(e.target.value as typeof newVendorProtocol)}
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
                onChange={(e) => onNewVendorBaseUrlChange(e.target.value)}
                placeholder="https://api.example.com/v1"
                type="text"
              />
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
          ) : (
            <button
              className="btn btn-ghost btn-sm settings-inline-action"
              onClick={() => onShowNewVendorChange(true)}
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
                onUpdateProxy({
                  mode: e.target.value as typeof draft.proxy.mode,
                })
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
              onChange={(e) => onUpdateProxy({ url: e.target.value })}
              placeholder="http://127.0.0.1:7890"
              type="text"
            />
          </div>
        </div>
      </div>
    </>
  );
}
