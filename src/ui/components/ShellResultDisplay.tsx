import type { ReactElement } from "react";

interface ShellResultDisplayProps {
  command: string;
  exitCode: number;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
}

export function ShellResultDisplay({
  command,
  exitCode,
  stdout,
  stderr,
  timedOut,
}: ShellResultDisplayProps): ReactElement {
  const success = exitCode === 0 && !timedOut;

  return (
    <div className="shell-result">
      <div className="shell-result-header">
        <span className="shell-result-label">Shell 执行结果</span>
        <span className={`badge ${success ? "badge-success" : "badge-error"}`}>
          {timedOut ? "TIMEOUT" : `EXIT ${exitCode}`}
        </span>
      </div>
      <div className="shell-result-command">
        <code>{command}</code>
      </div>
      {stdout && stdout.trim() && (
        <div className="shell-result-section">
          <span className="shell-result-section-label">stdout</span>
          <pre className="shell-result-output shell-result-stdout">{stdout}</pre>
        </div>
      )}
      {stderr && stderr.trim() && (
        <div className="shell-result-section">
          <span className="shell-result-section-label">stderr</span>
          <pre className="shell-result-output shell-result-stderr">{stderr}</pre>
        </div>
      )}
    </div>
  );
}
