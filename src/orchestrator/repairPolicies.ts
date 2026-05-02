import type { ToolCallRecord } from "./llmToolLoop";
import type { ToolExecutionResult } from "./toolExecutor";

export const MAX_PATCH_REPAIR_ROUNDS = 1;
export const MAX_CREATE_HINT_REPAIR_ROUNDS = 1;
export const MAX_SHELL_DIALECT_REPAIR_ROUNDS = 1;
export const MAX_SEARCH_NOT_FOUND_REPAIR_ROUNDS = 2;
export const MAX_PSEUDO_TOOL_CALL_REPAIR_ROUNDS = 5;
export const MAX_TOOL_NOT_FOUND_STRIKES = 3;
export const MAX_CONSECUTIVE_FAILURE_TURNS = 5;
export const MAX_SAME_FILE_EDIT_FAILURES = 4;

const PATCH_REPAIR_INSTRUCTION =
  "请读取文件片段后，用 propose_file_edit 重新编辑单个文件。";
const CREATE_PATH_REPAIR_INSTRUCTION =
  "新建文件用 propose_file_edit + operation='create'；目录不存在则先用 propose_shell 创建。";
const SEARCH_NOT_FOUND_REPAIR_INSTRUCTION =
  "search 未匹配。改用 start_line/end_line 行范围编辑（推荐），或缩短 search 到 1-3 行唯一片段。不要包含行号前缀。";

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function shouldRetryPseudoToolCall(rounds: number): boolean {
  return rounds < MAX_PSEUDO_TOOL_CALL_REPAIR_ROUNDS;
}

export function shouldStopForToolNotFound(toolNotFoundStrikes: number): boolean {
  return toolNotFoundStrikes >= MAX_TOOL_NOT_FOUND_STRIKES;
}

export function shouldWarnForToolNotFound(toolNotFoundStrikes: number): boolean {
  return toolNotFoundStrikes > 0 && toolNotFoundStrikes < MAX_TOOL_NOT_FOUND_STRIKES;
}

export function shouldStopForConsecutiveFailures(consecutiveFailureTurns: number): boolean {
  return consecutiveFailureTurns >= MAX_CONSECUTIVE_FAILURE_TURNS;
}

export function buildPseudoToolCallRepairMessage(enabledToolNames: string[]): string {
  return [
    "系统提示：你在文本中描述了工具调用但未发送原生 tool_calls，系统无法执行。",
    `可用工具: [${enabledToolNames.join(", ")}]`,
    "请直接发送原生工具调用，或给出最终答案。",
  ].join("\n");
}

export function buildPseudoToolCallCompatibilityDiagnostic(protocolLabel: string): string {
  return `当前模型在 ${protocolLabel} 协议下连续输出伪工具调用。已停止自动继续。建议换用工具调用更稳定的模型。`;
}

export function buildToolNotFoundWarningMessage(
  toolNotFoundStrikes: number,
  enabledToolNames: string[],
): string {
  return [
    `系统提示：你调用了不存在的工具（连续 ${toolNotFoundStrikes} 轮）。`,
    `你只能使用以下工具: [${enabledToolNames.join(", ")}]`,
    "请严格从上述列表中选择工具，不要臆造工具名称。",
  ].join("\n");
}

export function buildSameFileEditFailureMessage(filePath: string, failCount: number): string {
  return `系统提示：对 "${filePath}" 编辑已连续失败 ${failCount} 次。改用 start_line/end_line 行范围编辑，或 operation='create' + overwrite=true 重写文件。`;
}

export function buildPatchPreflightRepairMessage(patchPreflightFailure: string): string {
  return [
    "系统提示：上一轮 patch 预检失败。",
    `错误信息：${patchPreflightFailure}`,
    PATCH_REPAIR_INSTRUCTION,
    "仅允许一次自动修复重试，并保持最小改动。",
  ].join("\n");
}

export function buildCreatePathRepairMessage(createPathUsageFailure: string): string {
  return [
    "系统提示：检测到文件创建路径问题。",
    `错误信息：${createPathUsageFailure}`,
    CREATE_PATH_REPAIR_INSTRUCTION,
  ].join("\n");
}

export function buildSearchNotFoundRepairMessage(searchNotFoundFailure: string): string {
  return [
    "系统提示：文件编辑失败 — search/anchor 片段在文件中未匹配。",
    `错误信息：${searchNotFoundFailure}`,
    SEARCH_NOT_FOUND_REPAIR_INSTRUCTION,
  ].join("\n");
}

export function buildShellDialectRepairInstruction(
  toolCall: ToolCallRecord,
  toolResult: ToolExecutionResult,
): string | null {
  if (toolCall.function.name !== "propose_shell" || toolResult.success !== false) {
    return null;
  }

  const args = parseJsonObject(toolCall.function.arguments);
  const shell = typeof args?.shell === "string" ? args.shell.trim() : "";
  if (!shell) {
    return null;
  }

  const payload = parseJsonObject(toolResult.content);
  if (payload?.auto_executed !== true) {
    return null;
  }

  const stderr = typeof payload.stderr === "string" ? payload.stderr : "";
  const stdout = typeof payload.stdout === "string" ? payload.stdout : "";
  const rawError = [toolResult.errorMessage, stderr, stdout]
    .filter((value): value is string => Boolean(value))
    .join("\n");
  const normalizedError = rawError.toLowerCase();
  const normalizedShell = shell.toLowerCase();
  const usesDialectSpecificSyntax =
    normalizedShell.includes("&&") || normalizedShell.includes("mkdir -p");
  const looksLikePowerShellFailure = [
    "parsererror",
    "at line:",
    "categoryinfo",
    "fullyqualifiederrorid",
    "not a valid statement separator",
    "parameterbindingexception",
    "positional parameter cannot be found that accepts argument '-p'",
  ].some((marker) => normalizedError.includes(marker));

  if (!usesDialectSpecificSyntax || !looksLikePowerShellFailure) {
    return null;
  }

  return [
    "系统提示：shell 方言不匹配。当前执行器是 PowerShell。",
    `失败命令：${shell}`,
    `错误：${rawError.trim().slice(0, 600) || "命令执行失败"}`,
    "请改写为 PowerShell 语法（; 串联，New-Item 创建目录，Remove-Item 删除）后重试。",
  ].join("\n");
}
