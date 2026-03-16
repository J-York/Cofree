import type { ReactElement } from "react";

interface ShellResultDisplayProps {
  command: string;
  exitCode: number;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  stdoutTotalBytes?: number;
  stderrTotalBytes?: number;
  statusLabel?: string;
}

function formatByteCount(value?: number): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function ShellResultDisplay({
  command,
  exitCode,
  stdout,
  stderr,
  timedOut,
  stdoutTruncated,
  stderrTruncated,
  stdoutTotalBytes,
  stderrTotalBytes,
  statusLabel,
}: ShellResultDisplayProps): ReactElement {
  const success = exitCode === 0 && !timedOut;
  const hasStdout = Boolean(stdout && stdout.trim());
  const hasStderr = Boolean(stderr && stderr.trim());
  const hasOutput = hasStdout || hasStderr;
  const isTruncated = Boolean(stdoutTruncated || stderrTruncated);
  const defaultExpanded =
    !isTruncated && (stdout?.length ?? 0) + (stderr?.length ?? 0) <= 1600;
  const badgeClass = statusLabel
    ? "badge-default"
    : success
      ? "badge-success"
      : "badge-error";
  const badgeText = statusLabel ?? (timedOut ? "TIMEOUT" : `EXIT ${exitCode}`);

  return (
    <div className="shell-result">
      <div className="shell-result-header">
        <span className="shell-result-label">Shell 执行结果</span>
        <span className={`badge ${badgeClass}`}>{badgeText}</span>
      </div>
      <div className="shell-result-command">
        <code>{command}</code>
      </div>
      {hasOutput && (
        <details open={defaultExpanded}>
          <summary className="shell-result-section-label">
            输出预览{isTruncated ? "（已截断）" : ""}
          </summary>
          {hasStdout && (
            <div className="shell-result-section">
              <span className="shell-result-section-label">
                stdout
                {formatByteCount(stdoutTotalBytes)
                  ? ` · ${formatByteCount(stdoutTotalBytes)}`
                  : ""}
                {stdoutTruncated ? " · 仅显示尾部预览" : ""}
              </span>
              <pre className="shell-result-output shell-result-stdout">{stdout}</pre>
            </div>
          )}
          {hasStderr && (
            <div className="shell-result-section">
              <span className="shell-result-section-label">
                stderr
                {formatByteCount(stderrTotalBytes)
                  ? ` · ${formatByteCount(stderrTotalBytes)}`
                  : ""}
                {stderrTruncated ? " · 仅显示尾部预览" : ""}
              </span>
              <pre className="shell-result-output shell-result-stderr">{stderr}</pre>
            </div>
          )}
        </details>
      )}
    </div>
  );
}
