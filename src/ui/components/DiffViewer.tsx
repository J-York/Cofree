import { type ReactElement, useMemo, useState } from "react";

/* ── Types ─────────────────────────────────────────────── */
type DiffLineKind = "file" | "meta" | "hunk" | "add" | "remove" | "context";

interface DiffLine {
  text: string;
  kind: DiffLineKind;
  oldLineNo?: number;
  newLineNo?: number;
}

interface DiffFile {
  path: string;
  additions: number;
  deletions: number;
  hunks: number;
  lines: DiffLine[];
}

interface DiffData {
  files: DiffFile[];
  additions: number;
  deletions: number;
  hunks: number;
  truncated: boolean;
}

type DiffViewMode = "inline" | "split";

const MAX_DIFF_LINES = 300;

/* ── Parsing ──────────────────────────────────────────── */
function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith("diff --git ")) return "file";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+") && !line.startsWith("+++")) return "add";
  if (line.startsWith("-") && !line.startsWith("---")) return "remove";
  if (
    line.startsWith("index ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ") ||
    line.startsWith("new file mode ") ||
    line.startsWith("deleted file mode ")
  ) {
    return "meta";
  }
  return "context";
}

function extractPath(diffHeader: string): string {
  const tokens = diffHeader.trim().split(/\s+/);
  const rawB = tokens[3] ?? "";
  const rawA = tokens[2] ?? "";
  const normalize = (v: string) => v.replace(/^[ab]\//, "").trim();
  const candidateB = normalize(rawB);
  if (candidateB && candidateB !== "/dev/null") return candidateB;
  const candidateA = normalize(rawA);
  return candidateA && candidateA !== "/dev/null" ? candidateA : "(unknown)";
}

function parseHunkHeader(line: string): { oldStart: number; newStart: number } {
  const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if (!match) return { oldStart: 1, newStart: 1 };
  return { oldStart: parseInt(match[1], 10), newStart: parseInt(match[2], 10) };
}

function parsePatchForDiff(patch: string): DiffData {
  const rows = patch ? patch.split("\n") : [];
  const files: DiffFile[] = [];
  let currentFile: DiffFile | null = null;
  let totalAdditions = 0;
  let totalDeletions = 0;
  let totalHunks = 0;
  let totalLines = 0;

  let oldLine = 0;
  let newLine = 0;

  for (const row of rows) {
    if (totalLines >= MAX_DIFF_LINES && !row.startsWith("diff --git ")) continue;

    const kind = classifyDiffLine(row);

    if (kind === "file") {
      currentFile = {
        path: extractPath(row),
        additions: 0,
        deletions: 0,
        hunks: 0,
        lines: [],
      };
      files.push(currentFile);
    } else if (!currentFile) {
      currentFile = {
        path: "(patch)",
        additions: 0,
        deletions: 0,
        hunks: 0,
        lines: [],
      };
      files.push(currentFile);
    }

    if (kind === "hunk") {
      const { oldStart, newStart } = parseHunkHeader(row);
      oldLine = oldStart;
      newLine = newStart;
      totalHunks += 1;
      currentFile.hunks += 1;
    }

    const diffLine: DiffLine = { text: row || " ", kind };

    if (kind === "add") {
      totalAdditions += 1;
      currentFile.additions += 1;
      diffLine.newLineNo = newLine++;
    } else if (kind === "remove") {
      totalDeletions += 1;
      currentFile.deletions += 1;
      diffLine.oldLineNo = oldLine++;
    } else if (kind === "context") {
      diffLine.oldLineNo = oldLine++;
      diffLine.newLineNo = newLine++;
    }

    if (totalLines < MAX_DIFF_LINES) {
      currentFile.lines.push(diffLine);
      totalLines += 1;
    }
  }

  return {
    files,
    additions: totalAdditions,
    deletions: totalDeletions,
    hunks: totalHunks,
    truncated: rows.length > MAX_DIFF_LINES,
  };
}

/* ── Components ───────────────────────────────────────── */

function DiffFileHeader({
  file,
  collapsed,
  onToggle,
}: {
  file: DiffFile;
  collapsed: boolean;
  onToggle: () => void;
}): ReactElement {
  return (
    <div className="diff-file-header" onClick={onToggle}>
      <span
        className="diff-file-toggle"
        style={{ transform: collapsed ? "rotate(0deg)" : "rotate(90deg)" }}
      >
        ▶
      </span>
      <code className="diff-file-path">{file.path}</code>
      <span className="diff-file-stats">
        <span className="diff-stat-add">+{file.additions}</span>
        <span className="diff-stat-del">-{file.deletions}</span>
      </span>
    </div>
  );
}

function InlineView({ lines }: { lines: DiffLine[] }): ReactElement {
  return (
    <div className="diff-inline-view">
      {lines.map((line, i) => (
        <div key={`${i}-${line.text.slice(0, 12)}`} className={`patch-line ${line.kind}`}>
          <span className="diff-line-no diff-line-no-old">
            {line.oldLineNo ?? ""}
          </span>
          <span className="diff-line-no diff-line-no-new">
            {line.newLineNo ?? ""}
          </span>
          <code>{line.text}</code>
        </div>
      ))}
    </div>
  );
}

function SplitView({ lines }: { lines: DiffLine[] }): ReactElement {
  const leftLines: DiffLine[] = [];
  const rightLines: DiffLine[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.kind === "context" || line.kind === "hunk" || line.kind === "file" || line.kind === "meta") {
      leftLines.push(line);
      rightLines.push(line);
      i++;
    } else if (line.kind === "remove") {
      // Collect consecutive removes
      const removes: DiffLine[] = [];
      while (i < lines.length && lines[i].kind === "remove") {
        removes.push(lines[i]);
        i++;
      }
      // Collect consecutive adds
      const adds: DiffLine[] = [];
      while (i < lines.length && lines[i].kind === "add") {
        adds.push(lines[i]);
        i++;
      }
      // Pair them up
      const maxLen = Math.max(removes.length, adds.length);
      for (let j = 0; j < maxLen; j++) {
        leftLines.push(removes[j] ?? { text: "", kind: "context" as const });
        rightLines.push(adds[j] ?? { text: "", kind: "context" as const });
      }
    } else if (line.kind === "add") {
      leftLines.push({ text: "", kind: "context" as const });
      rightLines.push(line);
      i++;
    } else {
      leftLines.push(line);
      rightLines.push(line);
      i++;
    }
  }

  return (
    <div className="diff-split-container">
      <div className="diff-split-pane">
        {leftLines.map((line, idx) => (
          <div key={`l-${idx}`} className={`patch-line ${line.kind}`}>
            <span className="diff-line-no">{line.oldLineNo ?? ""}</span>
            <code>{line.text}</code>
          </div>
        ))}
      </div>
      <div className="diff-split-pane">
        {rightLines.map((line, idx) => (
          <div key={`r-${idx}`} className={`patch-line ${line.kind}`}>
            <span className="diff-line-no">{line.newLineNo ?? ""}</span>
            <code>{line.text}</code>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Main DiffViewer ──────────────────────────────────── */
interface DiffViewerProps {
  patch: string;
}

export function DiffViewer({ patch }: DiffViewerProps): ReactElement {
  const [viewMode, setViewMode] = useState<DiffViewMode>("inline");
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());

  const diffData = useMemo(() => parsePatchForDiff(patch), [patch]);

  const toggleFile = (path: string) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  return (
    <div className="diff-viewer">
      <div className="diff-toolbar">
        <div className="patch-summary-kpis">
          <span className="patch-kpi">files {diffData.files.length}</span>
          <span className="patch-kpi patch-kpi-add">+{diffData.additions}</span>
          <span className="patch-kpi patch-kpi-del">-{diffData.deletions}</span>
          <span className="patch-kpi">hunks {diffData.hunks}</span>
        </div>
        <div className="diff-mode-toggle">
          <button
            className={`btn btn-sm ${viewMode === "inline" ? "btn-primary" : "btn-ghost"}`}
            onClick={() => setViewMode("inline")}
            type="button"
          >
            Inline
          </button>
          <button
            className={`btn btn-sm ${viewMode === "split" ? "btn-primary" : "btn-ghost"}`}
            onClick={() => setViewMode("split")}
            type="button"
          >
            Split
          </button>
        </div>
      </div>

      {diffData.files.map((file) => {
        const key = `${file.path}-${file.hunks}`;
        const isCollapsed = collapsedFiles.has(key);
        // Filter out file/meta lines for content display
        const contentLines = file.lines.filter(
          (l) => l.kind !== "file" && l.kind !== "meta"
        );

        return (
          <div key={key} className="diff-file-block">
            <DiffFileHeader
              file={file}
              collapsed={isCollapsed}
              onToggle={() => toggleFile(key)}
            />
            {!isCollapsed && (
              <div className="diff-file-content">
                {viewMode === "inline" ? (
                  <InlineView lines={contentLines} />
                ) : (
                  <SplitView lines={contentLines} />
                )}
              </div>
            )}
          </div>
        );
      })}

      {diffData.truncated && (
        <p className="patch-preview-note">
          预览已截断，仅显示前 {MAX_DIFF_LINES} 行。
        </p>
      )}
    </div>
  );
}
