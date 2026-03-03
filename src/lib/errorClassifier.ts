/**
 * Cofree - AI Programming Cafe
 * File: src/lib/errorClassifier.ts
 * Milestone: 4
 * Task: 4.3
 * Description: Error classifier that maps raw errors to CategorizedError with category, title, message, retriable flag, and guidance.
 */

export type ErrorCategory =
  | "llm_failure"
  | "network_timeout"
  | "patch_conflict"
  | "workspace_error"
  | "auth_error"
  | "abort"
  | "unknown";

export interface CategorizedError {
  category: ErrorCategory;
  title: string;
  message: string;
  retriable: boolean;
  guidance: string;
  rawError?: string;
}

export function classifyError(error: unknown): CategorizedError {
  if (error instanceof DOMException && error.name === "AbortError") {
    return {
      category: "abort",
      title: "已取消",
      message: "请求已被用户取消。",
      retriable: false,
      guidance: "",
    };
  }

  const rawMessage = error instanceof Error ? error.message : String(error || "未知错误");
  const lower = rawMessage.toLowerCase();

  // Auth errors
  if (
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("invalid api key") ||
    lower.includes("authentication") ||
    lower.includes("认证失败")
  ) {
    return {
      category: "auth_error",
      title: "认证失败",
      message: "API Key 无效或已过期。",
      retriable: false,
      guidance: "请前往设置页检查 API Key 是否正确配置。",
      rawError: rawMessage,
    };
  }

  // Network/timeout errors
  if (
    lower.includes("timeout") ||
    lower.includes("超时") ||
    lower.includes("timed out") ||
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("network") ||
    lower.includes("fetch") ||
    lower.includes("请求失败") ||
    lower.includes("connect_timeout") ||
    lower.includes("connection refused")
  ) {
    return {
      category: "network_timeout",
      title: "网络超时",
      message: "无法连接到 LLM 服务。",
      retriable: true,
      guidance: "请检查网络连接和 LiteLLM Base URL 是否正确。",
      rawError: rawMessage,
    };
  }

  // Patch conflict errors
  if (
    lower.includes("patch does not apply") ||
    lower.includes("patch 预检失败") ||
    lower.includes("corrupt patch") ||
    lower.includes("hunk failed") ||
    lower.includes("conflict")
  ) {
    return {
      category: "patch_conflict",
      title: "补丁冲突",
      message: "代码补丁无法应用于当前文件状态。",
      retriable: true,
      guidance: "文件可能已被修改，请重试或手动检查冲突。",
      rawError: rawMessage,
    };
  }

  // Workspace errors
  if (
    lower.includes("未选择工作区") ||
    lower.includes("workspace") ||
    lower.includes("工作区") ||
    lower.includes("path does not exist") ||
    lower.includes("not a directory")
  ) {
    return {
      category: "workspace_error",
      title: "工作区错误",
      message: "工作区路径无效或未选择。",
      retriable: false,
      guidance: "请前往设置页选择有效的 Git 仓库文件夹。",
      rawError: rawMessage,
    };
  }

  // LLM failure (rate limit, server error, etc.)
  if (
    lower.includes("429") ||
    lower.includes("500") ||
    lower.includes("502") ||
    lower.includes("503") ||
    lower.includes("rate limit") ||
    lower.includes("服务员响应失败") ||
    lower.includes("模型响应") ||
    lower.includes("completion") ||
    lower.includes("local-only")
  ) {
    return {
      category: "llm_failure",
      title: "模型服务异常",
      message: "LLM 服务返回错误。",
      retriable: true,
      guidance: "请稍后重试，或检查模型配置是否正确。",
      rawError: rawMessage,
    };
  }

  return {
    category: "unknown",
    title: "发生错误",
    message: rawMessage,
    retriable: true,
    guidance: "请检查配置后重试。",
    rawError: rawMessage,
  };
}
