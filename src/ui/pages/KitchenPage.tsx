import { type ReactElement, useMemo, useState } from "react";
import { useSession, type WorkflowPhase } from "../../lib/sessionContext";
import {
  readLLMAuditRecords,
  readSensitiveActionAuditRecords,
  exportAuditToJSON,
  exportAuditToCSV,
} from "../../lib/auditLog";
import { invoke } from "@tauri-apps/api/core";

const FLOW_STEPS: WorkflowPhase[] = ["idle", "planning", "executing", "human_review", "done"];

const PHASE_LABELS: Record<WorkflowPhase, string> = {
  idle: "空闲",
  planning: "规划中",
  executing: "执行中",
  human_review: "人工审批",
  done: "完成",
  error: "出错",
};

type AuditTab = "llm" | "action";

export function KitchenPage(): ReactElement {
  const { state } = useSession();
  const [auditTab, setAuditTab] = useState<AuditTab>("llm");

  const llmRecords = useMemo(() => readLLMAuditRecords(), [auditTab]);
  const actionRecords = useMemo(() => readSensitiveActionAuditRecords(), [auditTab]);

  const totalInputTokens = useMemo(
    () => state.requestSummaries.reduce((sum, r) => sum + r.inputTokens, 0),
    [state.requestSummaries]
  );
  const totalOutputTokens = useMemo(
    () => state.requestSummaries.reduce((sum, r) => sum + r.outputTokens, 0),
    [state.requestSummaries]
  );
  const totalDurationMs = useMemo(
    () => state.requestSummaries.reduce((sum, r) => sum + r.durationMs, 0),
    [state.requestSummaries]
  );

  const handleExportJSON = async () => {
    try {
      const content = exportAuditToJSON();
      await invoke("save_file_dialog", {
        fileName: `cofree-audit-${Date.now()}.json`,
        content,
      });
    } catch (_) {
      // User cancelled or error
    }
  };

  const handleExportCSV = async () => {
    try {
      const content = exportAuditToCSV();
      await invoke("save_file_dialog", {
        fileName: `cofree-audit-${Date.now()}.csv`,
        content,
      });
    } catch (_) {
      // User cancelled or error
    }
  };

  const successTraces = state.toolTraces.filter(t => t.status === "success").length;
  const failedTraces = state.toolTraces.filter(t => t.status !== "success").length;

  return (
    <div className="page-content">
      <div className="page-header">
        <h1 className="page-title">控制台</h1>
        <p className="page-subtitle">工作流监控 · 工具追踪 · 审计日志</p>
      </div>

      {/* ── Workflow Phase ── */}
      <div className="card">
        <p className="card-title">工作流状态</p>
        <div className="kitchen-flow">
          {FLOW_STEPS.map((step, i) => (
            <div key={step} className="kitchen-flow-step">
              <span
                className={`kitchen-flow-label${
                  state.workflowPhase === step ? " active" : ""
                }`}
              >
                {PHASE_LABELS[step]}
              </span>
              {i < FLOW_STEPS.length - 1 && (
                <span className="kitchen-flow-arrow">→</span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* ── Stats Grid ── */}
      <div className="kitchen-stats-grid">
        <div className="kitchen-stat">
          <span className="kitchen-stat-value">{state.requestSummaries.length}</span>
          <span className="kitchen-stat-label">LLM 请求</span>
        </div>
        <div className="kitchen-stat">
          <span className="kitchen-stat-value">{state.toolTraces.length}</span>
          <span className="kitchen-stat-label">工具调用</span>
        </div>
        <div className="kitchen-stat">
          <span className="kitchen-stat-value">
            {state.toolTraces.filter(t => t.name === "task").length || "—"}
          </span>
          <span className="kitchen-stat-label">子 Agent / 团队任务</span>
        </div>
        <div className="kitchen-stat">
          <span className="kitchen-stat-value">
            {totalInputTokens > 0 ? `${Math.round(totalInputTokens / 1000)}k` : "—"}
          </span>
          <span className="kitchen-stat-label">输入 Tokens</span>
        </div>
        <div className="kitchen-stat">
          <span className="kitchen-stat-value">
            {totalOutputTokens > 0 ? `${Math.round(totalOutputTokens / 1000)}k` : "—"}
          </span>
          <span className="kitchen-stat-label">输出 Tokens</span>
        </div>
        <div className="kitchen-stat">
          <span className="kitchen-stat-value">
            {totalDurationMs > 0 ? `${(totalDurationMs / 1000).toFixed(1)}s` : "—"}
          </span>
          <span className="kitchen-stat-label">总耗时</span>
        </div>
      </div>

      {/* ── Tool Call Timeline ── */}
      <div className="card">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
          <p className="card-title" style={{ margin: 0 }}>工具调用追踪</p>
          {state.toolTraces.length > 0 && (
            <div style={{ display: "flex", gap: "8px" }}>
              <span className="badge badge-success">{successTraces} 成功</span>
              {failedTraces > 0 && <span className="badge badge-error">{failedTraces} 失败</span>}
            </div>
          )}
        </div>
        {state.toolTraces.length === 0 ? (
          <div style={{ textAlign: "center", padding: "32px 0" }}>
            <div style={{ fontSize: "32px", opacity: 0.3, marginBottom: "8px" }}>📊</div>
            <p className="status-note">暂无工具调用记录</p>
            <p style={{ fontSize: "13px", color: "var(--text-3)", margin: "4px 0 0" }}>发送消息后将显示详细追踪</p>
          </div>
        ) : (
          <div className="kitchen-timeline">
            {state.toolTraces.map((trace, i) => (
              <div
                key={`${trace.name}-${i}`}
                className={`kitchen-timeline-item ${
                  trace.status === "success" ? "success" : "failed"
                }`}
              >
                <div className="kitchen-timeline-dot" />
                <div className="kitchen-timeline-content">
                  <div className="kitchen-timeline-head">
                    <span className="kitchen-timeline-name">{trace.name}</span>
                    <span
                      className={`badge ${
                        trace.status === "success" ? "badge-success" : "badge-error"
                      }`}
                    >
                      {trace.status === "success" ? "成功" : "失败"}
                    </span>
                    {trace.startedAt && trace.finishedAt && (
                      <span className="badge badge-default">
                        {new Date(trace.finishedAt).getTime() - new Date(trace.startedAt).getTime()}ms
                      </span>
                    )}
                  </div>
                  {trace.resultPreview && (
                    <pre className="kitchen-timeline-preview">
                      {trace.resultPreview.slice(0, 300)}
                    </pre>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Audit Log ── */}
      <div className="card">
        <div className="audit-header">
          <p className="card-title" style={{ margin: 0 }}>审计日志</p>
          <div className="btn-row">
            <button className="btn btn-ghost btn-sm" onClick={handleExportJSON} type="button">
              导出 JSON
            </button>
            <button className="btn btn-ghost btn-sm" onClick={handleExportCSV} type="button">
              导出 CSV
            </button>
          </div>
        </div>

        <div className="audit-tabs">
          <button
            className={`btn btn-sm ${auditTab === "llm" ? "btn-primary" : "btn-ghost"}`}
            onClick={() => setAuditTab("llm")}
            type="button"
          >
            LLM 请求 ({llmRecords.length})
          </button>
          <button
            className={`btn btn-sm ${auditTab === "action" ? "btn-primary" : "btn-ghost"}`}
            onClick={() => setAuditTab("action")}
            type="button"
          >
            敏感操作 ({actionRecords.length})
          </button>
        </div>

        {auditTab === "llm" && (
          <div className="audit-list">
            {llmRecords.length === 0 ? (
              <div style={{ textAlign: "center", padding: "24px 0" }}>
                <p className="status-note">暂无 LLM 请求记录</p>
              </div>
            ) : (
              llmRecords.slice(0, 50).map((r) => (
                <div key={r.requestId} className="audit-item">
                  <div className="audit-item-head">
                    <span className="audit-item-model">{r.provider}/{r.model}</span>
                    <span className="audit-item-time">{new Date(r.timestamp).toLocaleString()}</span>
                  </div>
                  <div className="audit-item-meta">
                    <span>入 {r.inputLength} 字符</span>
                    <span>出 {r.outputLength} 字符</span>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {auditTab === "action" && (
          <div className="audit-list">
            {actionRecords.length === 0 ? (
              <div style={{ textAlign: "center", padding: "24px 0" }}>
                <p className="status-note">暂无敏感操作记录</p>
              </div>
            ) : (
              actionRecords.slice(0, 50).map((r) => (
                <div key={r.actionId} className="audit-item">
                  <div className="audit-item-head">
                    <span className="audit-item-model">{r.actionType}</span>
                    <span className={`badge ${r.status === "success" ? "badge-success" : "badge-error"}`}>
                      {r.status}
                    </span>
                    <span className="audit-item-time">{new Date(r.startedAt).toLocaleString()}</span>
                  </div>
                  <div className="audit-item-meta">
                    <span>{r.executor}</span>
                    {r.reason && <span>{r.reason.slice(0, 80)}</span>}
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
