import { type ReactElement, useEffect, useMemo, useRef, useState } from "react";
import {
  clearChatHistory,
  loadChatHistory,
  saveChatHistory,
  type ChatMessageRecord
} from "../../lib/chatHistoryStore";
import { isLocalProvider } from "../../lib/litellm";
import type { AppSettings } from "../../lib/settingsStore";
import {
  approveAction,
  commentAction,
  markActionRunning,
  rejectAction,
  updateActionPayload
} from "../../orchestrator/hitlService";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  getChatSessionId,
  loadLatestWorkflowCheckpoint,
  resetChatSessionId,
  saveWorkflowCheckpoint
} from "../../orchestrator/checkpointStore";
import {
  runPlanningSession,
  type PlanningSessionPhase,
  type ToolExecutionTrace
} from "../../orchestrator/planningService";
import type { ActionProposal, OrchestrationPlan } from "../../orchestrator/types";

interface ChatPageProps {
  settings: AppSettings;
}

interface RunChatCycleOptions {
  visibleUserMessage?: boolean;
  internalSystemNote?: string;
  phase?: PlanningSessionPhase;
}

function createMessageId(role: "user" | "assistant"): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${role}-${crypto.randomUUID()}`;
  }
  return `${role}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function toConversationHistory(
  records: ChatMessageRecord[]
): Array<{ role: "user" | "assistant"; content: string }> {
  return records
    .filter((record) => Boolean(record.content.trim()))
    .map((record) => ({
      role: record.role,
      content: record.content.trim()
    }));
}

function canApproveAction(action: ActionProposal): boolean {
  return action.status === "pending" || action.status === "failed";
}

function canReviewAction(action: ActionProposal): boolean {
  return action.status === "pending" || action.status === "failed";
}

function markActionExecutionError(
  plan: OrchestrationPlan,
  actionId: string,
  reason: string
): OrchestrationPlan {
  const timestamp = new Date().toISOString();
  const nextActions = plan.proposedActions.map((action) =>
    action.id === actionId
      ? {
          ...action,
          status: "failed" as const,
          executed: false,
          executionResult: { success: false, message: reason, timestamp }
        }
      : action
  );
  return { ...plan, state: "human_review", proposedActions: nextActions };
}

function formatTime(isoTime: string): string {
  const ts = new Date(isoTime);
  if (Number.isNaN(ts.getTime())) return "";
  return ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function actionStatusBadgeClass(status: string): string {
  if (status === "completed" || status === "success") return "badge badge-success";
  if (status === "failed" || status === "rejected") return "badge badge-error";
  if (status === "running") return "badge badge-warning";
  return "badge badge-default";
}

type PatchPreviewLineKind = "file" | "meta" | "hunk" | "add" | "remove" | "context";

interface PatchPreviewLine {
  text: string;
  kind: PatchPreviewLineKind;
}

interface PatchFileSummary {
  path: string;
  additions: number;
  deletions: number;
  hunks: number;
}

interface PatchPreviewData {
  files: PatchFileSummary[];
  additions: number;
  deletions: number;
  hunks: number;
  lines: PatchPreviewLine[];
  truncated: boolean;
}

const MAX_PATCH_PREVIEW_LINES = 180;
const MAX_PATCH_SUMMARY_FILES = 8;

function classifyPatchLine(line: string): PatchPreviewLineKind {
  if (line.startsWith("diff --git ")) return "file";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+") && !line.startsWith("+++")) return "add";
  if (line.startsWith("-") && !line.startsWith("---")) return "remove";
  if (line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("new file mode ")) {
    return "meta";
  }
  return "context";
}

function extractPatchPath(diffHeader: string): string {
  const tokens = diffHeader.trim().split(/\s+/);
  const rawA = tokens[2] ?? "";
  const rawB = tokens[3] ?? "";
  const normalize = (value: string): string =>
    value.replace(/^[ab]\//, "").trim();
  const candidateB = normalize(rawB);
  if (candidateB && candidateB !== "/dev/null") {
    return candidateB;
  }
  const candidateA = normalize(rawA);
  return candidateA && candidateA !== "/dev/null" ? candidateA : "(unknown)";
}

function parsePatchPreview(patch: string): PatchPreviewData {
  const rows = patch ? patch.split("\n") : [];
  const files: PatchFileSummary[] = [];
  let currentFile: PatchFileSummary | null = null;
  let additions = 0;
  let deletions = 0;
  let hunks = 0;
  const lines: PatchPreviewLine[] = [];

  for (const row of rows) {
    if (row.startsWith("diff --git ")) {
      currentFile = {
        path: extractPatchPath(row),
        additions: 0,
        deletions: 0,
        hunks: 0
      };
      files.push(currentFile);
    } else if (!currentFile) {
      currentFile = {
        path: "(patch)",
        additions: 0,
        deletions: 0,
        hunks: 0
      };
      files.push(currentFile);
    }

    if (row.startsWith("@@")) {
      hunks += 1;
      currentFile.hunks += 1;
    } else if (row.startsWith("+") && !row.startsWith("+++")) {
      additions += 1;
      currentFile.additions += 1;
    } else if (row.startsWith("-") && !row.startsWith("---")) {
      deletions += 1;
      currentFile.deletions += 1;
    }

    if (lines.length < MAX_PATCH_PREVIEW_LINES) {
      lines.push({
        text: row || " ",
        kind: classifyPatchLine(row)
      });
    }
  }

  return {
    files,
    additions,
    deletions,
    hunks,
    lines,
    truncated: rows.length > MAX_PATCH_PREVIEW_LINES
  };
}

/* ── Think-block + Markdown renderer ─────────────────────── */
function MessageContent({
  content,
  isStreaming,
  role,
}: {
  content: string;
  isStreaming: boolean;
  role: string;
}) {
  if (!content && isStreaming && role === "assistant") {
    return (
      <div className="chat-waiting">
        <div className="chat-waiting-dots">
          <span /><span /><span />
        </div>
        <span>正在思考…</span>
      </div>
    );
  }

  const parts: { type: "text" | "think"; content: string; streaming: boolean }[] = [];
  let remaining = content;

  while (remaining.length > 0) {
    const start = remaining.indexOf("<think>");
    if (start === -1) {
      parts.push({ type: "text", content: remaining, streaming: false });
      break;
    }
    if (start > 0) {
      parts.push({ type: "text", content: remaining.slice(0, start), streaming: false });
    }
    const end = remaining.indexOf("</think>", start + 7);
    if (end === -1) {
      parts.push({ type: "think", content: remaining.slice(start + 7), streaming: true });
      break;
    }
    parts.push({ type: "think", content: remaining.slice(start + 7, end), streaming: false });
    remaining = remaining.slice(end + 8);
  }

  return (
    <>
      {parts.map((part, i) =>
        part.type === "think" ? (
          <details key={i} className="think-block" open={part.streaming}>
            <summary className="think-summary">思考过程</summary>
            <div className="think-content">
              <Markdown remarkPlugins={[remarkGfm]}>{part.content}</Markdown>
            </div>
          </details>
        ) : (
          <div key={i} className="chat-markdown">
            <Markdown remarkPlugins={[remarkGfm]}>{part.content}</Markdown>
          </div>
        )
      )}
    </>
  );
}

/* ── Tool Trace ───────────────────────────────────────────── */
function ToolTracePanel({ traces }: { traces: ToolExecutionTrace[] }) {
  const [expanded, setExpanded] = useState(false);
  if (!traces.length) return null;
  return (
    <div className="tool-trace">
      <div className="tool-trace-header" onClick={() => setExpanded(!expanded)} style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: "8px", paddingBottom: expanded ? "8px" : "0" }}>
        <span style={{ fontSize: "10px", transition: "transform 0.2s", transform: expanded ? "rotate(90deg)" : "rotate(0deg)" }}>▶</span>
        <p className="tool-trace-label" style={{ margin: 0 }}>工具调用 · {traces.length} 次</p>
      </div>
      {expanded && (
        <ul className="tool-trace-list">
          {traces.map((trace) => (
            <li
              key={`${trace.callId}-${trace.startedAt}`}
              className={`tool-trace-item ${trace.status}`}
            >
              <div className="tool-trace-head">
                <span className="tool-trace-name">{trace.name}</span>
                <span className={actionStatusBadgeClass(trace.status)}>
                  {trace.status.toUpperCase()}
                  {trace.retried ? " · retried" : ""}
                </span>
              </div>
              {(trace.errorCategory || trace.errorMessage) && (
                <p className="status-error">
                  {trace.errorCategory ? `[${trace.errorCategory}] ` : ""}
                  {trace.errorMessage ?? "工具调用失败"}
                </p>
              )}
              {trace.resultPreview && (
                <pre className="tool-trace-preview">{trace.resultPreview}</pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ── Action payload fields ────────────────────────────────── */
function ActionPayloadFields({
  action,
  messageId,
  onPlanUpdate,
}: {
  action: ActionProposal;
  messageId: string;
  onPlanUpdate: (messageId: string, updater: (p: OrchestrationPlan) => OrchestrationPlan) => void;
}) {
  const disabled = action.status === "running";

  if (action.type === "apply_patch") {
    const preview = parsePatchPreview(action.payload.patch);
    return (
      <div className="action-grid">
        <div className="action-field action-wide">
          <span>变更摘要</span>
          <div className="patch-summary-card">
            <div className="patch-summary-kpis">
              <span className="patch-kpi">files {preview.files.length}</span>
              <span className="patch-kpi patch-kpi-add">+{preview.additions}</span>
              <span className="patch-kpi patch-kpi-del">-{preview.deletions}</span>
              <span className="patch-kpi">hunks {preview.hunks}</span>
            </div>
            {preview.files.length > 0 ? (
              <ul className="patch-summary-files">
                {preview.files.slice(0, MAX_PATCH_SUMMARY_FILES).map((file) => (
                  <li key={`${file.path}-${file.hunks}`} className="patch-summary-file">
                    <code>{file.path}</code>
                    <span className="patch-summary-file-stats">
                      +{file.additions} / -{file.deletions}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="patch-summary-empty">无可预览 patch。</p>
            )}
            {preview.files.length > MAX_PATCH_SUMMARY_FILES && (
              <p className="patch-summary-more">
                其余 {preview.files.length - MAX_PATCH_SUMMARY_FILES} 个文件已省略。
              </p>
            )}
          </div>
        </div>

        <div className="action-field action-wide">
          <span>差异预览</span>
          <div className="patch-preview">
            {preview.lines.map((line, index) => (
              <div key={`${index}-${line.text.slice(0, 16)}`} className={`patch-line ${line.kind}`}>
                <code>{line.text}</code>
              </div>
            ))}
          </div>
          {preview.truncated && <p className="patch-preview-note">预览已截断，仅显示前 {MAX_PATCH_PREVIEW_LINES} 行。</p>}
        </div>

        <div className="action-field action-wide">
          <details className="patch-raw-details">
            <summary>Raw Patch（高级）</summary>
            <textarea
              className="input action-textarea"
              disabled={disabled}
              value={action.payload.patch}
              onChange={(e) =>
                onPlanUpdate(messageId, (p) =>
                  updateActionPayload(p, action.id, { patch: e.target.value })
                )
              }
            />
          </details>
        </div>
      </div>
    );
  }

  if (action.type === "shell") {
    return (
      <div className="action-grid">
        <div className="action-field action-wide">
          <span>命令</span>
          <code className="action-command-preview">{action.payload.shell || "(empty command)"}</code>
        </div>
      </div>
    );
  }

  return null;
}

/* ── Inline Plan + HITL Actions ───────────────────────────── */
function InlinePlan({
  plan,
  messageId,
  executingActionId,
  onPlanUpdate,
  onApprove,
  onReject,
  onComment,
}: {
  plan: OrchestrationPlan;
  messageId: string;
  executingActionId: string;
  onPlanUpdate: (messageId: string, updater: (p: OrchestrationPlan) => OrchestrationPlan) => void;
  onApprove: (messageId: string, actionId: string, plan: OrchestrationPlan) => Promise<void>;
  onReject: (messageId: string, actionId: string) => void;
  onComment: (messageId: string, actionId: string) => void;
}) {
  const safePlan: OrchestrationPlan = {
    ...plan,
    steps: Array.isArray(plan.steps) ? plan.steps : [],
    proposedActions: Array.isArray(plan.proposedActions) ? plan.proposedActions : [],
  };

  const [expanded, setExpanded] = useState(false);
  return (
    <div className="inline-plan">
      <div onClick={() => setExpanded(!expanded)} style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: "8px", paddingBottom: expanded ? "8px" : "0" }}>
        <span style={{ fontSize: "10px", transition: "transform 0.2s", transform: expanded ? "rotate(90deg)" : "rotate(0deg)", color: "var(--text-3)" }}>▶</span>
        <p className="inline-plan-title" style={{ margin: 0 }}>执行计划 · {safePlan.state}</p>
      </div>

      {expanded && safePlan.steps.length > 0 && (
        <ol style={{ margin: 0, paddingLeft: "1.4em", display: "flex", flexDirection: "column", gap: "4px" }}>
          {safePlan.steps.map((step) => (
            <li key={step.id} className="plan-item">
              <span style={{ color: "var(--text-2)", fontSize: "13px" }}>{step.summary}</span>
            </li>
          ))}
        </ol>
      )}

      {safePlan.proposedActions.length > 0 && (
        <ul className="action-list">
          {safePlan.proposedActions.map((action) => (
            <li key={action.id} className="action-item">
              <div className="action-header">
                <h4 className="action-title">{action.type}</h4>
                <span className={actionStatusBadgeClass(action.status)}>
                  {action.status.toUpperCase()}
                  {action.executed ? " · Executed" : ""}
                </span>
              </div>

              <ActionPayloadFields
                action={action}
                messageId={messageId}
                onPlanUpdate={onPlanUpdate}
              />

              {action.executionResult && (
                <p className={action.executionResult.success ? "status-success" : "status-error"}>
                  {action.executionResult.message}
                </p>
              )}

              <div className="action-footer">
                <button
                  className="btn btn-primary btn-sm"
                  disabled={!canApproveAction(action) || Boolean(executingActionId)}
                  onClick={() => void onApprove(messageId, action.id, plan)}
                  type="button"
                >
                  {executingActionId === action.id ? "执行中…" : "✓ 批准"}
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  disabled={!canReviewAction(action) || Boolean(executingActionId)}
                  onClick={() => onReject(messageId, action.id)}
                  type="button"
                >
                  ✕ 拒绝
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  disabled={!canReviewAction(action) || Boolean(executingActionId)}
                  onClick={() => onComment(messageId, action.id)}
                  type="button"
                >
                  💬 备注
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ── Main ChatPage ────────────────────────────────────────── */
export function ChatPage({ settings }: ChatPageProps): ReactElement {
  const initialHistory = useMemo(() => loadChatHistory(), []);
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<ChatMessageRecord[]>(initialHistory);
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [sessionNote, setSessionNote] = useState<string>(
    initialHistory.length ? "已恢复历史会话" : ""
  );
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const [executingActionId, setExecutingActionId] = useState<string>("");
  const abortControllerRef = useRef<AbortController | null>(null);
  const messagesRef = useRef<ChatMessageRecord[]>(initialHistory);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const localOnlyBlocked = !settings.allowCloudModels && !isLocalProvider(settings.provider);
  const noWorkspaceSelected = !settings.workspacePath;
  const chatBlocked = localOnlyBlocked || noWorkspaceSelected;

  const handleCancel = (): void => { abortControllerRef.current?.abort(); };

  useEffect(() => () => { abortControllerRef.current?.abort(); }, []);
  useEffect(() => {
    messagesRef.current = messages;
    saveChatHistory(messages);
  }, [messages]);
  useEffect(() => {
    if (threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [messages, isStreaming]);

  /* Auto-resize textarea */
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [prompt]);

  /* Restore checkpoint */
  useEffect(() => {
    let cancelled = false;
    const restore = async () => {
      try {
        const sessionId = getChatSessionId();
        const latest = await loadLatestWorkflowCheckpoint(sessionId);
        if (!latest || cancelled) return;
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === latest.messageId);
          if (idx >= 0) {
            return prev.map((m, i) =>
              i === idx
                ? { ...m, plan: latest.payload.plan, toolTrace: latest.payload.toolTrace ?? m.toolTrace }
                : m
            );
          }
          const recovered: ChatMessageRecord = {
            id: latest.messageId,
            role: "assistant",
            content: "已从审批点恢复上一轮工作流状态。",
            createdAt: new Date().toISOString(),
            plan: latest.payload.plan,
            toolTrace: latest.payload.toolTrace ?? [],
          };
          return [...prev, recovered].slice(-80);
        });
        setSessionNote("已从 checkpoint 恢复审批状态");
      } catch { /* non-fatal */ }
    };
    void restore();
    return () => { cancelled = true; };
  }, []);

  const buildActionSummaryText = (plan: OrchestrationPlan): string => {
    const summaryLines = plan.proposedActions.map((action) => {
      if (action.status === "rejected") {
        return `[${action.type}] 用户拒绝了执行。原因：${action.executionResult?.message || "无"}`;
      }
      if (!action.executionResult) {
        return `[${action.type}] 状态异常未执行`;
      }
      const resultLabel = action.executionResult.success ? "成功" : "失败";
      let detailText = action.executionResult.message;

      if (action.type === "apply_patch" && action.executionResult.metadata) {
        const meta = action.executionResult.metadata;
        const files = Array.isArray(meta.files)
          ? meta.files.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
          : [];
        if (files.length > 0) {
          const normalizedFiles = files.join("、");
          detailText = action.executionResult.success
            ? `已执行补丁。实际影响文件：${normalizedFiles}`
            : `补丁执行失败。涉及文件：${normalizedFiles}。错误：${action.executionResult.message}`;
        }
      }

      // For shell actions, include command details and output
      if (action.type === "shell" && action.executionResult.metadata) {
        const meta = action.executionResult.metadata;
        const cmdInfo = [`命令: ${String(meta.command || "")}`];
        if (meta.stdout && String(meta.stdout).trim()) {
          cmdInfo.push(`标准输出:\n${String(meta.stdout).trim()}`);
        }
        if (meta.stderr && String(meta.stderr).trim()) {
          cmdInfo.push(`标准错误:\n${String(meta.stderr).trim()}`);
        }
        cmdInfo.push(`退出码: ${String(meta.status ?? "unknown")}`);
        detailText = cmdInfo.join("\n");
      }

      return `[${action.type}] 执行${resultLabel}。详细信息：\n${detailText}`;
    });
    return [
      "[系统通知] 计划中的所有审批动作已处理完毕。结果汇总：",
      "",
      summaryLines.join("\n\n"),
      "",
      "请继续完成任务或向用户汇报。"
    ].join("\n");
  };

  const continueFromActionSummary = (plan: OrchestrationPlan): void => {
    const internalSystemNote = buildActionSummaryText(plan);
    console.log("[DEBUG] Sending action summary to LLM:", internalSystemNote);
    console.log("[DEBUG] Plan state:", plan.state);
    console.log("[DEBUG] Actions status:", plan.proposedActions.map(a => ({
      id: a.id,
      type: a.type,
      status: a.status,
      executed: a.executed,
      hasResult: !!a.executionResult
    })));

    // Temporarily show the feedback message in the session note for debugging
    setSessionNote(`[DEBUG] 发送给LLM的反馈: ${internalSystemNote.slice(0, 200)}...`);

    const followUpPrompt = "请总结审批结果，并给出简短下一步建议。";
    setTimeout(
      () =>
        void runChatCycle(followUpPrompt, {
          visibleUserMessage: false,
          internalSystemNote,
          phase: "post_action_summary"
        }),
      100
    );
  };

  const runChatCycle = async (
    promptText: string,
    options: RunChatCycleOptions = {}
  ): Promise<void> => {
    if (!promptText || isStreaming) return;
    const visibleUserMessage = options.visibleUserMessage !== false;
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const conversationHistory = toConversationHistory(messagesRef.current);
    const assistantMessageId = createMessageId("assistant");
    const now = new Date().toISOString();
    const assistantMsg: ChatMessageRecord = {
      id: assistantMessageId,
      role: "assistant",
      content: "",
      createdAt: now,
      plan: null,
    };

    if (visibleUserMessage) {
      const userMsg: ChatMessageRecord = {
        id: createMessageId("user"),
        role: "user",
        content: promptText,
        createdAt: now,
        plan: null,
      };
      setMessages((prev) => [...prev, userMsg, assistantMsg]);
    } else {
      setMessages((prev) => [...prev, assistantMsg]);
    }

    setIsStreaming(true);
    setErrorMessage("");
    setSessionNote("正在回复…");

    try {
      const result = await runPlanningSession({
        prompt: promptText,
        settings,
        phase: options.phase,
        conversationHistory,
        internalSystemNote: options.internalSystemNote,
        signal: controller.signal,
        onAssistantChunk: (chunk) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMessageId ? { ...m, content: `${m.content}${chunk}` } : m
            )
          );
        },
      });

      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMessageId
            ? { ...m, content: result.assistantReply, plan: result.plan, toolTrace: result.toolTrace }
            : m
        )
      );

      void saveWorkflowCheckpoint(
        getChatSessionId(), assistantMessageId, result.plan, result.toolTrace
      ).catch((err) =>
        setSessionNote(`审批点未保存：${err instanceof Error ? err.message : "未知错误"}`)
      );

      setSessionNote(
        result.plan.proposedActions.length > 0
          ? "已进入 HITL 审批阶段，请逐项审批"
          : "回复完成"
      );
    } catch (error) {
      if (controller.signal.aborted) {
        setMessages((prev) =>
          prev.filter((m) => m.id !== assistantMessageId || m.content.trim() !== "")
        );
        setSessionNote("已取消");
        return;
      }
      const msg = error instanceof Error ? error.message : String(error || "请求失败，请检查网络与 LiteLLM 配置");
      setErrorMessage(msg);
      setMessages((prev) => prev.filter((m) => m.id !== assistantMessageId));
      setSessionNote("回复失败");
    } finally {
      if (abortControllerRef.current === controller) abortControllerRef.current = null;
      setIsStreaming(false);
    }
  };

  const handleSubmit = async (): Promise<void> => {
    const text = prompt.trim();
    if (!text || isStreaming) return;
    setPrompt("");
    await runChatCycle(text);
  };

  const handlePlanUpdate = (
    messageId: string,
    updater: (plan: OrchestrationPlan) => OrchestrationPlan
  ): void => {
    let updatedPlan: OrchestrationPlan | null = null;
    let currentTrace: ToolExecutionTrace[] = [];
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== messageId || !m.plan) return m;
        updatedPlan = updater(m.plan);
        currentTrace = m.toolTrace ?? [];
        return { ...m, plan: updatedPlan };
      })
    );
    if (updatedPlan) {
      void saveWorkflowCheckpoint(
        getChatSessionId(), messageId, updatedPlan, currentTrace
      ).catch((err) =>
        setSessionNote(`审批点未保存：${err instanceof Error ? err.message : "未知错误"}`)
      );
    }
  };

  const handleApproveAction = async (
    messageId: string,
    actionId: string,
    plan: OrchestrationPlan
  ): Promise<void> => {
    if (executingActionId) return;
    setExecutingActionId(actionId);
    setErrorMessage("");
    const runningPlan = markActionRunning(plan, actionId);
    handlePlanUpdate(messageId, () => runningPlan);
    try {
      const nextPlan = await approveAction(runningPlan, actionId, settings.workspacePath);
      handlePlanUpdate(messageId, () => nextPlan);
      setSessionNote(`动作 ${actionId} 已执行 · 状态：${nextPlan.state}`);
      
      // Check if there are any remaining pending actions
      const hasPending = nextPlan.proposedActions.some(a => a.status === "pending");

      if (!hasPending) {
        continueFromActionSummary(nextPlan);
      } else {
        setSessionNote(`动作已执行，还有待审批动作`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error || "动作执行失败");
      const errorPlan = markActionExecutionError(plan, actionId, reason);
      handlePlanUpdate(messageId, () => errorPlan);
      setErrorMessage(reason);

      // Check if there are any remaining pending actions
      const hasPending = errorPlan.proposedActions.some(a => a.status === "pending");
      if (!hasPending) {
        continueFromActionSummary(errorPlan);
      }
    } finally {
      setExecutingActionId("");
    }
  };

  const handleRejectAction = (messageId: string, actionId: string): void => {
    const reason = window.prompt("请输入 Reject 原因", "Need refinement");
    if (reason === null) return;
    let newPlan: OrchestrationPlan | null = null;
    handlePlanUpdate(messageId, (p) => {
      newPlan = rejectAction(p, actionId, reason);
      return newPlan;
    });
    setSessionNote(`动作 ${actionId} 已拒绝`);

    // Defer the check so that handlePlanUpdate completes synchronously
    setTimeout(() => {
      if (newPlan) {
        const plan = newPlan as OrchestrationPlan;
        const hasPending = plan.proposedActions.some(a => a.status === "pending");
        if (!hasPending) {
          void runChatCycle("请总结审批结果，并给出简短下一步建议。", {
            visibleUserMessage: false,
            internalSystemNote: buildActionSummaryText(plan),
            phase: "post_action_summary"
          });
        }
      }
    }, 100);
  };

  const handleCommentAction = (messageId: string, actionId: string): void => {
    const comment = window.prompt("请输入 Comment", "Please update payload before approval");
    if (comment === null) return;
    handlePlanUpdate(messageId, (p) => commentAction(p, actionId, comment));
  };

  const handleClearHistory = (): void => {
    if (isStreaming || Boolean(executingActionId)) return;
    clearChatHistory();
    resetChatSessionId();
    setMessages([]);
    setErrorMessage("");
    setSessionNote("");
  };

  return (
    <div className="page-content chat-layout">
      {/* ── Top bar ── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
          <span style={{ fontSize: "12px", color: "var(--text-3)", flexShrink: 0 }}>工作区</span>
          {settings.workspacePath ? (
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {settings.workspacePath}
            </span>
          ) : (
            <span style={{ fontSize: "12px", color: "var(--color-warning)" }}>⚠ 未选择工作区</span>
          )}
        </div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center", flexShrink: 0 }}>
          {sessionNote && (
            <span style={{ fontSize: "12px", color: "var(--text-3)" }}>{sessionNote}</span>
          )}
          <button
            className="btn btn-ghost btn-sm"
            disabled={isStreaming || Boolean(executingActionId) || messages.length === 0}
            onClick={handleClearHistory}
            type="button"
          >
            清空
          </button>
        </div>
      </div>

      {/* ── Alerts ── */}
      {localOnlyBlocked && (
        <div style={{ padding: "10px 14px", background: "var(--color-error-bg)", border: "1px solid rgba(248,113,113,0.2)", borderRadius: "var(--r-md)", fontSize: "13px", color: "var(--color-error)" }}>
          Local-only 模式已开启，当前 provider 不是本地模型，请前往设置页切换。
        </div>
      )}
      {noWorkspaceSelected && (
        <div style={{ padding: "10px 14px", background: "var(--color-warning-bg)", border: "1px solid rgba(251,191,36,0.2)", borderRadius: "var(--r-md)", fontSize: "13px", color: "var(--color-warning)" }}>
          请先在设置页选择工作区（Git 仓库文件夹）
        </div>
      )}

      {/* ── Thread ── */}
      <div className="chat-thread" ref={threadRef}>
        {messages.length === 0 ? (
          <div className="chat-empty">
            <div className="chat-empty-icon">☕</div>
            <p className="chat-empty-text">开始你的第一条消息</p>
          </div>
        ) : (
          messages.map((message) => (
            <div key={message.id} className={`chat-row ${message.role}`}>
              <div className={`chat-avatar ${message.role}`}>
                {message.role === "user" ? "你" : "AI"}
              </div>
              <div className="chat-bubble-wrap">
                <p className="chat-meta">
                  {message.role === "user" ? "你" : "助手"}
                  {formatTime(message.createdAt) ? ` · ${formatTime(message.createdAt)}` : ""}
                </p>
                <div className={`chat-bubble ${message.role}`}>
                  <MessageContent
                    content={message.content}
                    isStreaming={isStreaming && message.content === "" && message.role === "assistant"}
                    role={message.role}
                  />
                </div>
                {message.role === "assistant" && (message.toolTrace?.length ?? 0) > 0 && (
                  <ToolTracePanel traces={message.toolTrace!} />
                )}
                {message.plan && (
                  <InlinePlan
                    plan={message.plan}
                    messageId={message.id}
                    executingActionId={executingActionId}
                    onPlanUpdate={handlePlanUpdate}
                    onApprove={handleApproveAction}
                    onReject={handleRejectAction}
                    onComment={handleCommentAction}
                  />
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* ── Input ── */}
      <div className="chat-input-area">
        {errorMessage && (
          <p className="status-error" style={{ margin: 0 }}>{errorMessage}</p>
        )}
        <form onSubmit={(e) => { e.preventDefault(); void handleSubmit(); }}>
          <div className="chat-input-box">
            <textarea
              ref={textareaRef}
              className="chat-textarea"
              value={prompt}
              disabled={chatBlocked}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void handleSubmit();
                }
              }}
              placeholder={chatBlocked ? "请先完成设置…" : "输入消息，Enter 发送，Shift+Enter 换行"}
              rows={1}
            />
            <div className="chat-input-footer">
              <span className="chat-input-hint">Enter 发送 · Shift+Enter 换行</span>
              <div className="chat-input-actions">
                {isStreaming && (
                  <button className="btn btn-ghost btn-sm" onClick={handleCancel} type="button">
                    停止
                  </button>
                )}
                <button
                  className="btn btn-primary btn-sm"
                  disabled={isStreaming || Boolean(executingActionId) || !prompt.trim() || chatBlocked}
                  type="submit"
                >
                  {isStreaming ? "回复中…" : "发送 ↑"}
                </button>
              </div>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
