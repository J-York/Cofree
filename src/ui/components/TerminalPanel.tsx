import { type KeyboardEvent, type ReactElement, useEffect, useRef, useState } from "react";
import { runShellCommand } from "../../lib/tauriBridge";
import type { CommandExecutionResult } from "../../lib/tauriTypes";
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
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const draftCommandRef = useRef("");
  const workspaceVersionRef = useRef(0);

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
    draftCommandRef.current = "";
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
    setHistory((current) => [...current, shell]);
    setCommand("");
    resetHistoryNavigation();

    const startedAt = performance.now();
    const timestamp = new Date().toISOString();
    const workspaceVersion = workspaceVersionRef.current;

    try {
      const result = await runShellCommand({
        workspacePath,
        shell,
        timeoutMs: 120000,
      });
      if (workspaceVersion !== workspaceVersionRef.current) return;
      const durationMs = performance.now() - startedAt;
      setEntries((current) => [
        ...current,
        {
          id: createTerminalEntryId(),
          command: shell,
          success: result.success,
          timedOut: result.timed_out,
          status: result.status,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs,
          timestamp,
        },
      ]);
    } catch (error) {
      const failure = createFailureResult(shell, error);
      if (workspaceVersion !== workspaceVersionRef.current) return;
      const durationMs = performance.now() - startedAt;
      setEntries((current) => [
        ...current,
        {
          id: createTerminalEntryId(),
          command: shell,
          success: false,
          timedOut: false,
          status: failure.status,
          stdout: "",
          stderr: failure.stderr,
          durationMs,
          timestamp,
        },
      ]);
    } finally {
      if (workspaceVersion !== workspaceVersionRef.current) return;
      setIsRunning(false);
      setActiveCommand("");
      inputRef.current?.focus();
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
