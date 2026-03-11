import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { type KeyboardEvent, type ReactElement, useEffect, useRef, useState } from "react";
import { cancelShellCommand, startShellCommand } from "../../lib/tauriBridge";
import type { CommandExecutionResult, ShellCommandEvent } from "../../lib/tauriTypes";
import { IconSpinner, IconTerminal } from "./Icons";

interface TerminalPanelProps {
  isOpen: boolean;
  workspacePath: string;
  onClose: () => void;
}

interface TerminalEntry {
  id: string;
  command: string;
  success: boolean;
  timedOut: boolean;
  status: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timestamp: string;
}

let terminalEntrySequence = 0;

function getWorkspaceLabel(workspacePath: string): string {
  const parts = workspacePath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || workspacePath;
}

function createTerminalEntryId(): string {
  terminalEntrySequence += 1;
  return `terminal-entry-${Date.now()}-${terminalEntrySequence}`;
}

function formatDuration(durationMs: number): string {
  if (durationMs >= 1000) {
    return `${(durationMs / 1000).toFixed(1)}s`;
  }
  return `${Math.max(1, Math.round(durationMs))}ms`;
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function createFailureResult(command: string, error: unknown): CommandExecutionResult {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    success: false,
    command,
    timed_out: false,
    status: -1,
    stdout: "",
    stderr: detail,
  };
}

export function TerminalPanel({
  isOpen,
  workspacePath,
  onClose,
}: TerminalPanelProps): ReactElement {
  const [command, setCommand] = useState("");
  const [entries, setEntries] = useState<TerminalEntry[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [activeCommand, setActiveCommand] = useState("");
  const [activeStdout, setActiveStdout] = useState("");
  const [activeStderr, setActiveStderr] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const draftCommandRef = useRef("");
  const workspaceVersionRef = useRef(0);
  const activeJobIdRef = useRef<string | null>(null);
  const activeCommandRef = useRef("");
  const activeStdoutRef = useRef("");
  const activeStderrRef = useRef("");
  const activeStartedAtRef = useRef(0);
  const activeTimestampRef = useRef("");
  const activeWorkspaceVersionRef = useRef(0);

  const workspaceLabel = workspacePath ? getWorkspaceLabel(workspacePath) : "workspace";

  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
    }
  }, [isOpen]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollTop = viewport.scrollHeight;
  }, [entries, isRunning]);

  useEffect(() => {
    workspaceVersionRef.current += 1;
    setCommand("");
    setEntries([]);
    setHistory([]);
    setHistoryIndex(null);
    setIsRunning(false);
    setActiveCommand("");
    setActiveStdout("");
    setActiveStderr("");
    draftCommandRef.current = "";
    activeJobIdRef.current = null;
    activeCommandRef.current = "";
    activeStdoutRef.current = "";
    activeStderrRef.current = "";
    activeStartedAtRef.current = 0;
    activeTimestampRef.current = "";
    activeWorkspaceVersionRef.current = workspaceVersionRef.current;
  }, [workspacePath]);

  const resetHistoryNavigation = (): void => {
    setHistoryIndex(null);
    draftCommandRef.current = "";
  };

  const clearTerminal = (): void => {
    setEntries([]);
    resetHistoryNavigation();
    setCommand("");
    inputRef.current?.focus();
  };

  const resetActiveCommandState = (): void => {
    activeJobIdRef.current = null;
    activeCommandRef.current = "";
    activeStdoutRef.current = "";
    activeStderrRef.current = "";
    activeStartedAtRef.current = 0;
    activeTimestampRef.current = "";
    setIsRunning(false);
    setActiveCommand("");
    setActiveStdout("");
    setActiveStderr("");
    inputRef.current?.focus();
  };

  const appendTerminalEntry = (
    commandText: string,
    result: CommandExecutionResult,
    durationMs: number,
    timestamp: string,
  ): void => {
    setEntries((current) => [
      ...current,
      {
        id: createTerminalEntryId(),
        command: commandText,
        success: result.success,
        timedOut: result.timed_out,
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs,
        timestamp,
      },
    ]);
  };

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let disposed = false;

    void listen<ShellCommandEvent>("shell-command-event", (event) => {
      if (disposed || event.payload.job_id !== activeJobIdRef.current) {
        return;
      }

      const payload = event.payload;
      if (
        payload.event_type === "output" &&
        payload.chunk &&
        (payload.stream === "stdout" || payload.stream === "stderr")
      ) {
        if (payload.stream === "stdout") {
          activeStdoutRef.current += payload.chunk;
          setActiveStdout(activeStdoutRef.current);
        } else {
          activeStderrRef.current += payload.chunk;
          setActiveStderr(activeStderrRef.current);
        }
        return;
      }

      if (payload.event_type !== "completed") {
        return;
      }

      const workspaceVersion = activeWorkspaceVersionRef.current;
      const result: CommandExecutionResult = {
        success: Boolean(payload.success),
        command: payload.command,
        timed_out: Boolean(payload.timed_out),
        status: Number(payload.status ?? -1),
        stdout: String(payload.stdout ?? activeStdoutRef.current),
        stderr: String(payload.stderr ?? activeStderrRef.current),
      };
      if (workspaceVersion === workspaceVersionRef.current) {
        appendTerminalEntry(
          activeCommandRef.current || payload.command,
          result,
          performance.now() - activeStartedAtRef.current,
          activeTimestampRef.current || new Date().toISOString(),
        );
      }
      resetActiveCommandState();
    }).then((dispose) => {
      unlisten = dispose;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const handleSubmit = async (): Promise<void> => {
    const shell = command.trim();
    if (!shell || isRunning) return;

    if (shell === "clear" || shell === "cls") {
      clearTerminal();
      return;
    }

    if (!workspacePath) return;

    setIsRunning(true);
    setActiveCommand(shell);
    setActiveStdout("");
    setActiveStderr("");
    setHistory((current) => [...current, shell]);
    setCommand("");
    resetHistoryNavigation();

    const startedAt = performance.now();
    const timestamp = new Date().toISOString();
    const workspaceVersion = workspaceVersionRef.current;
    activeCommandRef.current = shell;
    activeStdoutRef.current = "";
    activeStderrRef.current = "";
    activeStartedAtRef.current = startedAt;
    activeTimestampRef.current = timestamp;
    activeWorkspaceVersionRef.current = workspaceVersion;

    try {
      const startPromise = startShellCommand({
        workspacePath,
        shell,
        timeoutMs: 120000,
      });
      // Set the job ID from the promise synchronously via .then() so that
      // shell-command-event listeners can match completion events that arrive
      // before the outer await resumes (e.g. for fast commands like `pwd`).
      startPromise.then((started) => {
        activeJobIdRef.current = started.job_id;
      });
      const started = await startPromise;
      activeJobIdRef.current = started.job_id;
    } catch (error) {
      const failure = createFailureResult(shell, error);
      if (workspaceVersion !== workspaceVersionRef.current) return;
      appendTerminalEntry(
        shell,
        failure,
        performance.now() - startedAt,
        timestamp,
      );
      resetActiveCommandState();
    }
  };

  const handleCancel = async (): Promise<void> => {
    const activeJobId = activeJobIdRef.current;
    if (!activeJobId) {
      return;
    }

    try {
      await cancelShellCommand(activeJobId);
    } catch (error) {
      const failure = createFailureResult(activeCommandRef.current, error);
      appendTerminalEntry(
        activeCommandRef.current,
        failure,
        performance.now() - activeStartedAtRef.current,
        activeTimestampRef.current || new Date().toISOString(),
      );
      resetActiveCommandState();
    }
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowUp") {
      if (history.length === 0) return;
      event.preventDefault();
      setHistoryIndex((current) => {
        if (current === null) {
          draftCommandRef.current = command;
          const nextIndex = history.length - 1;
          setCommand(history[nextIndex]);
          return nextIndex;
        }

        const nextIndex = Math.max(0, current - 1);
        setCommand(history[nextIndex]);
        return nextIndex;
      });
      return;
    }

    if (event.key === "ArrowDown") {
      if (history.length === 0 || historyIndex === null) return;
      event.preventDefault();
      setHistoryIndex((current) => {
        if (current === null) return null;
        if (current >= history.length - 1) {
          setCommand(draftCommandRef.current);
          return null;
        }

        const nextIndex = current + 1;
        setCommand(history[nextIndex]);
        return nextIndex;
      });
    }
  };

  return (
    <div className={`terminal-dock${isOpen ? " open" : ""}`} aria-hidden={!isOpen}>
      <div className="terminal-shell">
        <div className="terminal-shell-header">
          <div className="terminal-shell-title-row">
            <div className="terminal-shell-title">
              <IconTerminal size={14} />
              <span>终端</span>
            </div>
            <span className="badge badge-default">
              执行目录: {workspacePath ? workspaceLabel : "未选择工作区"}
            </span>
          </div>
          <div className="terminal-shell-actions">
            <button
              className="btn btn-ghost btn-sm"
              onClick={clearTerminal}
              type="button"
            >
              清空
            </button>
            <button
              className="terminal-shell-close"
              onClick={onClose}
              type="button"
              aria-label="关闭终端"
            >
              &times;
            </button>
          </div>
        </div>

        <div className="terminal-viewport" ref={viewportRef}>
          {entries.length === 0 && !isRunning && (
            <div className="terminal-empty">
              <div className="terminal-empty-title">Cofree Terminal</div>
              <p className="status-note">
                {workspacePath
                  ? `在 ${workspacePath} 下执行命令。支持上下键历史和 clear 清屏。`
                  : "先选择工作区，再从该目录执行命令。"}
              </p>
            </div>
          )}

          {entries.map((entry) => {
            const statusClass = entry.success
              ? "badge-success"
              : entry.timedOut
                ? "badge-warning"
                : "badge-error";
            const statusLabel = entry.timedOut ? "TIMEOUT" : `EXIT ${entry.status}`;

            return (
              <section className="terminal-entry" key={entry.id}>
                <div className="terminal-entry-head">
                  <span className="terminal-entry-prompt">{workspaceLabel} $</span>
                  <code className="terminal-entry-command">{entry.command}</code>
                </div>
                <div className="terminal-entry-meta">
                  <span className={`badge ${statusClass}`}>{statusLabel}</span>
                  <span className="badge badge-default">{formatDuration(entry.durationMs)}</span>
                  <span className="terminal-entry-time">{formatTimestamp(entry.timestamp)}</span>
                </div>
                {entry.stdout && (
                  <pre className="terminal-entry-output">{entry.stdout}</pre>
                )}
                {entry.stderr && (
                  <pre className="terminal-entry-output terminal-entry-output-error">{entry.stderr}</pre>
                )}
              </section>
            );
          })}

          {isRunning && activeCommand && (
            <section className="terminal-entry terminal-entry-running">
              <div className="terminal-entry-head">
                <span className="terminal-entry-prompt">{workspaceLabel} $</span>
                <code className="terminal-entry-command">{activeCommand}</code>
              </div>
              <div className="terminal-entry-meta">
                <span className="badge badge-accent">
                  <IconSpinner size={12} />
                  运行中
                </span>
              </div>
              {activeStdout && (
                <pre className="terminal-entry-output">{activeStdout}</pre>
              )}
              {activeStderr && (
                <pre className="terminal-entry-output terminal-entry-output-error">{activeStderr}</pre>
              )}
            </section>
          )}
        </div>

        <form
          className="terminal-composer"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSubmit();
          }}
        >
          <label className="terminal-composer-field">
            <span className="terminal-composer-prompt">{workspaceLabel} $</span>
            <input
              ref={inputRef}
              className="input terminal-input"
              value={command}
              onChange={(event) => {
                if (historyIndex !== null) {
                  setHistoryIndex(null);
                }
                draftCommandRef.current = event.target.value;
                setCommand(event.target.value);
              }}
              onKeyDown={handleComposerKeyDown}
              placeholder={workspacePath ? "输入 shell 命令后回车" : "请先选择工作区"}
              disabled={!workspacePath || isRunning}
              spellCheck={false}
            />
          </label>
          <div className="terminal-composer-actions">
            <span className="terminal-composer-hint">↑↓ 历史 · clear 清屏</span>
            {isRunning && (
              <button
                className="btn btn-ghost btn-sm"
                type="button"
                onClick={() => void handleCancel()}
              >
                取消
              </button>
            )}
            <button
              className="btn btn-primary btn-sm"
              type="submit"
              disabled={!workspacePath || isRunning || !command.trim()}
            >
              {isRunning ? "执行中…" : "运行"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
