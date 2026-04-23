/**
 * Tool-error categorization, retry-decision policy, and LLM-facing recovery
 * hints.
 *
 * Keeping these rules as pure functions (no I/O, no globals) lets the tool
 * loop and the retry wrapper share one source of truth, and makes the
 * categorization matrix directly unit-testable.
 */

import type { ToolErrorCategory } from "./toolTraceTypes";

export function classifyToolError(message: string): ToolErrorCategory {
  const lower = message.toLowerCase();
  if (
    lower.includes("不能为空") ||
    lower.includes("invalid json") ||
    lower.includes("arguments") ||
    lower.includes("未找到") ||
    lower.includes("出现多次") ||
    lower.includes("预检失败") ||
    lower.includes("已存在") ||
    lower.includes("未产生文件变更") ||
    lower.includes("不支持的 file edit") ||
    lower.includes("行号") ||
    lower.includes("文件为空") ||
    lower.includes("invalid target path") ||
    lower.includes("no such file or directory") ||
    lower.includes("line 超出")
  ) {
    return "validation";
  }
  if (lower.includes("未选择工作区") || lower.includes("workspace")) {
    return "workspace";
  }
  if (
    lower.includes("allowlist") ||
    lower.includes("guardrail") ||
    lower.includes("shell 控制符") ||
    lower.includes("工作区越界路径") ||
    lower.includes("受限目录") ||
    lower.includes("命中被禁止的可执行程序") ||
    lower.includes("命中高风险关键字") ||
    lower.includes("解释器内联执行") ||
    lower.includes("直接改文件")
  ) {
    return "guardrail";
  }
  if (
    lower.includes("patch does not apply") ||
    lower.includes("corrupt patch")
  ) {
    return "validation";
  }
  if (lower.includes("timed out") || lower.includes("超时")) {
    return "timeout";
  }
  if (lower.includes("permission") || lower.includes("not permitted")) {
    return "permission";
  }
  if (lower.includes("未知工具")) {
    return "tool_not_found";
  }
  if (
    lower.includes("fetch") ||
    lower.includes("network") ||
    lower.includes("http")
  ) {
    return "transport";
  }
  return "unknown";
}

export function shouldRetryToolCall(category: ToolErrorCategory): boolean {
  switch (category) {
    case "transport":
    case "timeout":
      return true;
    case "workspace":
      // Workspace errors (e.g. file temporarily locked) may resolve on retry
      return true;
    case "validation":
    case "permission":
    case "allowlist":
    case "guardrail":
    case "tool_not_found":
      // These are deterministic failures — retrying won't help
      return false;
    case "unknown":
      // Unknown errors get one retry in case they're transient
      return true;
    default:
      return false;
  }
}

/**
 * Compute exponential backoff delay for tool call retries.
 * Uses a shorter base than LLM retries since tool calls are local operations.
 */
export function computeToolRetryDelay(attempt: number): number {
  const baseDelayMs = 500;
  const maxDelayMs = 5000;
  const delay = baseDelayMs * Math.pow(2, attempt - 1);
  const jitter = delay * 0.2 * Math.random();
  return Math.min(delay + jitter, maxDelayMs);
}

/**
 * Build a contextual error recovery hint for the LLM based on the tool error category.
 * This helps the model understand what went wrong and how to fix it.
 */
export function buildToolErrorRecoveryHint(
  toolName: string,
  category: ToolErrorCategory,
  errorMessage: string,
): string {
  const hints: string[] = [
    `工具 "${toolName}" 执行失败。`,
    `错误类别: ${category}`,
    `错误信息: ${errorMessage}`,
  ];

  switch (category) {
    case "validation":
      hints.push(
        "恢复建议: 参数格式或值不正确。请检查工具参数是否符合要求，特别注意：",
        "- relative_path 必须是工作区相对路径，不能是绝对路径",
        "- search 字段必须与文件中的实际内容完全匹配（包括空格和缩进）",
        "- 必填参数不能省略",
      );
      break;
    case "workspace":
      hints.push(
        "恢复建议: 工作区操作失败。可能的原因：",
        "- 文件或目录不存在 — 先用 list_files 或 glob 确认路径",
        "- 文件被锁定或权限不足 — 尝试其他文件或等待后重试",
        "- 路径拼写错误 — 使用 glob 搜索正确的文件名",
      );
      break;
    case "timeout":
      hints.push(
        "恢复建议: 操作超时。对于耗时操作：",
        "- 缩小操作范围（如减少 grep 的 max_results）",
        "- 对于 shell 命令，增加 timeout_ms 参数",
        "- 将大操作拆分为多个小操作",
      );
      break;
    case "transport":
      hints.push(
        "恢复建议: 网络或传输错误，通常是暂时性的。系统会自动重试。",
      );
      break;
    case "tool_not_found":
      hints.push(
        "恢复建议: 调用了不存在的工具。请检查工具名称拼写，可用工具列表见系统提示。",
      );
      break;
    case "permission":
    case "allowlist":
    case "guardrail":
      hints.push(
        "恢复建议: 权限或安全策略阻止了此操作。请：",
        "- 使用其他方式完成任务",
        "- 如果是 shell 命令被阻止，尝试使用更安全的替代命令",
      );
      break;
    default:
      hints.push(
        "恢复建议: 发生未知错误。请尝试：",
        "- 检查参数是否正确",
        "- 使用 read_file 确认目标文件的当前状态",
        "- 尝试不同的方法完成任务",
      );
  }

  return hints.join("\n");
}
