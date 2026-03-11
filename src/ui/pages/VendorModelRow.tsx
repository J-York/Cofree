import type { ReactElement } from "react";
import type { VendorModelRowProps } from "./settingsTypes";

const THINKING_LEVEL_LABELS = {
  low: "低",
  medium: "中",
  high: "高",
} as const;

export function VendorModelRow({
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
  onThinkingSupportChange,
  onThinkingLevelChange,
  onOpenMetaSettings,
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
          <span className="settings-delete-confirm-text">确认删除该模型？</span>
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
            <div className="vendor-model-row-meta">
              <span className="vendor-model-row-source">
                {model.source === "fetched" ? "Fetch" : "Manual"}
              </span>
              <span
                className={`vendor-model-row-thinking-pill${model.supportsThinking ? " enabled" : ""}`}
>
                {model.supportsThinking
                  ? `思考 · ${THINKING_LEVEL_LABELS[model.thinkingLevel]}`
                  : "思考关闭"}
              </span>
            </div>
            <div className="vendor-model-thinking-controls">
              <label className="checkbox-row vendor-model-thinking-toggle">
                <input
                  checked={model.supportsThinking}
                  onChange={(e) => onThinkingSupportChange(e.target.checked)}
                  type="checkbox"
                />
                <span className="checkbox-label">支持思考</span>
              </label>
              <div className="vendor-model-thinking-level">
                <span className="vendor-model-thinking-label">思考程度</span>
                <select
                  className="select vendor-model-thinking-select"
                  disabled={!model.supportsThinking}
                  onChange={(e) =>
                    onThinkingLevelChange(e.target.value as typeof model.thinkingLevel)
                  }
                  value={model.thinkingLevel}
                >
                  <option value="low">低</option>
                  <option value="medium">中</option>
                  <option value="high">高</option>
                </select>
              </div>
            </div>
          </div>
          <div className="vendor-model-row-actions">
            <button className="btn btn-ghost btn-sm" onClick={onOpenMetaSettings} type="button">
              元设置
            </button>
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