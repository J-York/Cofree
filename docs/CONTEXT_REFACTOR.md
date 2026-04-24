# 上下文裁剪机制重构计划

## 背景

当前 `src/orchestrator/` 下的上下文预算 / 消息压缩 / 工具结果裁剪逻辑，总共牵涉 ~98 个魔法数字、3 层 tier × 9 参数的自适应压缩表、5 阶段压缩管线（pre-compress → merge → summarize → truncate → retry×3）。这套设计是"模型只有 32k/128k"时代的产物。2026 年主流模型 ≥200k、Opus 到 1M，绝大多数会话根本不触发压缩；现有代码的复杂度主要在为冷路径服务，冷路径又很少被走到，于是容易腐化（例如已经发现的字段级 500→400 字符硬切 bug）。

## 剃刀原则

**只为热路径写代码，冷路径让它走最笨但正确的分支。**

保留三样东西：

1. 一个 token 估算函数（字符数 / 3.5 + per-model 自校准 EMA）
2. 工具结果入口硬闸：一个常量 `MAX_TOOL_OUTPUT_CHARS`，由模型窗口推导，无工具类型分叉
3. 一次溢出处理：保留 `system prefix + 最后一条 user + 最近 N 轮`，不够就把中间旧消息做一次摘要替换

删除所有启发式 importance 评分、proactive context editing、per-tool 专用阈值、retry×reduction 循环、tier 分档表。

## 最终形态

### 单一 policy（替代 3-tier 表）

```ts
function computePolicy(modelContextWindow: number, modelMaxOutput: number) {
  const outputReserve = Math.min(modelMaxOutput + 2000, 20000);
  const budget = modelContextWindow - outputReserve;
  return {
    promptBudget: budget,
    softTrigger: Math.floor(budget * 0.85),   // 压缩触发
    minRecentMessages: 16,
    minMessagesToSummarize: 4,
  };
}
```

### 统一工具输出闸

```ts
MAX_TOOL_OUTPUT_CHARS = Math.min(40000, Math.floor(budget * 3.5 / 8));
```

所有工具走同一个 `smartTruncate(output, MAX_TOOL_OUTPUT_CHARS)`，不再按 grep / glob / shell / fetch 分叉。

### 压缩流程（替代 5 阶段管线）

```
if 当前 tokens <= budget: return 原样
splitIndex = 保留 system prefix + 最后一条 user + 最近 minRecentMessages 条
old = messages[pinnedLen..splitIndex]
if old.length < minMessagesToSummarize:
  直接丢，插一条 "[历史已截断]"
else:
  调 summarizer 产出一条 system 消息替换 old
return pinned + [summary] + recent
```

## 分阶段执行

### Phase 0：加测量（~30 min，不改行为）

在 `planningLoop` 发请求前后各打一条结构化日志：

- `estimatedTokens` / `actualTokens`
- `contextUsedPct`
- `compressionFired`（bool）
- `turnsInLoop`

跑若干真实会话，为后续每阶段效果评估建立基线。

### Phase 1：常量集中（~1h，纯搬运）

新建 `src/orchestrator/contextPolicy.ts`，把散落在以下文件的上下文相关常量集中：

- `contextBudget.ts`
- `planningLoop.ts`
- `toolCallAnalysis.ts`
- `explicitContextService.ts`
- `workingMemory.ts`
- `summarization.ts`

**不动值、不动逻辑**，只改 import。目的是让后续每一步"删一块常量就知道影响了谁"。

### Phase 2：砍 tier（~2h，核心瘦身）

替换 `computeAdaptiveCompressionParams`：`AdaptiveCompressionParams` 的 9 个字段缩减到 4 个（`promptBudget` / `softTrigger` / `minRecentMessages` / `minMessagesToSummarize`）。

删除：

- `computeAdaptiveCompressionParams` 的 3 层 if/else
- 所有 `contextEditTriggerTokenRatio` / `contextEditKeepRecentTurns` / `contextEditTriggerEveryNTurns` 调用路径
- `CLEARABLE_TOOL_NAMES` 及其 proactive clearing 逻辑

### Phase 3：统一工具输出闸（~1h）

在 `toolCallAnalysis.ts`：

- 删除 `MAX_GREP_PREVIEW_MATCHES` / `MAX_GREP_PREVIEW_CHARS` / `MAX_GLOB_PREVIEW_FILES` / `MAX_GLOB_PREVIEW_CHARS` / `MAX_SHELL_TOOL_PREVIEW_CHARS` / `MAX_FETCH_PREVIEW_CHARS`（6 个常量）
- 保留 `MAX_TOOL_OUTPUT_CHARS`，改为从 policy 推导
- 所有工具过同一个 `smartTruncate`

预期影响：大窗口用户 `read_file` / `fetch` 能吃到 40k 字符（当前 15k）；grep / glob 的"匹配数 vs 字符数"双闸简化成字符数单闸。

### Phase 4：压缩管线 5 阶段 → 2 阶段（~3h，最大一块）

替换 `compressMessagesToFitBudget` 整个函数体，按"最终形态—压缩流程"实现。

删除：

- `preCompressToolMessages`
- `compressToolMessageContent`（字段级 500/400/10 硬切 bug 的源头）
- `mergeConsecutiveToolMessages` 及其 `findPrecedingAssistantWithToolCalls`
- `scoreMessageImportance` + `IMPORTANCE_RESCUE_THRESHOLD`
- `MAX_COMPRESSION_RETRIES` 重试循环
- `retryReductionFactor`

保留：

- `sliceRecentMessagesByBudget`
- `adjustSplitIndexToAvoidOrphanToolMessages`（orphan tool 消息处理是协议正确性刚需）

### Phase 5：token 估算简化（~1h，可选）

当前 CJK / Latin / code / digit / whitespace 5 路分类 + per-model EMA 校准。EMA 自校准通常 2–3 轮收敛到正确值，多路分类带来的精度提升大部分被校准吃掉。

可选瘦身：

```ts
export function estimateTokensFromText(text: string, factor = tokenCalibration.factor) {
  return Math.ceil((text.length / 3.5) * factor);
}
```

此阶段风险最大（影响估算准确度），放最后、可独立跳过。

### Phase 6：settings 清理（~30 min）

- 从 `AppSettings` 删 `maxContextTokens`
- `resolveEffectiveContextTokenLimit` 直接返回 `activeModel.metaSettings.contextWindowTokens`
- Settings UI 对应字段删除

## 预期收益

| 指标 | Before | After |
| --- | --- | --- |
| 上下文相关常量 | ~98 | ~15 |
| 压缩管线阶段 | 5 | 2 |
| tier 分支 | 3 | 0 |
| `compressMessagesToFitBudget` 行数 | ~200 | ~60 |
| 影响上下文行为的文件 | 8 | 3 |
| 1M 模型下 `read_file` 有效字符 | 15k | 40k |
| 字段级 400-char bug | 存在 | 消除 |

## 风险与验证

- **最大风险**：Phase 4 的 summarization 质量。当前代码为了"不丢信息"加了 importance rescue 和 retry loop，删掉后依赖 summarizer 一次到位。
  - **缓解**：Phase 0 日志里加一条 summarizer 质量探针（摘要后问模型"上一轮讨论了什么"，测召回率）。
- **回归测试**：`src/orchestrator/` 下有对应单测，按 phase 顺序跑 `pnpm test -- --run src/orchestrator`，逐阶段通过再合并。
- **灰度策略**：Phase 2–4 藏在 feature flag `simpleContextPolicy` 后面，本地跑一周真实会话再默认开启。

## 执行顺序建议

Phase 0 → 1 → 3 → 2 → 4 → 6 → 5（可选）

先做 Phase 3（工具闸统一）而非 Phase 2（砍 tier），因为 Phase 3 影响面小且用户可感知收益立竿见影；Phase 2、4 互相耦合，放在一起做。Phase 5 涉及估算精度，单独灰度。
