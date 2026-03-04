/**
 * Cofree - AI Programming Cafe
 * File: src/orchestrator/readOnlyWorkspaceService.ts
 * Milestone: 3
 * Task: 3.5
 * Status: In Progress
 * Owner: Codex-GPT-5
 * Last Modified: 2026-02-27
 * Description: Read-only workspace inspection helpers for file listing queries.
 */

import { invoke } from "@tauri-apps/api/core";

interface FileEntry {
  name: string;
  is_dir: boolean;
  size: number;
  modified: number;
}

interface ScannedFile {
  path: string;
  size: number;
}

const FILE_QUERY_HINTS = [
  "文件",
  "目录",
  "项目结构",
  "文件夹",
  "多少文件",
  "有哪些文件",
  "列出文件",
  "list files",
  "project files",
  "folder structure",
  "directory",
];

export interface WorkspaceOverviewBudget {
  maxDirectories?: number;
  maxFiles?: number;
  maxRootPreview?: number;
  maxChars?: number;
}

// Default safety limits for overview injection (can be overridden via .cofreerc overviewBudget).
const MAX_DIRECTORIES = 200;
const MAX_FILES = 3000;
const MAX_PURPOSE_FILES = 12;
const MAX_READ_BYTES = 200_000;
const MAX_ROOT_PREVIEW = 12;

function clampBudget(
  budget: WorkspaceOverviewBudget | undefined
): Required<
  Pick<
    WorkspaceOverviewBudget,
    "maxDirectories" | "maxFiles" | "maxRootPreview"
  >
> &
  Pick<WorkspaceOverviewBudget, "maxChars"> {
  // Hard caps to avoid pathological configs.
  const hardMaxDirectories = 2000;
  const hardMaxFiles = 20000;
  const hardMaxRootPreview = 200;
  const hardMaxChars = 200000;

  const clampIntOr = (
    value: unknown,
    fallback: number,
    max: number
  ): number => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return fallback;
    }
    const n = Math.floor(value);
    if (n <= 0) return fallback;
    return Math.min(n, max);
  };

  const maxDirectories = clampIntOr(
    budget?.maxDirectories,
    MAX_DIRECTORIES,
    hardMaxDirectories
  );
  const maxFiles = clampIntOr(budget?.maxFiles, MAX_FILES, hardMaxFiles);
  const maxRootPreview = clampIntOr(
    budget?.maxRootPreview,
    MAX_ROOT_PREVIEW,
    hardMaxRootPreview
  );

  const maxCharsRaw = budget?.maxChars;
  const maxChars =
    typeof maxCharsRaw === "number" && Number.isFinite(maxCharsRaw)
      ? Math.min(Math.max(200, Math.floor(maxCharsRaw)), hardMaxChars)
      : undefined;

  return {
    maxDirectories,
    maxFiles,
    maxRootPreview,
    ...(typeof maxChars === "number" ? { maxChars } : {}),
  };
}

function truncateOverview(content: string, maxChars?: number): string {
  if (typeof maxChars !== "number" || maxChars <= 0) {
    return content;
  }
  if (content.length <= maxChars) {
    return content;
  }
  const marker = "\n... (truncated)";
  const sliceLen = Math.max(0, maxChars - marker.length);
  return content.slice(0, sliceLen) + marker;
}

function includesAny(text: string, words: string[]): boolean {
  return words.some((word) => text.includes(word));
}

function joinRelative(parent: string, child: string): string {
  return parent ? `${parent}/${child}` : child;
}

function isHiddenName(name: string): boolean {
  return name.startsWith(".");
}

function extensionOf(path: string): string {
  const fileName = path.split("/").pop() ?? path;
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === fileName.length - 1) {
    return "(no_ext)";
  }
  return fileName.slice(dotIndex + 1).toLowerCase();
}

function formatTopExtensions(files: ScannedFile[]): string {
  const extCounter = new Map<string, number>();
  for (const file of files) {
    const ext = extensionOf(file.path);
    extCounter.set(ext, (extCounter.get(ext) ?? 0) + 1);
  }

  const top = Array.from(extCounter.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, 8);

  if (!top.length) {
    return "无文件扩展名统计。";
  }

  return top.map(([ext, count]) => `${ext}: ${count}`).join(" | ");
}

function summarizeRootEntries(
  entries: FileEntry[],
  maxRootPreview: number
): string {
  const sorted = [...entries].sort((left, right) => {
    if (left.is_dir !== right.is_dir) {
      return left.is_dir ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });

  const preview = sorted.slice(0, maxRootPreview).map((entry) => {
    if (entry.is_dir) {
      return `- [DIR] ${entry.name}/`;
    }
    return `- [FILE] ${entry.name}`;
  });

  if (sorted.length > maxRootPreview) {
    preview.push(`- ... 其余 ${sorted.length - maxRootPreview} 项省略`);
  }

  return preview.join("\n");
}

export function shouldRunWorkspaceFileQuery(prompt: string): boolean {
  return includesAny(prompt.toLowerCase(), FILE_QUERY_HINTS);
}

export function shouldExplainFilePurposes(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return includesAny(normalized, [
    "做什么",
    "用途",
    "作用",
    "功能",
    "what do",
    "purpose",
    "what is this file",
  ]);
}

function inferDirectoryPurpose(name: string): string {
  const normalized = name.toLowerCase();
  if (normalized === "src") return "源代码目录";
  if (normalized === "docs") return "文档目录";
  if (normalized === "test" || normalized === "tests") return "测试目录";
  if (normalized === "dist" || normalized === "build") return "构建产物目录";
  if (normalized === "public" || normalized === "assets") return "静态资源目录";
  return "目录（包含相关文件）";
}

function extensionHint(path: string): string {
  const ext = extensionOf(path);
  switch (ext) {
    case "py":
      return "Python 脚本";
    case "html":
      return "HTML 页面";
    case "js":
    case "ts":
    case "jsx":
    case "tsx":
      return "前端/脚本代码";
    case "json":
    case "yaml":
    case "yml":
    case "toml":
      return "配置或结构化数据";
    case "md":
      return "文档";
    case "css":
      return "样式文件";
    default:
      return "文件";
  }
}

function inferFilePurpose(path: string, content: string): string {
  const extBased = extensionHint(path);
  const lower = content.toLowerCase();

  if (path.endsWith(".py")) {
    if (lower.includes("def merge_sort")) {
      return "归并排序实现脚本";
    }
    if (
      lower.includes('if __name__ == "__main__"') ||
      lower.includes("if __name__ == '__main__'")
    ) {
      return "可直接运行的 Python 脚本";
    }
    if (lower.includes("def ")) {
      return "包含函数定义的 Python 模块";
    }
  }

  if (path.endsWith(".html")) {
    if (lower.includes("merge sort")) {
      return "归并排序演示页面";
    }
    return "网页或交互演示页面";
  }

  if (lower.includes("todo") && lower.includes("fixme")) {
    return `${extBased}（含待办标记）`;
  }

  return extBased;
}

export async function summarizeWorkspaceFiles(
  workspacePath: string,
  ignorePatterns: string[] | null = null,
  budget?: WorkspaceOverviewBudget
): Promise<string> {
  const effectiveBudget = clampBudget(budget);
  const rootEntries = await invoke<FileEntry[]>("list_workspace_files", {
    workspacePath,
    relativePath: "",
    ignorePatterns:
      ignorePatterns && ignorePatterns.length > 0 ? ignorePatterns : null,
  });

  const queue: string[] = rootEntries
    .filter((entry) => entry.is_dir && !isHiddenName(entry.name))
    .map((entry) => entry.name);
  const scannedFiles: ScannedFile[] = rootEntries
    .filter((entry) => !entry.is_dir && !isHiddenName(entry.name))
    .map((entry) => ({ path: entry.name, size: entry.size }));

  let scannedDirectories = 1; // root
  let truncated = false;

  while (queue.length) {
    if (
      scannedDirectories >= effectiveBudget.maxDirectories ||
      scannedFiles.length >= effectiveBudget.maxFiles
    ) {
      truncated = true;
      break;
    }

    const relativeDir = queue.shift() as string;
    scannedDirectories += 1;
    const entries = await invoke<FileEntry[]>("list_workspace_files", {
      workspacePath,
      relativePath: relativeDir,
      ignorePatterns:
        ignorePatterns && ignorePatterns.length > 0 ? ignorePatterns : null,
    });

    for (const entry of entries) {
      if (isHiddenName(entry.name)) {
        continue;
      }
      const relativePath = joinRelative(relativeDir, entry.name);
      if (entry.is_dir) {
        queue.push(relativePath);
      } else {
        scannedFiles.push({
          path: relativePath,
          size: entry.size,
        });
      }
      if (scannedFiles.length >= effectiveBudget.maxFiles) {
        truncated = true;
        break;
      }
    }
  }

  const visibleRootEntries = rootEntries.filter(
    (entry) => !isHiddenName(entry.name)
  );
  const rootDirCount = visibleRootEntries.filter(
    (entry) => entry.is_dir
  ).length;
  const rootFileCount = visibleRootEntries.length - rootDirCount;
  const totalBytes = scannedFiles.reduce((sum, file) => sum + file.size, 0);
  const totalMB = (totalBytes / (1024 * 1024)).toFixed(2);

  const overview = [
    "基于工作区实时扫描结果：",
    `- 根目录可见条目：${visibleRootEntries.length}（目录 ${rootDirCount} / 文件 ${rootFileCount}）`,
    `- 全项目估算：目录约 ${scannedDirectories}，文件约 ${scannedFiles.length}，体积约 ${totalMB} MB`,
    truncated
      ? "- 扫描达到安全上限，统计为部分结果。"
      : "- 扫描完成（未触发安全上限）。",
    `- 常见扩展名：${formatTopExtensions(scannedFiles)}`,
    "- 根目录预览：",
    summarizeRootEntries(visibleRootEntries, effectiveBudget.maxRootPreview),
  ].join("\n");

  return truncateOverview(overview, effectiveBudget.maxChars);
}

export async function summarizeWorkspaceFilePurposes(
  workspacePath: string,
  ignorePatterns: string[] | null = null
): Promise<string> {
  const rootEntries = await invoke<FileEntry[]>("list_workspace_files", {
    workspacePath,
    relativePath: "",
    ignorePatterns:
      ignorePatterns && ignorePatterns.length > 0 ? ignorePatterns : null,
  });
  const visibleEntries = rootEntries.filter(
    (entry) => !isHiddenName(entry.name)
  );
  const rootFiles = visibleEntries
    .filter((entry) => !entry.is_dir)
    .slice(0, MAX_PURPOSE_FILES);
  const rootDirs = visibleEntries
    .filter((entry) => entry.is_dir)
    .slice(0, MAX_PURPOSE_FILES);

  const lines: string[] = [];
  lines.push("基于工作区实时读取结果：");
  lines.push(`- 当前可见根目录条目：${visibleEntries.length}`);

  if (!visibleEntries.length) {
    lines.push("- 根目录为空或仅包含隐藏文件。");
    return lines.join("\n");
  }

  if (rootFiles.length) {
    lines.push("- 文件用途：");
    for (const file of rootFiles) {
      let content = "";
      if (file.size <= MAX_READ_BYTES) {
        try {
          content = (
            await invoke<{
              content: string;
              total_lines: number;
              start_line: number;
              end_line: number;
            }>("read_workspace_file", {
              workspacePath,
              relativePath: file.name,
              ignorePatterns:
                ignorePatterns && ignorePatterns.length > 0
                  ? ignorePatterns
                  : null,
            })
          ).content;
        } catch (_error) {
          content = "";
        }
      }

      const purpose = inferFilePurpose(file.name, content);
      lines.push(`  - ${file.name}: ${purpose}`);
    }
  }

  if (rootDirs.length) {
    lines.push("- 目录用途：");
    for (const directory of rootDirs) {
      lines.push(
        `  - ${directory.name}/: ${inferDirectoryPurpose(directory.name)}`
      );
    }
  }

  if (visibleEntries.length > MAX_PURPOSE_FILES * 2) {
    lines.push(
      `- 其余 ${
        visibleEntries.length - MAX_PURPOSE_FILES * 2
      } 个条目未展开，可继续指定目录深入查看。`
    );
  }

  return lines.join("\n");
}
