import type { ToolCallRecord } from "./llmToolLoop";
import type { ToolExecutionResult } from "./toolExecutor";

export const MAX_PATCH_REPAIR_ROUNDS = 1;
export const MAX_CREATE_HINT_REPAIR_ROUNDS = 1;
export const MAX_SHELL_DIALECT_REPAIR_ROUNDS = 1;
export const MAX_SEARCH_NOT_FOUND_REPAIR_ROUNDS = 2;
export const MAX_PSEUDO_TOOL_CALL_REPAIR_ROUNDS = 5;
export const MAX_TOOL_NOT_FOUND_STRIKES = 3;
export const MAX_CONSECUTIVE_FAILURE_TURNS = 5;
export const MAX_CONSECUTIVE_READ_ONLY_TURNS = 8;
export const MAX_SAME_FILE_EDIT_FAILURES = 4;

const PATCH_REPAIR_INSTRUCTION =
  "请读取必要文件片段后，仅针对一个文件重新调用 propose_file_edit；不要再次提交多文件 raw patch。";
const CREATE_PATH_REPAIR_INSTRUCTION =
  "若目标是新建文件，请调用 propose_file_edit 并设置 operation='create'；若目录不存在，可先调用 propose_shell 创建目录。Windows/PowerShell 下使用 New-Item -ItemType Directory -Force <目录>；Unix 下可用 mkdir -p <目录>。";
const SEARCH_NOT_FOUND_REPAIR_INSTRUCTION =
  "search/anchor 片段在完整文件中未匹配到（search 必须精确匹配文件内容）。这通常是因为文件较大、read_file 返回的内容被截断，你基于截断视图构造的 search 片段与实际文件内容不一致。" +
  "\n请改用以下策略之一：" +
  "\n1. 使用 start_line/end_line 行号范围方式编辑（推荐）：先用 read_file 的 start_line/end_line 参数读取目标区域的精确内容，再用 propose_file_edit 的 start_line/end_line 参数做行范围替换。" +
  "\n2. 缩短 search 片段：只使用你确定在文件中唯一存在的短片段（1-3 行），避免包含可能被截断的长段落。" +
  "\n3. 先用 read_file 分段读取目标区域获取精确内容，再构造精确匹配的 search 片段。" +
  "\n注意：search 中不要包含行号前缀（如 '  10│'），这些仅用于显示。";

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

export function shouldForceReadOnlySummary(consecutiveReadOnlyTurns: number): boolean {
  return consecutiveReadOnlyTurns >= MAX_CONSECUTIVE_READ_ONLY_TURNS;
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
    "系统提示：你刚才在普通文本里描述、转储了工具调用，或直接输出了工具参数/工具结果，但并没有发送原生 tool_calls，所以系统无法执行。",
    `本轮可用工具: [${enabledToolNames.join(", ")}]`,
    "如果需要继续使用工具，请直接发送原生工具调用，不要输出任何类似“我将调用 read_file / let's call ... / tool call now”的描述文本，也不要把 JSON 参数对象或工具错误结果直接打到聊天内容里。",
    "如果任务其实已经完成且不需要工具，请直接给出最终答案。",
  ].join("\n");
}

export function buildPseudoToolCallCompatibilityDiagnostic(protocolLabel: string): string {
  return [
    `当前模型在 ${protocolLabel} 协议下连续把工具调用写成了普通文本或 JSON，而不是原生 tool_calls。`,
    "Cofree 无法把这些文本当成真实工具调用执行，所以本轮已停止自动继续，避免把伪造的工具参数/结果直接当最终工作产物。",
    "建议改用当前协议下工具调用更稳定的模型，或先收窄任务范围后重试。",
  ].join("\n");
}

export function buildReadOnlyTurnsWarningMessage(consecutiveReadOnlyTurns: number): string {
  return [
    `系统警告：你已连续 ${consecutiveReadOnlyTurns} 轮只在读取文件而没有给出任何回复或提出动作。`,
    "请立即基于已收集的信息给出回答。如果信息不足以完成任务，请说明已了解的内容和还需要什么信息，而不是继续读取更多文件。",
  ].join("\n");
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
  return [
    `系统提示：对文件 "${filePath}" 的编辑已连续失败 ${failCount} 次，继续重试不太可能成功。`,
    "请放弃 search/replace 方式，改用以下方案之一：",
    "1. 使用 read_file 的 start_line/end_line 精确读取目标区域，然后用 propose_file_edit 的 start_line/end_line 做行范围替换。",
    "2. 如果编辑内容较多，考虑用 operation='create' + overwrite=true 重写整个文件。",
    "3. 将大编辑拆分为多个小编辑，每次只修改一小段。",
  ].join("\n");
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
    "系统提示：上一轮自动执行的 propose_shell 失败，错误看起来像 shell 方言不匹配。",
    `失败命令：${shell}`,
    `错误信息：${rawError.trim().slice(0, 1200) || "命令执行失败"}`,
    "当前 Windows 执行器实际使用 PowerShell（powershell -NoProfile -Command）。不要重复使用 bash/cmd 风格写法如 mkdir -p 或 &&。",
    "请保持任务目标不变，依据 stderr 改写为 PowerShell 语法后重新调用 propose_shell：创建目录用 New-Item -ItemType Directory -Force <目录>，命令串联用 ;，删除目录用 Remove-Item -Recurse -Force <路径>。",
    "仅允许一次自动修复重试。",
  ].join("\n");
}
