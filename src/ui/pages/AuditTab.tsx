import { useMemo, useState, type ReactElement } from "react";
import {
  readErrorAuditRecords,
  readLLMAuditRecords,
  readSensitiveActionAuditRecords,
  clearErrorAuditRecords,
  exportAuditToJSON,
  exportAuditToCSV,
  type ErrorAuditRecord,
} from "../../lib/auditLog";
import { copyTextToClipboard } from "../../lib/clipboard";

const ERROR_CATEGORY_LABELS: Record<string, string> = {
  llm_failure: "模型服务异常",
  network_timeout: "网络超时",
  patch_conflict: "补丁冲突",
  workspace_error: "工作区错误",
  auth_error: "认证失败",
  abort: "已取消",
  unknown: "未知错误",
};

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

function ErrorRow({
  record,
  expanded,
  onToggle,
}: {
  record: ErrorAuditRecord;
  expanded: boolean;
  onToggle: () => void;
}): ReactElement {
  return (
    <div className="audit-row" onClick={onToggle}>
      <div className="audit-row-summary">
        <span className="audit-time">{formatTime(record.timestamp)}</span>
        <span className={`audit-category-badge cat-${record.category}`}>
          {ERROR_CATEGORY_LABELS[record.category] ?? record.category}
        </span>
        <span className="audit-title">{record.title}</span>
      </div>
      {expanded && (
        <div className="audit-row-detail">
          <p><strong>消息：</strong>{record.message}</p>
          {record.guidance && <p><strong>建议：</strong>{record.guidance}</p>}
          {record.rawError && (
            <pre className="audit-raw-error">{record.rawError}</pre>
          )}
          <p>
            <strong>可重试：</strong>{record.retriable ? "是" : "否"}
          </p>
        </div>
      )}
    </div>
  );
}

export function AuditTab(): ReactElement {
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [note, setNote] = useState<string>("");
  const [refreshKey, setRefreshKey] = useState(0);

  const errors = useMemo(
    () => readErrorAuditRecords(),
    [refreshKey],
  );
  const llmRecords = useMemo(
    () => readLLMAuditRecords().slice(0, 50),
    [refreshKey],
  );
  const actionRecords = useMemo(
    () => readSensitiveActionAuditRecords().slice(0, 50),
    [refreshKey],
  );

  const filteredErrors = useMemo(
    () =>
      categoryFilter === "all"
        ? errors
        : errors.filter((r) => r.category === categoryFilter),
    [errors, categoryFilter],
  );

  const handleClearErrors = (): void => {
    clearErrorAuditRecords();
    setExpandedIdx(null);
    setRefreshKey((k) => k + 1);
    setNote("已清空错误日志");
  };

  const handleCopyJSON = async (): Promise<void> => {
    try {
      await copyTextToClipboard(exportAuditToJSON());
      setNote("已复制 JSON 到剪贴板");
    } catch {
      setNote("复制失败");
    }
  };

  const handleCopyCSV = async (): Promise<void> => {
    try {
      await copyTextToClipboard(exportAuditToCSV());
      setNote("已复制 CSV 到剪贴板");
    } catch {
      setNote("复制失败");
    }
  };

  return (
    <div className="settings-pane">
      <header className="settings-pane-header">
        <h2 className="settings-pane-title">审计日志</h2>
        <p className="settings-pane-desc">
          查看错误分类、LLM 请求和敏感操作的审计记录，支持问题回放和调试导出。
        </p>
        {note && <p className="status-note">{note}</p>}
      </header>

      <div className="settings-fields">
        {/* 错误日志 */}
        <div className="settings-card">
          <div className="settings-card-header">
            <h3 className="settings-card-title">错误日志（{filteredErrors.length}）</h3>
            <div className="btn-row">
              <select
                className="select"
                value={categoryFilter}
                onChange={(e) => {
                  setCategoryFilter(e.target.value);
                  setExpandedIdx(null);
                }}
              >
                <option value="all">全部分类</option>
                {Object.entries(ERROR_CATEGORY_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>{label}</option>
                ))}
              </select>
              <button className="btn btn-ghost btn-sm" onClick={handleClearErrors}>
                清空
              </button>
            </div>
          </div>
          {filteredErrors.length === 0 ? (
            <p className="status-note">暂无错误记录</p>
          ) : (
            <div className="audit-list">
              {filteredErrors.map((record, idx) => (
                <ErrorRow
                  key={`${record.timestamp}-${idx}`}
                  record={record}
                  expanded={expandedIdx === idx}
                  onToggle={() => setExpandedIdx(expandedIdx === idx ? null : idx)}
                />
              ))}
            </div>
          )}
        </div>

        {/* LLM 请求审计 */}
        <div className="settings-card">
          <div className="settings-card-header">
            <h3 className="settings-card-title">LLM 请求（{llmRecords.length}）</h3>
          </div>
          {llmRecords.length === 0 ? (
            <p className="status-note">暂无 LLM 请求记录</p>
          ) : (
            <div className="audit-list">
              {llmRecords.map((r, i) => (
                <div key={`${r.requestId}-${i}`} className="audit-row">
                  <div className="audit-row-summary">
                    <span className="audit-time">{formatTime(r.timestamp)}</span>
                    <span className="audit-title">{r.model}</span>
                    <span className="audit-meta">
                      {r.provider} · in {r.inputLength} / out {r.outputLength}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 操作审计 */}
        <div className="settings-card">
          <div className="settings-card-header">
            <h3 className="settings-card-title">操作审计（{actionRecords.length}）</h3>
          </div>
          {actionRecords.length === 0 ? (
            <p className="status-note">暂无操作记录</p>
          ) : (
            <div className="audit-list">
              {actionRecords.map((r, i) => (
                <div key={`${r.actionId}-${i}`} className="audit-row">
                  <div className="audit-row-summary">
                    <span className="audit-time">{formatTime(r.startedAt)}</span>
                    <span className={`audit-category-badge cat-${r.status}`}>
                      {r.status === "success" ? "成功" : "失败"}
                    </span>
                    <span className="audit-title">{r.actionType}</span>
                    <span className="audit-meta">{r.executor}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 导出 */}
        <div className="settings-card">
          <div className="settings-card-header">
            <h3 className="settings-card-title">导出</h3>
          </div>
          <div className="btn-row">
            <button className="btn btn-ghost btn-sm" onClick={handleCopyJSON}>
              复制 JSON
            </button>
            <button className="btn btn-ghost btn-sm" onClick={handleCopyCSV}>
              复制 CSV
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
