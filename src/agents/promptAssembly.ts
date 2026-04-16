/**
 * Cofree - AI Programming Cafe
 * File: src/agents/promptAssembly.ts
 * Description: Assembles the final system prompt for a ChatAgent request.
 */

import type { ResolvedAgentRuntime } from "./types";
import type { ResolvedSkill } from "../lib/skillStore";
import { buildSkillPromptFragment } from "../lib/skillStore";

// ---------------------------------------------------------------------------
// Rule Categories
// ---------------------------------------------------------------------------

const RULE_CORE = [
  "通过工具获取事实，基于上下文推理。遵守以下原则：",
  "1) **先思考再行动**：修改前分析问题，理解架构和依赖。复杂任务先拆解步骤。",
  "2) **高质量代码**：包含类型定义、错误处理、一致风格，考虑边界条件。",
  "3) **基于事实迭代**：工具返回的报错/成功就是事实，出错后查阅 stderr 并用 read_file 校验后修正。",
  "4) **原子修改**：每次写入只改一个文件。跨文件任务拆成多个顺序的 propose_file_edit。",
  "5) **Todo 一致性**：有 todo 时一次只推进一个步骤，状态变更必须调用 update_plan。",
].join("\n");

const RULE_EDITING = [
  "修改文件/执行命令时：",
  "1) 不要输出代码，只通过工具提出动作。优选 `propose_file_edit`（search 必须精确匹配文件内容，不含行号前缀 `123│`）。",
  "2) 命令执行用 `propose_shell`（Windows=PowerShell，Unix=sh）。除非用户要求，不要用 `propose_apply_patch`。",
  "3) 报错后：读取相关源码/日志 → 推理原因 → 一次修正。",
].join("\n");

const RULE_TOOL_SELECTION = [
  "## 工具选择",
  "- **创建文件**：propose_file_edit + operation='create'。不要用 cat/echo 重定向。",
  "- **删除文件**：propose_shell（Unix: rm，Windows: Remove-Item）。",
  "- **长时间服务**：propose_shell + execution_mode='background'，可传 ready_url。",
  "- **交互式命令**：当前 shell 非交互式，脚手架命令加 --yes/-y 或手动创建文件。同类命令连续失败 2 次则停止重试。",
  "- 工具失败时阅读错误信息调整参数，不要盲目切换工具或重复重试。",
].join("\n");

const RULE_SEARCH_STRATEGY = [
  "## 搜索策略",
  "- 定位代码优先用 grep，查找文件优先用 glob，而非逐个盲读。",
  "- 大文件（400+行）分段读取（~300行/次），小文件直接读取。",
  "- 修改前必须有精确上下文（read_file/grep），确保 search 精确匹配原文。",
].join("\n");

const RULE_TASK_COMPLETION = [
  "## 任务完成",
  "- 所有交付物完成后，给出结构化总结（修改了什么、为什么、如何验证）。不要只回复「已完成」。",
  "- 不要主动优化/重构已完成的代码。同一文件连续修改 2 次失败则停下来。",
  "- 完成前调用 update_plan 将已完成步骤标为 completed。",
].join("\n");

const RULE_REVIEW_STRATEGY = [
  "## 审查策略",
  "审查/评估任务时：利用 repo-map 识别关键文件，最多精读 10 个，禁止穷举。信息足够后立即总结。",
].join("\n");

const RULE_META = [
  "严禁输出伪工具调用标签（如 <tool_call）。",
  "回复语言与用户保持一致。",
].join("\n");

const SYSTEM_RULE_BLOCKS = [
  RULE_CORE,
  RULE_EDITING,
  RULE_TOOL_SELECTION,
  RULE_SEARCH_STRATEGY,
  RULE_TASK_COMPLETION,
  RULE_REVIEW_STRATEGY,
  RULE_META,
] as const;

function mergeUniqueToolNames(...groups: ReadonlyArray<readonly string[]>): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();

  for (const group of groups) {
    for (const rawName of group) {
      const name = rawName.trim();
      if (!name || seen.has(name)) {
        continue;
      }
      seen.add(name);
      merged.push(name);
    }
  }

  return merged;
}

function resolveRuntimeToolGroups(
  runtime: ResolvedAgentRuntime,
  internalTools: readonly string[],
): { enabledTools: string[]; autoTools: string[]; askTools: string[] } {
  const autoTools = Object.entries(runtime.toolPermissions)
    .filter(([, level]) => level === "auto")
    .map(([name]) => name);
  const askTools = Object.entries(runtime.toolPermissions)
    .filter(([, level]) => level === "ask")
    .map(([name]) => name);

  return {
    enabledTools: mergeUniqueToolNames(runtime.enabledTools, internalTools),
    autoTools: mergeUniqueToolNames(autoTools, internalTools),
    askTools: mergeUniqueToolNames(askTools),
  };
}

function isWindowsHost(): boolean {
  const processPlatform =
    typeof globalThis === "object" && "process" in globalThis
      ? ((globalThis as { process?: { platform?: string } }).process?.platform ?? "")
      : "";

  if (typeof navigator !== "undefined") {
    return navigator.userAgent?.includes("Windows") ?? false;
  }

  return processPlatform === "win32";
}


// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Assemble the full system prompt for a resolved agent runtime.
 *
 * @param resolvedSkills - Optional resolved skills to inject into the prompt.
 */
export function assembleSystemPrompt(
  runtime: ResolvedAgentRuntime,
  resolvedSkills?: ResolvedSkill[],
): string {
  const rules = SYSTEM_RULE_BLOCKS.join("\n\n");
  const parts = [runtime.systemPrompt, rules];

  if (resolvedSkills && resolvedSkills.length > 0) {
    const skillFragment = buildSkillPromptFragment(resolvedSkills);
    if (skillFragment) {
      parts.push(skillFragment);
    }
  }

  return parts.join("\n\n");
}

/**
 * Assemble a runtime context block that describes the current workspace,
 * available tools.
 *
 * @param internalTools - Additional always-available internal tools (e.g. `update_plan`)
 *   that are not in `runtime.enabledTools` but should appear in the `本轮可用工具` list
 *   so the model sees a consistent tool inventory matching the actual function definitions
 *   sent to the LLM.  Internal tools are always auto-executed (no approval required).
 */
export function assembleRuntimeContext(
  runtime: ResolvedAgentRuntime,
  workspacePath: string,
  internalTools: readonly string[] = [],
): string {
  const normalizedWorkspacePath = workspacePath.trim();
  const workspaceLine = normalizedWorkspacePath
    ? `当前工作区: ${normalizedWorkspacePath}`
    : "当前工作区: 未选择";

  const { enabledTools, autoTools, askTools } = resolveRuntimeToolGroups(
    runtime,
    internalTools,
  );
  const enabledToolsLine = `本轮可用工具: [${enabledTools.join(", ")}]`;

  const osHint = isWindowsHost()
    ? "操作系统: Windows (shell 命令通过 PowerShell 执行，请使用 PowerShell 语法)"
    : "操作系统: Unix/macOS (shell 命令通过 sh 执行，请使用 POSIX shell 语法)";

  return [
    "运行时上下文：",
    workspaceLine,
    osHint,
    enabledToolsLine,
    `自动执行工具（无需审批）: [${autoTools.join(", ")}]`,
    `需审批工具: [${askTools.join(", ")}]`,
    "当前阶段可按需读取事实或提出待审批动作。",
    "权限说明：自动执行工具的调用结果会直接返回；需审批工具会生成待审批动作，由用户确认后执行。",
    "Git 工具说明：git_status 和 git_diff 在非 Git 仓库中会返回空结果，这是正常的。",
    "如需文件系统信息，必须通过已定义工具调用，不得臆测。",
  ].join("\n");
}
