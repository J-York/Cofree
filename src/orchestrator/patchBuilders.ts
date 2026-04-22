/**
 * Unified-diff patch construction helpers.
 *
 * Two layers:
 *   - Pure text surgery (split/replace/insert by line) — no I/O, fully
 *     covered by `patchBuilders.test.ts`.
 *   - `buildReplacementPatch` — delegates to the Rust `build_workspace_edit_patch`
 *     command so diff output stays byte-identical with `apply_workspace_patch`
 *     expectations. Not unit-tested here; exercised via integration paths.
 */

import { invoke } from "@tauri-apps/api/core";

export function splitPatchLines(content: string): {
  lines: string[];
  hasTrailingNewline: boolean;
} {
  if (!content.length) {
    return {
      lines: [],
      hasTrailingNewline: false,
    };
  }

  const hasTrailingNewline = content.endsWith("\n");
  const body = hasTrailingNewline ? content.slice(0, -1) : content;

  return {
    lines: body.length > 0 ? body.split("\n") : [""],
    hasTrailingNewline,
  };
}

export function splitContentSegments(content: string): string[] {
  if (!content.length) {
    return [];
  }

  const segments: string[] = [];
  let start = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\n") {
      segments.push(content.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (start < content.length) {
    segments.push(content.slice(start));
  }
  return segments;
}

export function replaceByLineRange(
  content: string,
  startLine: number,
  endLine: number,
  replacement: string
): string {
  const segments = splitContentSegments(content);
  if (!segments.length) {
    throw new Error("文件为空，无法按行定位编辑。");
  }
  if (startLine < 1 || endLine < 1 || startLine > endLine) {
    throw new Error("非法行号范围。");
  }
  if (startLine > segments.length || endLine > segments.length) {
    throw new Error(`行号超出文件范围（总行数 ${segments.length}）。`);
  }

  return (
    segments.slice(0, startLine - 1).join("") +
    replacement +
    segments.slice(endLine).join("")
  );
}

export function insertByLine(
  content: string,
  line: number,
  insertContent: string,
  position: "before" | "after"
): string {
  const segments = splitContentSegments(content);
  if (!segments.length) {
    throw new Error("文件为空，无法按行定位插入。");
  }
  if (line < 1 || line > segments.length) {
    throw new Error(`line 超出文件范围（总行数 ${segments.length}）。`);
  }

  const insertionIndex = position === "before" ? line - 1 : line;
  return (
    segments.slice(0, insertionIndex).join("") +
    insertContent +
    segments.slice(insertionIndex).join("")
  );
}

export function formatUnifiedRange(start: number, count: number): string {
  if (count === 1) {
    return `${start}`;
  }
  return `${start},${count}`;
}

export async function buildReplacementPatch(
  relativePath: string,
  before: string,
  after: string
): Promise<string> {
  if (before === after) {
    throw new Error("编辑结果为空，未产生文件变更。");
  }
  return invoke<string>("build_workspace_edit_patch", {
    relativePath,
    before,
    after,
  });
}

export function buildCreateFilePatch(relativePath: string, content: string): string {
  const next = splitPatchLines(content);
  if (next.lines.length < 1) {
    throw new Error("create 操作要求 content 至少包含一行。");
  }

  const hunkLines = next.lines.map((line) => `+${line}`);
  if (!next.hasTrailingNewline) {
    hunkLines.push("\\ No newline at end of file");
  }

  return (
    [
      `diff --git a/${relativePath} b/${relativePath}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${relativePath}`,
      `@@ -0,0 +${formatUnifiedRange(1, next.lines.length)} @@`,
      ...hunkLines,
    ].join("\n") + "\n"
  );
}
