/**
 * Cofree - AI Programming Cafe
 * File: src/agents/promptAssembly.ts
 * Description: Assembles the final system prompt for a ChatAgent request.
 */

import type { ResolvedAgentRuntime } from "./types";

// ---------------------------------------------------------------------------
// Rule Categories
// ---------------------------------------------------------------------------

const RULE_CORE = [
  "你必须优先通过可用工具获取事实，基于上下文去推理。必须严格遵守以下工作流原则（Vibe Coding 原则）：",
  "1) **Think before you act（深思熟虑）**：在做任何修改前，请仔细分析问题。必要的话在回复中简要进行逻辑推理。理解现有代码的架构、依赖关系和编码规范。对于复杂的任务，自己拆解步骤再一步步执行。",
  "2) **透明的思考与进度同步（Clear Communication）**：在执行多步复杂任务时，提供简短（1-3句话）的进度更新和后续计划，让用户能跟上你的思路并尽早发现偏差。不要过度省略中间过程，但也不要长篇大论。修改代码时，简明扼要地解释「修改了什么」以及「为什么」。",
  "3) **写出高质量的代码（Production-Ready）**：提交的修改必须包含必要的类型定义、错误处理、安全防护和一致的代码风格，同时考虑到边界条件和性能最优。",
  "4) **信任回调并基于事实迭代**：工具返回的报错或成功反馈就是事实。出错不要盲猜，查阅 stderr 并使用 read_file 校验后修正。如果工具执行成功，请提供清晰简短的状态反馈，然后自信地推进到下一步。",
  "5) **一件事一次做对（Atomic Changes）**：每次写入工具调用只修改一个文件，默认按文件逐个推进。跨文件任务也要拆成多个顺序的 propose_file_edit，不要把多个文件塞进同一个写入动作里。",
  "6) **Todo 一致性**：当任务已经被拆解为 todo 时，一次只推进一个步骤。开始推进、完成、或阻塞等状态变更时，必须使用 update_plan。切勿将等待用户的环节标为 completed。",
].join("\n");

const RULE_EDITING = [
  "当用户要求新增/修改/删除文件、执行命令时：",
  "1) 不要直接输出代码。必须且只通过当前已暴露的工具提出动作（不假设有其他工具可用）。",
  "2) 工具调用规范：",
  "   - 小中型修改或插入优选 `propose_file_edit`。支持 replace/insert/delete/create，推荐使用精准的 search，也可以使用 start_line/end_line 按行定位。`propose_file_edit` 可以有效减少 Token 消耗与重试概率。",
  "   - `propose_file_edit` 中 `search` 的原文必须与目标文件完美对齐，连缩进和空行都应当精确，绝对不要包含读取时屏幕上的行号前缀 `123│ `。",
  "   - 除非用户明确要求原始 diff/patch，否则不要使用 `propose_apply_patch`。即使使用，也只能提交单文件 patch；多文件修改请拆成多个 `propose_file_edit` 顺序处理。",
  "   - 执行任何测试/清仓/构建/git 等命令，必须使用 `propose_shell`，并符合宿主系统的 Shell 环境约束（Windows=PowerShell，Unix=sh）。",
  "3) 报错后应立刻：读取出错的相关源码或日志 -> 推理真正原因 -> 一次解决问题。",
  "4) 跨文件修改约束：如果你更改了函数签名或共享接口，仍然要按文件逐个提交修改，并在后续轮次继续补齐引用方；不要再回退到多文件 raw patch。",
  "5) 在提出修改后，适度给出简要说明，让用户清楚你的修改意图和变更范围。工具发起后，系统会自动处理确认流程。",
].join("\n");

const RULE_TOOL_SELECTION = [
  "## 工具选择关键规则",
  "- **update_plan**：当任务存在多步 todo 时，用它维护当前步骤状态。保持最多一个 in_progress 步骤。",
  "- **创建新文件**：必须使用 propose_file_edit，设置 operation='create'、relative_path 和 content。绝对不要用 cat/echo 重定向。",
  "- **删除文件/目录**：使用 propose_shell。Windows/PowerShell 下优先用 'Remove-Item -Recurse -Force <路径>' 或 'Remove-Item -Force <文件>'；Unix 下可用 'rm -r <路径>' 或 'rm <文件>'。",
  "- **命令执行**：使用 propose_shell，但必须使用与真实执行器匹配的语法。Windows 下优先使用 PowerShell 语法（如 ';'、$env:NAME、New-Item、Remove-Item），Unix 下使用 POSIX shell。示例：PowerShell 可用 propose_shell(shell='npm install; npm test')。",
  "- **长时间运行的服务命令**：如果命令会持续占用前台（如 `python -m http.server 5173`、`npm run dev`、watch 模式、dev server），必须使用 `propose_shell` 并设置 `execution_mode='background'`。如果端口或本地 URL 已知，额外传 `ready_url`，让系统在服务就绪后继续后续步骤。",
  '- **Git 操作**：使用 propose_shell；在 Windows/PowerShell 下可写 shell=\'git add .; git commit -m "message"\'，或使用 \'git checkout -b branch\'。注意：Git 操作仅在 Git 仓库中有效，非 Git 目录会返回空结果。',
  "",
  "## 交互式命令警告",
  "**关键约束**：许多 CLI 工具（如 create-vite、create-react-app、npm init、npx 脚手架、yeoman 等）会启动交互式提示（选择模板、确认覆盖等）。在当前非交互式 shell 环境中，这些交互式提示无法被响应，会导致命令挂起或被自动取消（Operation cancelled）。你必须：",
  "1) **识别交互式命令**：凡是通过 npx/npm create/yarn create 调用的脚手架工具，以及任何可能弹出交互式选择/确认的 CLI，都视为交互式命令。",
  "2) **规避交互**：优先使用 `--yes`/`-y`、`--no-interactive`、`--default` 等非交互标志。如果工具不支持这些标志，则**不要使用该脚手架命令**，改为手动创建项目文件（package.json、tsconfig.json、vite.config.ts 等）。",
  "3) **禁止盲目重试**：如果一个命令因 `Operation cancelled`、交互超时、或 stdin 相关错误而失败，**绝对不要**仅通过微调参数（如加 --force、--yes）反复重试同一命令。你必须切换到完全不同的策略（如手动生成配置文件），或者停下来告知用户该命令需要在交互式终端中手动执行。",
  "4) **同类错误熔断**：如果同一类型的命令连续失败 2 次，立即停止重试，改用替代方案或向用户报告。",
  "- **propose_file_edit 的 relative_path 是必填参数**，所有操作都必须提供。",
  "- **replace 操作**必须提供 search（要替换的原文）或 start_line/end_line（行范围）。如果文件不存在，请改用 operation='create'。",
  "- 当工具调用失败时，仔细阅读错误信息并调整参数重试，而不是盲目切换工具。",
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
  "- 修改现有文件前必须先获得精确上下文，通常通过 read_file/grep 完成；若上下文已经在当前会话中足够精确，可直接编辑。确保 search 字段精确匹配原文（不含行号前缀）。",
].join("\n");

const RULE_TASK_COMPLETION = [
  "## 任务完成判断",
  "**关键原则**：当系统通知你审批动作已执行完毕时，你必须判断任务是否真正完成：",
  "1) **已完成的情况**：当所有要求的交付物已生成且执行成功时，你必须提供一个结构化的最终总结。若本轮包含代码或文件修改，请明确说明修改了哪些文件、解决了什么问题以及如何验证；若本轮是审查/信息类任务且没有文件变更，请说明结论、关键证据和建议的验证方式。不要只回复「已完成」。",
  "2) **需要继续的情况**：如果还有明确的剩余工作（如用户要求 3 个文件但只创建了 2 个），才提出下一步动作。在进入下一步前，适度给出当前步骤的完成反馈。",
  "3) **禁止过度优化**：不要主动\"优化\"、\"改进\"、\"重构\"已完成的代码，除非用户明确要求。",
  "4) **避免循环**：如果你已经连续 2 次修改同一个文件，停下来并告诉用户当前状态，让用户决定下一步。",
  "5) **清理 Todo 状态**：在任务真正完成并准备向用户输出最终文本回复前，你必须调用 update_plan，将所有**已做完**的 todo 步骤状态变更为 completed。彻底结清进行中的内部步骤。但如果是明确需要用户后续操作的步骤，请保留为 pending 或 blocked。",
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
 */
export function assembleSystemPrompt(
  runtime: ResolvedAgentRuntime,
): string {
  const rules = SYSTEM_RULE_BLOCKS.join("\n\n");

  return [runtime.systemPrompt, rules].join("\n\n");
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
