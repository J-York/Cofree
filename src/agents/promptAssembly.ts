/**
 * Cofree - AI Programming Cafe
 * File: src/agents/promptAssembly.ts
 * Description: Assembles the final system prompt for a ChatAgent request.
 *
 * Layers (from bottom to top):
 *   1. Base workflow rules (propose_*, tool selection, task completion)
 *   2. Agent-specific prompt template
 *   3. Runtime context (workspace, tools, permissions)
 *   4. Project-level .cofreerc fragments
 *   5. Workspace overview & context files (injected by orchestrator at first turn)
 */

import type { ResolvedAgentRuntime, SubAgentRole } from "./types";
import { DEFAULT_AGENTS } from "./defaultAgents";

// ---------------------------------------------------------------------------
// Rule Categories
// ---------------------------------------------------------------------------

const RULE_CORE = [
  "你必须优先通过可用工具获取事实，再给出答案。必须严格遵守以下工作流原则（Vibe Coding 原则）：",
  "1) **Show, don't tell**：少废话，多干活。直接执行任务，不要在回复中长篇大论解释代码原理、功能特点，除非用户明确要求解释。",
  "2) **信任系统回调**：当系统提示动作成功（如 apply_patch, shell 等）时，直接信任结果并继续执行。不要做无意义重复读取；但在 patch/编辑失败后，允许有针对性地重新读取相关片段并修复。",
  '3) **极简交流**：在报告完成任务时，只需简短回答"已完成"或指明结果位置。绝对不要为了凑字数而列举无关内容。',
].join("\n");

const RULE_EDITING = [
  "当用户要求新增/修改/删除文件、执行命令时：",
  "1) 不要直接执行副作用；",
  "2) 必须通过当前已暴露的 propose_* 工具提出待审批动作（不要假设未暴露工具可用）。",
  "2.1) 单文件、小中型改动优先用 propose_file_edit；它支持 replace / insert / delete / create，也支持 line/start_line/end_line 按行定位，系统会自动把编辑转换为 patch。",
  "2.2) 仅在明确需要 raw diff/patch 时使用 propose_apply_patch，并确保 patch 是合法 unified diff。",
  "2.3) 如果目标是执行任何命令（构建、测试、删除、git 操作等），使用 propose_shell。命令必须匹配真实执行器：Windows 实际通过 PowerShell 执行，Unix 通过 sh 执行。若 propose_shell 为自动执行，它会立即在真实 shell 中运行。",
  "2.4) 如果收到 patch 预检失败反馈，优先重新读取必要片段后修正，并在一次自动修复重试内完成。",
  "2.5) 如果 propose_shell 自动执行失败，先阅读 stderr 并修正命令后再重试；Windows 下优先改为 PowerShell 语法，不要重复 mkdir -p、rm -r、&& 等 bash/cmd 风格写法。",
  '**重要**：调用 propose_* 工具后，立即停止生成文本。不要预测审批结果，不要说"用户未批准"或"等待用户批准"等话。系统会自动处理审批流程并在执行后通知你结果。',
  "3) 如果用户仅在询问信息或解释且不需要落盘，不要提出审批动作。",
  "4) 不要为了兜底提出无关审批动作；当用户请求包含多个交付物时，可以在同一轮提出多个紧密相关动作（建议 ≤5）以减少往返审批。",
  "4.1) **多文件编辑原子性**：当一个功能变更涉及多个文件时（如修改接口定义并同步更新所有调用方），尽量在同一轮工具调用中提出所有相关的 propose_file_edit，系统会将它们打包为一次原子审批。全部成功才生效，任何一个失败则全部回滚。",
  "4.2) 先完成所有必要的上下文收集（grep/read_file），然后在一轮中集中提出所有相关编辑，避免分散在多轮中逐个提出。",
].join("\n");

const RULE_TOOL_SELECTION = [
  "## 工具选择关键规则",
  "- **创建新文件**：必须使用 propose_file_edit，设置 operation='create'、relative_path 和 content。绝对不要用 cat/echo 重定向。",
  "- **删除文件/目录**：使用 propose_shell。Windows/PowerShell 下优先用 'Remove-Item -Recurse -Force <路径>' 或 'Remove-Item -Force <文件>'；Unix 下可用 'rm -r <路径>' 或 'rm <文件>'。",
  "- **命令执行**：使用 propose_shell，但必须使用与真实执行器匹配的语法。Windows 下优先使用 PowerShell 语法（如 ';'、$env:NAME、New-Item、Remove-Item），Unix 下使用 POSIX shell。示例：PowerShell 可用 propose_shell(shell='npm install; npm test')。",
  '- **Git 操作**：使用 propose_shell；在 Windows/PowerShell 下可写 shell=\'git add .; git commit -m "message"\'，或使用 \'git checkout -b branch\'。注意：Git 操作仅在 Git 仓库中有效，非 Git 目录会返回空结果。',
  "- **propose_file_edit 的 relative_path 是必填参数**，所有操作都必须提供。",
  "- **replace 操作**必须提供 search（要替换的原文）或 start_line/end_line（行范围）。如果文件不存在，请改用 operation='create'。",
  "- 当工具调用失败时，仔细阅读错误信息并调整参数重试，而不是盲目切换工具。",
  "",
  "## Sub-Agent 委派",
  "- 当任务可以拆分为独立子任务时，可使用 task 工具委派给专业 Sub-Agent。",
  "- Sub-Agent 会独立运行工具调用循环并返回结果摘要。",
  "- 适用场景：需要并行分析、实现和验证的复杂任务。",
  "- 注意：Sub-Agent 无法嵌套调用 task 工具，避免循环委派。",
].join("\n");

const RULE_SEARCH_STRATEGY = [
  "## 搜索与文件读取策略",
  "当深入一个文件或功能时，利用 grep 积极追踪 import 路径和函数调用链，扩充上下文理解，避免盲目猜测。",
  "定位代码（函数定义、变量使用、导入语句等）时，优先使用 grep 搜索关键词，而非逐个文件盲读。",
  "当查找文件时，优先使用 glob 匹配模式（如 '**/*.tsx'），而非逐层 list_files。",
  "grep 和 glob 会自动排除 .git、node_modules、target 等目录。",
  "当读取文件系统信息时，必须调用 list_files/read_file/grep/glob/git_status/git_diff，而不是伪造结果。",
  "read_file 返回带行号的内容（格式: `行号│内容`）、total_lines（文件总行数）和 showing_lines（当前显示的行范围）。",
  "**注意**：行号前缀 `行号│` 仅用于定位参考，不是文件实际内容。在 propose_file_edit 的 search/anchor 字段中，不要包含行号前缀。",
  "- 小文件（<400 行）：直接读取，无需指定 start_line/end_line。",
  "- 大文件（400+ 行）：分段读取。先不带参数调用 read_file 查看前半部分，根据 total_lines 和 truncated 标志决定是否需要继续读取。",
  "  - 若 truncated=true，使用 start_line/end_line 读取后续部分（如 start_line=301, end_line=600）。",
  "  - 每次读取 ~300 行为宜。如果只需要特定函数或区域，根据行号精确读取该范围即可。",
  "- 修改文件前必须先读取相关部分，确保 search 字段精确匹配原文（不含行号前缀）。",
].join("\n");

const RULE_TASK_COMPLETION = [
  "## 任务完成判断",
  "**关键原则**：当系统通知你审批动作已执行完毕时，你必须判断任务是否真正完成：",
  '1) **已完成的情况**：如果所有要求的交付物已生成，且执行结果显示成功，直接回复"已完成"。**不要**重复读取文件验证，**不要**提出新的修改。',
  "2) **需要继续的情况**：如果还有明确的剩余工作（如用户要求 3 个文件但只创建了 2 个），才提出下一步动作。",
  '3) **禁止过度优化**：不要主动"优化"、"改进"、"重构"已完成的代码，除非用户明确要求。',
  "4) **避免循环**：如果你已经连续 2 次修改同一个文件，停下来并告诉用户当前状态，让用户决定下一步。",
].join("\n");

const RULE_REVIEW_STRATEGY = [
  "## 审查/评估任务策略",
  "你正在执行代码审查或评估任务，必须遵守以下约束：",
  "1) **先看全貌**：首先利用已提供的 repo-map（项目结构概览）识别关键文件，而非逐个文件盲读。",
  "2) **抽样阅读**：最多精读 10 个关键文件。选择标准：入口文件、核心组件、配置文件。",
  "3) **禁止穷举**：不要试图读完项目中的所有文件。读取的文件总数不应超过 15 个。",
  "4) **尽早总结**：当你已经对项目有了足够的了解后，立即停止读取并给出评价和建议。",
  "5) **结构化输出**：按优先级列出发现的问题和优化建议，而非逐文件罗列。",
].join("\n");

const RULE_META = [
  "严禁输出伪工具调用标签（如 <tool_call>）。",
  "回复语言与用户保持一致。",
].join("\n");

// ---------------------------------------------------------------------------
// Rule category registry
// ---------------------------------------------------------------------------

type RuleCategory = "core" | "editing" | "toolSelection" | "searchStrategy"
  | "taskCompletion" | "reviewStrategy" | "metaRules";

const RULE_CATEGORIES: Record<RuleCategory, string> = {
  core: RULE_CORE,
  editing: RULE_EDITING,
  toolSelection: RULE_TOOL_SELECTION,
  searchStrategy: RULE_SEARCH_STRATEGY,
  taskCompletion: RULE_TASK_COMPLETION,
  reviewStrategy: RULE_REVIEW_STRATEGY,
  metaRules: RULE_META,
};

// ---------------------------------------------------------------------------
// Task type classification
// ---------------------------------------------------------------------------

export type TaskType = "code_edit" | "exploration" | "shell_ops" | "information" | "review" | "mixed";

const INFORMATION_KEYWORDS = [
  "什么是", "解释", "说明", "为什么", "how does", "what is", "explain",
  "describe", "why", "tell me", "帮我理解", "区别", "difference",
  "compare", "概念", "原理", "含义", "定义",
];

const EXPLORATION_KEYWORDS = [
  "查找", "搜索", "哪里", "哪个文件", "在哪", "find", "where", "search",
  "locate", "look for", "which file", "代码在哪", "定位",
];

const SHELL_KEYWORDS = [
  "运行", "执行", "安装", "部署", "构建", "编译", "测试",
  "run", "execute", "install", "deploy", "build", "compile", "test",
  "npm", "cargo", "pip", "yarn", "docker", "git ",
];

const CODE_EDIT_KEYWORDS = [
  "修改", "创建", "新建", "添加", "删除", "重构", "修复", "实现", "更新",
  "modify", "create", "add", "delete", "remove", "refactor", "fix", "implement",
  "update", "change", "write", "edit", "patch", "bug",
];

const REVIEW_KEYWORDS = [
  "怎么样", "如何评价", "值得优化", "有没有问题", "改进建议",
  "代码质量", "最佳实践", "优化建议", "审查", "评估",
  "review", "audit", "evaluate", "assess", "quality",
  "improve", "suggestion", "feedback",
];

export function classifyTaskType(prompt: string): TaskType {
  const lower = prompt.toLowerCase();

  let infoScore = 0;
  let exploreScore = 0;
  let shellScore = 0;
  let editScore = 0;
  let reviewScore = 0;

  for (const kw of INFORMATION_KEYWORDS) {
    if (lower.includes(kw)) infoScore += 1;
  }
  for (const kw of EXPLORATION_KEYWORDS) {
    if (lower.includes(kw)) exploreScore += 1;
  }
  for (const kw of SHELL_KEYWORDS) {
    if (lower.includes(kw)) shellScore += 1;
  }
  for (const kw of CODE_EDIT_KEYWORDS) {
    if (lower.includes(kw)) editScore += 1;
  }
  for (const kw of REVIEW_KEYWORDS) {
    if (lower.includes(kw)) reviewScore += 1;
  }

  const total = infoScore + exploreScore + shellScore + editScore + reviewScore;

  // If no keywords matched, default to mixed
  if (total === 0) return "mixed";

  // Review判断优先于code_edit：review请求通常是"评价/审查"而非"动手改"
  if (reviewScore > 0 && reviewScore >= total * 0.4 && editScore <= 1) {
    return "review";
  }

  // If a single category dominates (> 50% of matches), use it
  if (infoScore > 0 && infoScore >= total * 0.6 && editScore === 0 && shellScore === 0) {
    return "information";
  }
  if (exploreScore > 0 && exploreScore >= total * 0.5 && editScore === 0) {
    return "exploration";
  }
  if (shellScore > 0 && shellScore >= total * 0.5 && editScore === 0) {
    return "shell_ops";
  }
  if (editScore > 0 && editScore >= total * 0.4) {
    return "code_edit";
  }

  return "mixed";
}

// ---------------------------------------------------------------------------
// Rules-by-task-type mapping
// ---------------------------------------------------------------------------

const RULES_BY_TASK_TYPE: Record<TaskType, RuleCategory[]> = {
  information: ["core", "metaRules"],
  exploration: ["core", "searchStrategy", "taskCompletion", "metaRules"],
  shell_ops: ["core", "toolSelection", "taskCompletion", "metaRules"],
  code_edit: ["core", "editing", "toolSelection", "searchStrategy", "taskCompletion", "metaRules"],
  review: ["core", "searchStrategy", "reviewStrategy", "taskCompletion", "metaRules"],
  mixed: ["core", "editing", "toolSelection", "searchStrategy", "taskCompletion", "metaRules"],
};

// ---------------------------------------------------------------------------
// Backward-compatible: full rules string (all categories)
// ---------------------------------------------------------------------------

const BASE_WORKFLOW_RULES = Object.values(RULE_CATEGORIES).join("\n\n");

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Assemble the full system prompt for a resolved agent runtime.
 * When taskType is provided, only the relevant rule categories are included.
 */
export function assembleSystemPrompt(
  runtime: ResolvedAgentRuntime,
  taskType?: TaskType,
): string {
  if (!taskType) {
    return `${runtime.systemPrompt}\n\n${BASE_WORKFLOW_RULES}`;
  }

  const categories = RULES_BY_TASK_TYPE[taskType];
  const rules = categories.map((cat) => RULE_CATEGORIES[cat]).join("\n\n");
  return `${runtime.systemPrompt}\n\n${rules}`;
}

/**
 * Assemble a runtime context block that describes the current workspace,
 * available tools, and sub-agent roles.
 */
export function assembleRuntimeContext(
  runtime: ResolvedAgentRuntime,
  workspacePath: string,
): string {
  const workspaceLine = workspacePath.trim()
    ? `当前工作区: ${workspacePath}`
    : "当前工作区: 未选择";

  const enabledToolsLine = `本轮可用工具: [${runtime.enabledTools.join(", ")}]`;

  const autoTools = Object.entries(runtime.toolPermissions)
    .filter(([, level]) => level === "auto")
    .map(([name]) => name);
  const askTools = Object.entries(runtime.toolPermissions)
    .filter(([, level]) => level === "ask")
    .map(([name]) => name);

  const allowedRoles: SubAgentRole[] = runtime.allowedSubAgents;
  const agentLines = DEFAULT_AGENTS
    .filter((a) => allowedRoles.includes(a.role))
    .map(
      (a) => `- ${a.role}: tools=[${a.tools.join(", ")}], sensitiveActionAllowed=${a.sensitiveActionAllowed}`,
    );

  return [
    "运行时上下文：",
    workspaceLine,
    enabledToolsLine,
    `自动执行工具（无需审批）: [${autoTools.join(", ")}]`,
    `需审批工具: [${askTools.join(", ")}]`,
    "当前阶段可按需读取事实或提出待审批动作。",
    ...(agentLines.length > 0 ? ["可用 Sub-Agent 角色：", ...agentLines] : []),
    "权限说明：自动执行工具的调用结果会直接返回；需审批工具会生成待审批动作，由用户确认后执行。",
    "Git 工具说明：git_status 和 git_diff 在非 Git 仓库中会返回空结果，这是正常的。",
    "如需文件系统信息，必须通过已定义工具调用，不得臆测。",
  ].join("\n");
}
