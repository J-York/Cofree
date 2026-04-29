import type { ReactElement } from "react";
import type { VendorModelRowProps } from "./settingsTypes";

const THINKING_LEVEL_LABELS = {
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
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
  onThinkingBudgetTokensChange,
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
                  <option value="minimal">极低 (minimal)</option>
                  <option value="low">低</option>
                  <option value="medium">中</option>
                  <option value="high">高</option>
                  <option value="xhigh">极高 (xhigh / max)</option>
                </select>
              </div>
              <div className="vendor-model-thinking-budget">
                <span className="vendor-model-thinking-label">
                  思考预算
                  <span className="vendor-model-thinking-hint">
                    （Claude / Gemini 可选，留空使用默认）
                  </span>
                </span>
                <input
                  className="input vendor-model-thinking-budget-input"
                  disabled={
                    !model.supportsThinking || model.thinkingLevel === "xhigh"
                  }
                  inputMode="numeric"
                  min={0}
                  onChange={(e) => {
                    const raw = e.target.value.trim();
                    if (raw === "") {
                      onThinkingBudgetTokensChange(null);
                      return;
                    }
                    const parsed = Number(raw);
                    if (!Number.isFinite(parsed) || parsed <= 0) {
                      onThinkingBudgetTokensChange(null);
                      return;
                    }
                    onThinkingBudgetTokensChange(Math.floor(parsed));
                  }}
                  placeholder="tokens"
                  type="number"
                  value={
                    typeof model.thinkingBudgetTokens === "number" &&
                    model.thinkingBudgetTokens > 0
                      ? String(model.thinkingBudgetTokens)
                      : ""
                  }
                />
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