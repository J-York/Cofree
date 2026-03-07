import type { ReactElement } from "react";
import type { VendorModelRowProps } from "./settingsTypes";

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
