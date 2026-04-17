import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { classifyError, type CategorizedError } from "../../../../lib/errorClassifier";
import type { AppSettings } from "../../../../lib/settingsStore";
import {
  cancelShellCommand,
  fetchUrl,
  startShellCommand,
} from "../../../../lib/tauriBridge";
import type { ShellCommandEvent } from "../../../../lib/tauriTypes";
import {
  DEFAULT_BACKGROUND_READY_TIMEOUT_MS,
  DEFAULT_SHELL_OUTPUT_CAPTURE_MAX_BYTES,
  DEFAULT_SHELL_OUTPUT_FLUSH_INTERVAL_MS,
  extractShellReadyUrlFromText,
  resolveShellExecutionMode,
  resolveShellReadyTimeoutMs,
  resolveShellReadyUrl,
} from "../../../../lib/shellCommand";
import {
  appendRunningShellOutput,
  completeBackgroundShellAction,
  completeRunningShellAction,
  markShellActionBackground,
  markShellActionRunning,
  type ManualApprovalContext,
} from "../../../../orchestrator/hitlService";
import type { OrchestrationPlan } from "../../../../orchestrator/types";
import { measureShellChunkBytes, waitForDelay } from "../chatPageHelpers";
import type { PendingShellQueue } from "./useApprovalQueue";
import {
  markActionExecutionError,
} from "../execution";
import type { RunningShellJobMeta, ShellOutputBuffer } from "../types";

interface UseShellJobsOptions {
  settings: AppSettings;
  pendingShellQueuesRef: MutableRefObject<Map<string, PendingShellQueue>>;
  handlePlanUpdateRef: MutableRefObject<
    (
      messageId: string,
      updater: (plan: OrchestrationPlan) => OrchestrationPlan,
      options?: { persist?: boolean },
    ) => void
  >;
  continueAfterHitlIfNeededRef: MutableRefObject<
    (messageId: string, plan: OrchestrationPlan) => void
  >;
  setSessionNote: Dispatch<SetStateAction<string>>;
  setCategorizedError: Dispatch<SetStateAction<CategorizedError | null>>;
}

/**
 * Owns shell-job bookkeeping (running jobs, per-job output buffers, readiness
 * probing, completion handling, event listener) so ChatPage can stay focused
 * on orchestration. Extracted from ChatPage.tsx (B1.7.5, see
 * docs/REFACTOR_PLAN.md).
 *
 * `handlePlanUpdate` / `continueAfterHitlIfNeeded` stay in ChatPage — they
 * close over conversation-level state — so we take them as refs and read
 * fresh on each call (identical to the previous in-page stale-closure
 * workaround).
 */
export function useShellJobs(options: UseShellJobsOptions) {
  const {
    settings,
    pendingShellQueuesRef,
    handlePlanUpdateRef,
    continueAfterHitlIfNeededRef,
    setSessionNote,
    setCategorizedError,
  } = options;

  const runningShellJobsRef = useRef(new Map<string, RunningShellJobMeta>());
  const shellOutputBuffersRef = useRef(new Map<string, ShellOutputBuffer>());

  const flushShellOutputBufferRef = useRef<(jobId: string) => void>(null!);
  const startShellJobForActionRef = useRef<
    (params: {
      messageId: string;
      actionId: string;
      plan: OrchestrationPlan;
      approvalContext?: ManualApprovalContext;
    }) => Promise<void>
  >(null!);
  const completeBackgroundShellStartupRef = useRef<
    (jobId: string) => Promise<void>
  >(null!);
  const monitorBackgroundShellJobRef = useRef<(jobId: string) => Promise<void>>(
    null!,
  );

  const markShellActionsFailed = useCallback(
    (
      plan: OrchestrationPlan,
      actionIds: string[],
      reason: string,
    ): OrchestrationPlan =>
      actionIds.reduce(
        (currentPlan, actionId) =>
          markActionExecutionError(currentPlan, actionId, reason),
        plan,
      ),
    [],
  );

  const startShellJobForAction = async (params: {
    messageId: string;
    actionId: string;
    plan: OrchestrationPlan;
    approvalContext?: ManualApprovalContext;
  }): Promise<void> => {
    const action = params.plan.proposedActions.find(
      (candidate) => candidate.id === params.actionId,
    );
    if (!action || action.type !== "shell") {
      throw new Error("找不到待执行的 shell 动作。");
    }

    const executionMode = resolveShellExecutionMode(
      action.payload.shell,
      action.payload.executionMode,
    );
    const readyUrl = resolveShellReadyUrl({
      shell: action.payload.shell,
      preferredUrl: action.payload.readyUrl,
      executionMode,
    });
    const readyTimeoutMs =
      resolveShellReadyTimeoutMs(action.payload.readyTimeoutMs, executionMode) ??
      DEFAULT_BACKGROUND_READY_TIMEOUT_MS;
    const started = await startShellCommand({
      workspacePath: settings.workspacePath,
      shell: action.payload.shell,
      timeoutMs: action.payload.timeoutMs,
      detached: executionMode === "background",
      maxOutputBytes: DEFAULT_SHELL_OUTPUT_CAPTURE_MAX_BYTES,
    });
    runningShellJobsRef.current.set(started.job_id, {
      messageId: params.messageId,
      actionId: params.actionId,
      workspacePath: settings.workspacePath,
      executionMode,
      readyUrl,
      readyTimeoutMs,
      approvalContext: params.approvalContext,
    });
    if (executionMode === "background") {
      void monitorBackgroundShellJobRef.current(started.job_id);
    }
  };

  startShellJobForActionRef.current = startShellJobForAction;

  const completeBackgroundShellStartup = async (
    jobId: string,
  ): Promise<void> => {
    const runningJob = runningShellJobsRef.current.get(jobId);
    if (
      !runningJob ||
      runningJob.executionMode !== "background" ||
      runningJob.detached
    ) {
      return;
    }

    runningShellJobsRef.current.set(jobId, {
      ...runningJob,
      detached: true,
    });
    flushShellOutputBufferRef.current(jobId);

    let nextPlan: OrchestrationPlan | null = null;
    handlePlanUpdateRef.current(runningJob.messageId, (plan) => {
      nextPlan = markShellActionBackground(
        plan,
        runningJob.actionId,
        runningJob.workspacePath,
        {
          jobId,
          readyUrl: runningJob.readyUrl,
          approvalContext: runningJob.approvalContext,
        },
      );
      return nextPlan;
    });

    if (!nextPlan) {
      return;
    }

    const resolvedPlan = nextPlan as OrchestrationPlan;
    const pendingQueue = pendingShellQueuesRef.current.get(runningJob.messageId);
    if (!pendingQueue || pendingQueue.actionIds.length === 0) {
      setSessionNote(
        `后台命令 ${runningJob.actionId} 已启动 · 状态：${resolvedPlan.state}`,
      );
      continueAfterHitlIfNeededRef.current(runningJob.messageId, resolvedPlan);
      return;
    }

    const [nextActionId, ...restActionIds] = pendingQueue.actionIds;
    if (!nextActionId) {
      pendingShellQueuesRef.current.delete(runningJob.messageId);
      continueAfterHitlIfNeededRef.current(runningJob.messageId, resolvedPlan);
      return;
    }

    if (restActionIds.length > 0) {
      pendingShellQueuesRef.current.set(runningJob.messageId, {
        messageId: runningJob.messageId,
        actionIds: restActionIds,
        approvalContext: pendingQueue.approvalContext,
      });
    } else {
      pendingShellQueuesRef.current.delete(runningJob.messageId);
    }

    const queuedPlan = markShellActionRunning(resolvedPlan, nextActionId, {
      message: "命令启动中…",
    });
    handlePlanUpdateRef.current(runningJob.messageId, () => queuedPlan);

    try {
      await startShellJobForActionRef.current({
        messageId: runningJob.messageId,
        actionId: nextActionId,
        plan: queuedPlan,
        approvalContext: pendingQueue.approvalContext,
      });
      setSessionNote(
        `后台命令 ${runningJob.actionId} 已就绪，正在执行下一个命令 (${nextActionId})`,
      );
    } catch (error) {
      const reason =
        error instanceof Error
          ? error.message
          : String(error || "命令启动失败");
      let failedPlan = markActionExecutionError(queuedPlan, nextActionId, reason);
      if (restActionIds.length > 0) {
        failedPlan = markShellActionsFailed(
          failedPlan,
          restActionIds,
          `未执行：前序命令启动失败：${reason}`,
        );
      }
      pendingShellQueuesRef.current.delete(runningJob.messageId);
      handlePlanUpdateRef.current(runningJob.messageId, () => failedPlan);
      setCategorizedError(classifyError(error));
      continueAfterHitlIfNeededRef.current(runningJob.messageId, failedPlan);
    }
  };

  completeBackgroundShellStartupRef.current = completeBackgroundShellStartup;

  const monitorBackgroundShellJob = async (jobId: string): Promise<void> => {
    const initialJob = runningShellJobsRef.current.get(jobId);
    if (!initialJob || initialJob.executionMode !== "background") {
      return;
    }

    const readyDeadline =
      Date.now() + (initialJob.readyTimeoutMs ?? DEFAULT_BACKGROUND_READY_TIMEOUT_MS);
    const noProbeGraceMs = 1200;
    const startedAt = Date.now();

    while (Date.now() < readyDeadline) {
      const runningJob = runningShellJobsRef.current.get(jobId);
      if (
        !runningJob ||
        runningJob.executionMode !== "background" ||
        runningJob.detached
      ) {
        return;
      }

      const probeUrl = runningJob.readyUrl;
      if (probeUrl) {
        try {
          const response = await fetchUrl({
            url: probeUrl,
            maxSize: 512,
          });
          if (!response.error) {
            await completeBackgroundShellStartupRef.current(jobId);
            return;
          }
        } catch {
          // Ignore transient readiness probe failures while the process is still starting.
        }
      } else if (Date.now() - startedAt >= noProbeGraceMs) {
        await completeBackgroundShellStartupRef.current(jobId);
        return;
      }

      await waitForDelay(probeUrl ? 500 : 250);
    }

    const runningJob = runningShellJobsRef.current.get(jobId);
    if (
      !runningJob ||
      runningJob.executionMode !== "background" ||
      runningJob.detached
    ) {
      return;
    }

    try {
      await cancelShellCommand(jobId);
    } catch {
      // Best effort: the process may have already exited on its own.
    }

    const reason = runningJob.readyUrl
      ? `后台命令未在 ${runningJob.readyTimeoutMs ?? DEFAULT_BACKGROUND_READY_TIMEOUT_MS}ms 内就绪：${runningJob.readyUrl}`
      : `后台命令未在 ${runningJob.readyTimeoutMs ?? DEFAULT_BACKGROUND_READY_TIMEOUT_MS}ms 内进入可继续状态`;

    let nextPlan: OrchestrationPlan | null = null;
    handlePlanUpdateRef.current(runningJob.messageId, (plan) => {
      nextPlan = markActionExecutionError(plan, runningJob.actionId, reason);
      const pendingQueue = pendingShellQueuesRef.current.get(runningJob.messageId);
      if (pendingQueue && pendingQueue.actionIds.length > 0) {
        nextPlan = markShellActionsFailed(
          nextPlan,
          pendingQueue.actionIds,
          `未执行：前序后台命令未就绪：${reason}`,
        );
      }
      return nextPlan;
    });
    const buffered = shellOutputBuffersRef.current.get(jobId);
    if (buffered && buffered.timerId !== null) {
      clearTimeout(buffered.timerId);
    }
    shellOutputBuffersRef.current.delete(jobId);
    runningShellJobsRef.current.delete(jobId);
    pendingShellQueuesRef.current.delete(runningJob.messageId);
    setSessionNote(reason);
    if (nextPlan) {
      continueAfterHitlIfNeededRef.current(
        runningJob.messageId,
        nextPlan as OrchestrationPlan,
      );
    }
  };

  monitorBackgroundShellJobRef.current = monitorBackgroundShellJob;

  const flushShellOutputBuffer = (jobId: string): void => {
    const job = runningShellJobsRef.current.get(jobId);
    const buffer = shellOutputBuffersRef.current.get(jobId);
    if (!job || !buffer) {
      return;
    }

    if (buffer.timerId !== null) {
      clearTimeout(buffer.timerId);
      buffer.timerId = null;
    }

    if (!buffer.stdout && !buffer.stderr) {
      return;
    }

    const stdoutChunk = buffer.stdout;
    const stderrChunk = buffer.stderr;
    const stdoutChunkBytes = buffer.stdoutBytes;
    const stderrChunkBytes = buffer.stderrBytes;
    buffer.stdout = "";
    buffer.stderr = "";
    buffer.stdoutBytes = 0;
    buffer.stderrBytes = 0;

    handlePlanUpdateRef.current(
      job.messageId,
      (plan) => {
        let nextPlan = plan;
        if (stdoutChunk) {
          nextPlan = appendRunningShellOutput(nextPlan, job.actionId, {
            command: buffer.command,
            stream: "stdout",
            chunk: stdoutChunk,
            chunkBytes: stdoutChunkBytes,
          });
        }
        if (stderrChunk) {
          nextPlan = appendRunningShellOutput(nextPlan, job.actionId, {
            command: buffer.command,
            stream: "stderr",
            chunk: stderrChunk,
            chunkBytes: stderrChunkBytes,
          });
        }
        return nextPlan;
      },
      { persist: false },
    );
  };

  flushShellOutputBufferRef.current = flushShellOutputBuffer;

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let disposed = false;

    void listen<ShellCommandEvent>("shell-command-event", (event) => {
      if (disposed) {
        return;
      }

      const payload = event.payload;
      const runningJob = runningShellJobsRef.current.get(payload.job_id);
      if (!runningJob) {
        return;
      }

      if (
        payload.event_type === "output" &&
        payload.chunk &&
        (payload.stream === "stdout" || payload.stream === "stderr")
      ) {
        const inferredReadyUrl = extractShellReadyUrlFromText(payload.chunk);
        if (
          inferredReadyUrl &&
          runningJob.executionMode === "background" &&
          !runningJob.readyUrl
        ) {
          runningShellJobsRef.current.set(payload.job_id, {
            ...runningJob,
            readyUrl: inferredReadyUrl,
          });
        }

        const existing =
          shellOutputBuffersRef.current.get(payload.job_id) ?? {
            command: payload.command,
            stdout: "",
            stderr: "",
            stdoutBytes: 0,
            stderrBytes: 0,
            timerId: null,
          };

        existing.command = payload.command || existing.command;
        if (payload.stream === "stdout") {
          existing.stdout += payload.chunk;
          existing.stdoutBytes += measureShellChunkBytes(payload.chunk);
        } else {
          existing.stderr += payload.chunk;
          existing.stderrBytes += measureShellChunkBytes(payload.chunk);
        }
        if (existing.timerId === null) {
          existing.timerId = setTimeout(() => {
            flushShellOutputBufferRef.current(payload.job_id);
          }, DEFAULT_SHELL_OUTPUT_FLUSH_INTERVAL_MS);
        }
        shellOutputBuffersRef.current.set(payload.job_id, existing);
        return;
      }

      if (payload.event_type !== "completed") {
        return;
      }

      flushShellOutputBufferRef.current(payload.job_id);
      shellOutputBuffersRef.current.delete(payload.job_id);
      runningShellJobsRef.current.delete(payload.job_id);

      if (runningJob.executionMode === "background" && runningJob.detached) {
        handlePlanUpdateRef.current(runningJob.messageId, (plan) =>
          completeBackgroundShellAction(plan, runningJob.actionId, {
            success: Boolean(payload.success),
            command: payload.command,
            timed_out: Boolean(payload.timed_out),
            status: Number(payload.status ?? -1),
            stdout: String(payload.stdout ?? ""),
            stderr: String(payload.stderr ?? ""),
            cancelled: Boolean(payload.cancelled),
            stdout_truncated: Boolean(payload.stdout_truncated),
            stderr_truncated: Boolean(payload.stderr_truncated),
            stdout_total_bytes: Number(payload.stdout_total_bytes ?? 0),
            stderr_total_bytes: Number(payload.stderr_total_bytes ?? 0),
            output_limit_bytes: Number(
              payload.output_limit_bytes ?? DEFAULT_SHELL_OUTPUT_CAPTURE_MAX_BYTES,
            ),
          }),
        );
        setSessionNote(
          payload.cancelled
            ? `后台命令 ${runningJob.actionId} 已取消`
            : `后台命令 ${runningJob.actionId} 已结束`,
        );
        return;
      }

      let nextPlan: OrchestrationPlan | null = null;
      handlePlanUpdateRef.current(runningJob.messageId, (plan) => {
        nextPlan = completeRunningShellAction(
          plan,
          runningJob.actionId,
          runningJob.workspacePath,
          {
            success: Boolean(payload.success),
            command: payload.command,
            timed_out: Boolean(payload.timed_out),
            status: Number(payload.status ?? -1),
            stdout: String(payload.stdout ?? ""),
            stderr: String(payload.stderr ?? ""),
            cancelled: Boolean(payload.cancelled),
            stdout_truncated: Boolean(payload.stdout_truncated),
            stderr_truncated: Boolean(payload.stderr_truncated),
            stdout_total_bytes: Number(payload.stdout_total_bytes ?? 0),
            stderr_total_bytes: Number(payload.stderr_total_bytes ?? 0),
            output_limit_bytes: Number(
              payload.output_limit_bytes ?? DEFAULT_SHELL_OUTPUT_CAPTURE_MAX_BYTES,
            ),
          },
          runningJob.approvalContext,
        );
        return nextPlan;
      });

      if (!nextPlan) {
        return;
      }

      const resolvedPlan = nextPlan as OrchestrationPlan;
      const pendingQueue = pendingShellQueuesRef.current.get(runningJob.messageId);
      const currentSucceeded =
        Boolean(payload.success) && !Boolean(payload.cancelled);

      if (pendingQueue && pendingQueue.actionIds.length > 0) {
        void (async () => {
          if (!currentSucceeded) {
            pendingShellQueuesRef.current.delete(runningJob.messageId);
            const queueStopReason = payload.cancelled
              ? "未执行：前序命令已取消"
              : "未执行：前序命令失败";
            const failedQueuedPlan = markShellActionsFailed(
              resolvedPlan,
              pendingQueue.actionIds,
              queueStopReason,
            );
            handlePlanUpdateRef.current(
              runningJob.messageId,
              () => failedQueuedPlan,
            );
            setSessionNote(
              `动作 ${runningJob.actionId} 已停止，剩余 ${pendingQueue.actionIds.length} 个命令未继续执行`,
            );
            continueAfterHitlIfNeededRef.current(
              runningJob.messageId,
              failedQueuedPlan,
            );
          } else {
            const [nextActionId, ...restActionIds] = pendingQueue.actionIds;
            if (!nextActionId) {
              pendingShellQueuesRef.current.delete(runningJob.messageId);
              setSessionNote(
                `动作 ${runningJob.actionId} 已执行 · 状态：${resolvedPlan.state}`,
              );
              continueAfterHitlIfNeededRef.current(
                runningJob.messageId,
                resolvedPlan,
              );
              return;
            }

            if (restActionIds.length > 0) {
              pendingShellQueuesRef.current.set(runningJob.messageId, {
                messageId: runningJob.messageId,
                actionIds: restActionIds,
                approvalContext: pendingQueue.approvalContext,
              });
            } else {
              pendingShellQueuesRef.current.delete(runningJob.messageId);
            }

            const queuedPlan = markShellActionRunning(
              resolvedPlan,
              nextActionId,
              { message: "命令启动中…" },
            );
            handlePlanUpdateRef.current(
              runningJob.messageId,
              () => queuedPlan,
            );
            try {
              await startShellJobForActionRef.current({
                messageId: runningJob.messageId,
                actionId: nextActionId,
                plan: queuedPlan,
                approvalContext: pendingQueue.approvalContext,
              });
              setSessionNote(
                `动作 ${runningJob.actionId} 已完成，正在执行下一个命令 (${nextActionId})`,
              );
            } catch (error) {
              const reason =
                error instanceof Error
                  ? error.message
                  : String(error || "命令启动失败");
              let failedPlan = markActionExecutionError(
                queuedPlan,
                nextActionId,
                reason,
              );
              if (restActionIds.length > 0) {
                failedPlan = markShellActionsFailed(
                  failedPlan,
                  restActionIds,
                  `未执行：前序命令启动失败：${reason}`,
                );
              }
              pendingShellQueuesRef.current.delete(runningJob.messageId);
              handlePlanUpdateRef.current(
                runningJob.messageId,
                () => failedPlan,
              );
              setCategorizedError(classifyError(error));
              continueAfterHitlIfNeededRef.current(
                runningJob.messageId,
                failedPlan,
              );
            }
          }
        })();
        return;
      }

      setSessionNote(
        `动作 ${runningJob.actionId} 已执行 · 状态：${resolvedPlan.state}`,
      );
      continueAfterHitlIfNeededRef.current(runningJob.messageId, resolvedPlan);
    }).then((dispose) => {
      unlisten = dispose;
    });

    return () => {
      disposed = true;
      for (const buffer of shellOutputBuffersRef.current.values()) {
        if (buffer.timerId !== null) {
          clearTimeout(buffer.timerId);
        }
      }
      shellOutputBuffersRef.current.clear();
      runningShellJobsRef.current.clear();
      pendingShellQueuesRef.current.clear();
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const getActiveShellActionIdsForThread = useCallback(
    (messageId: string): string[] =>
      Array.from(runningShellJobsRef.current.values())
        .filter((meta) => meta.messageId === messageId)
        .map((meta) => meta.actionId),
    [],
  );

  return {
    runningShellJobsRef,
    shellOutputBuffersRef,
    startShellJobForAction,
    startShellJobForActionRef,
    markShellActionsFailed,
    getActiveShellActionIdsForThread,
  };
}
