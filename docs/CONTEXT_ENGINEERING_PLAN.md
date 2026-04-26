# Cofree 上下文工程计划（下一步）

> 本文档与 `CONTEXT_REFACTOR.md` 互为接续。后者记录的是已完成的 5→2 stage 简化；本文记录的是**下一阶段**应做与应砍的事项，便于核对与调整。
>
> 编制日期：2026-04-25
> 当前基准 commit：`2823ec1`（v0.1.4 release）

---

## 设计立场

**做 prompt caching 之前，所有 token 估算精度优化都是在错的层次解决问题。**

继续秉持 `CONTEXT_REFACTOR.md` 的剃刀原则：只为热路径写代码，冷路径让它走最笨但正确的分支。本轮的方向是：
- **补**：缓存、隔离探索、文件作为一等公民——这些是成熟 Vibe Coding 工具的标配
- **砍**：所有为"token 估算精度"服务的复杂度——上了缓存以后这些基本无意义

---

## 一、关键缺失（按 ROI 排序）

每项格式：状态 / 优先级 / 工作量 / 收益 / 当前现状 / 建议方案 / 验收标准。

### [x] M1. Prompt Caching 接入

- **优先级**：🔴 P0（单项最大收益）
- **工作量**：2-3 天
- **收益**：长会话输入成本下降 60-80%，TTFT 下降 30-50%
- **当前现状**：全代码库 grep `cache_control` / `prompt_cache` 零命中。架构上系统提示 + Skill + 工作记忆都钉在前缀，本来是缓存的最佳形状，但 `upsertWorkingMemoryContextMessage` 每 turn 重写工作记忆 system message，会让缓存失效。
- **建议方案**：
  1. 在 `src/lib/piAiBridge.ts` 给 Anthropic 请求加 `cache_control: { type: "ephemeral" }` 标记前缀（系统提示 + 工具定义 + 工作记忆）；OpenAI 自动缓存无需标记但要保证前缀字节稳定
  2. 改造 `upsertWorkingMemoryContextMessage`（`src/orchestrator/loopPromptScaffolding.ts`）：只在工作记忆**实际有变更**时刷新，稳态保持前缀字节级稳定
  3. 同样思路用于 repo-map 和 workspace overview 的刷新
  4. 在 audit log（`recordLLMAudit`）里加 `cache_creation_tokens` / `cache_read_tokens` 字段，验证命中率
- **验收**：
  - [ ] 第二轮起 `cache_read_tokens > 0`
  - [ ] 长会话（20+ turn）累计输入成本相比基线下降 ≥50%

### [ ] M2. Sub-agent / 隔离的探索调用

- **优先级**：🟠 P1
- **工作量**：约 1 周
- **收益**：长会话质量与稳定性显著改善（grep / list_files 不再污染主上下文）
- **当前现状**：`src/orchestrator/workingMemory.ts:45` 有 `SubAgentExecRecord` 类型但**只是历史记录**；没有真正的 sub-agent 调用能力。grep 等工具结果走 `smartTruncate` 直接灌进主上下文。
- **建议方案**：
  1. 新增 `delegate_search(query, scope)` 工具，内部跑独立的 LLM mini-loop（不进 checkpoint、不进 working memory）
  2. 子循环用现有 `runNativeToolCallingLoop` 改装即可（去掉 HITL、去掉持久化路径）
  3. 子循环只回写 ≤200 字摘要给主线程：`[delegate_search] 找到 X 在 a.ts:42, b.ts:89`
  4. 工具策略：默认 `auto`（不走 HITL）
- **验收**：
  - [ ] 一次大型 grep 任务，主上下文新增 token 数 < 直接调 grep 的 1/10
  - [ ] 主 LLM 仍能基于摘要做出正确决策（人工抽查 5 个 case）

### [x] M3. 文件作为一等公民（消除 stale read）

- **优先级**：🟠 P1
- **工作量**：约 1 周
- **收益**：长会话内文件被多次读取时不再重复占用 token
- **当前现状**：`read_file` 多次调用同一文件，所有结果都在消息历史里（参与 token 计数与压缩）。`WorkingMemory.fileKnowledge` 只存 200 字摘要，原始内容仍在消息流里。
- **建议方案**：
  1. 把"当前已知文件内容"提升为可更新的 slot（不是消息追加）
  2. `read_file` 工具结果不再写入消息历史，而是更新 `fileKnowledge[path].content`
  3. 后续工具调用引用文件时，从 slot 注入最新版本（覆盖旧版）
  4. 文件被修改后（`propose_apply_patch` 通过），自动失效对应 slot
- **风险**：改动到 ToolExecutor 的契约，需要小心兼容性。建议先用 feature flag 灰度。
- **验收**：
  - [ ] 同一文件读 3 次，消息历史里只占用一次的 token
  - [ ] 文件修改后再读，能拿到新内容

### [ ] M4. Repo-map symbol 化

- **优先级**：🟡 P2
- **工作量**：中-高（取决于是否引 tree-sitter）
- **收益**：同样预算下信息密度提升一个量级
- **当前现状**：`src/orchestrator/repoMapService.ts` 输出主要是文件清单 + 简单概览。`refreshWorkspaceContext` 还硬编码 `contextLimit = 128000`（见 X4）。
- **建议方案**：
  - 选项 A：引入 tree-sitter，提取符号级摘要（推荐，但工作量大）
  - 选项 B（轻量）：
    - TS：`tsc --emitDeclarationOnly` 提取 `.d.ts`
    - Rust：`cargo doc --no-deps` metadata
    - 其他语言降级到当前的文件清单
- **验收**：
  - [ ] 同样 4k 预算下，repo-map 包含的符号数比当前清单多 5×

### [x] M5. 消息编辑 / 会话分叉 UI

- **优先级**：🟢 P3
- **工作量**：中（前端为主）
- **收益**：产品体验贴近 Claude.ai / Cursor 的预期
- **现状**：checkpoint 是 turn 级恢复，但 UI 似乎没暴露"编辑历史消息重新生成"
- **建议**：暴露"编辑此条消息"按钮 → 截断后续历史 → 从该点重新生成。底层 checkpoint 机制已支持，主要是 UI 工作。
- **验收**：
  - [x] 用户可以编辑任意一条 user 消息并重新生成
  - [~] 旧分支保留为可切换的"checkpoint 历史"（**未做**——doc 标可选；本次实现走"截断丢弃"路线，保留分支需要 V2 数据模型）

**实现备注（2026-04-26）**：
- `truncateMessagesFrom(messages, fromMessageId)` 工具放在 `chatHistoryStore`
- 用户消息气泡 hover 显示 ✎ 编辑按钮（CSS 用 `:hover .chat-row.user` 触发，无 portal）
- ChatComposer 加 `editingMessageId` 模式：顶部黄色 banner 提示 + 提交按钮文案改"保存并重新生成" + 取消按钮一键复位
- handleEditSubmit 流程：snapshot 旧 messages → truncate → setMessages → 写盘 → `deleteWorkflowCheckpointsForConversation` 整段清 → 清 workingMemoryBySessionRef → runChatCycle。任一步抛错回滚 messages 并保留 editingMessageId 让用户重试
- Checkpoint 清理用整段 prefix delete（`deleteWorkflowCheckpointsForConversation`），不做 per-messageId 精细化——精细化要 Rust 后端增 invoke，性价比低
- WorkingMemory clear: `workingMemoryBySessionRef.current.clear()` 全清，比按 sessionId 找精确边界更稳
- 已知 gap：编辑 background streaming 中的会话不会先 abort（需要先 cancel 再编辑）；当前 isStreaming 守卫拒绝在流式中触发编辑，但 background 流不一定走 isStreaming 标记

### [ ] M6. 语义检索 / Embedding（**建议不做**）

- **判断**：对中小型 codebase（<10k 文件），好的 repo-map + grep 已经够用。引入本地 embedding 需要装模型/起服务，复杂度跳一档，边际收益不高。
- **保留观察**：如果用户反馈频繁出现"找不到相关代码"，再启动这一项。

---

## 二、过度复杂可砍（按砍掉收益排序）

每项格式：状态 / 当前位置 / 砍掉理由 / 简化方案 / 风险。

### [x] X1. 三层"是否压缩"判决合并成一层

- **当前位置**：`src/orchestrator/compressionScheduler.ts`
- **现状**：判决链 = `evaluateCompressionSafeZone(≤75%跳过)` → `canSummarizeNow(动态冷却)` → `softBudgetRatio=0.85`，三个机制 overlap
- **砍掉理由**：Safe-Zone 已 gate 90% 的 turn；剩下的部分动态冷却（45/60/120s 三档）基本是凭感觉；softBudgetRatio 是第三道闸
- **简化方案**：只保留 `tokens > budget × 0.85 就压缩`。删除整个动态冷却逻辑。
- **预期减码**：约 -150 行
- **风险**：失去"短时间反复压缩"的保护——但上了 prompt caching 后，重复触发摘要本身就便宜很多，且 Safe-Zone 已是最强的 gate

### [x] X2. 删除 `MessageTokenTracker` 增量缓存

- **当前位置**：`src/orchestrator/contextBudget.ts:118-189`
- **砍掉理由**：每 turn 调用 3-8 次 `estimateTokensForMessages`，100 条消息每次 <1ms。这是"为不存在的瓶颈优化"，但代码占 70 行 + 引入 invalidate 隐性契约
- **简化方案**：每次重算
- **预期减码**：-70 行
- **风险**：极端长会话（500+ 消息）可能感知；先 profile，真的有瓶颈再加回

### [x] X3. 删除 per-model EMA token 校准

- **当前位置**：`src/orchestrator/contextBudget.ts:230-303`
- **砍掉理由**：
  - 用户通常稳定用 1-2 个模型
  - 多脚本估算本身已经 ±15% 精度
  - 上了 prompt caching 后，缓存命中部分按缓存计费，估不准也无所谓
- **简化方案**：完全删掉 `updateTokenCalibration` / `calibrationByModel`。**保留**多脚本估算（对中文项目真有用，不能砍）
- **预期减码**：-70 行
- **风险**：估算精度从"动态校准 ±5%"降到"静态多脚本 ±15%"。在 prompt caching 时代不重要

### [x] X4. 修复 `refreshWorkspaceContext` 硬编码 128000

- **当前位置**：`src/orchestrator/loopPromptScaffolding.ts:169`
- **现状**：`const contextLimit = 128000; // Use default context limit`——bug
- **简化方案**：把实际 token 预算（runtime 已知）传进来。这不是砍代码而是修 bug
- **预期工作量**：30 分钟
- **风险**：无

### [x] X5. 删除 `computeAdaptiveCompressionParams` 假抽象

- **当前位置**：`src/orchestrator/contextPolicy.ts:57-65`
- **现状**：参数 `_limitTokens` 下划线打头表示根本不用，函数体只是返回常数对象
- **简化方案**：直接 `export const COMPRESSION_PARAMS = {...}`
- **预期减码**：-10 行 + 一层间接调用
- **风险**：无

### [~] X6. 合并 `discoveredFacts` 与 `fileKnowledge`（X6-lite 已完成；完整 merge 需要 checkpoint migration，留作后续）

- **当前位置**：`src/orchestrator/workingMemory.ts`
- **现状**：两个独立桶（上限 50 / 12），各自驱逐策略。但语义上"我知道 foo.ts 里的 bar 函数做 X" 既可以是 fact 也可以是 fileKnowledge
- **简化方案**：合并为统一的 `ContextEntity` 列表，按 `relevance + recency` 统一驱逐
- **预期减码**：`workingMemory.ts` 700+ 行可压到 ~300 行
- **风险**：序列化格式变更——需要 checkpoint migration（旧 checkpoint 反序列化时做兼容转换）

### [x] X7. `smartTruncate` 改尾切

- **当前位置**：`src/orchestrator/planningLoop.ts:143-158`
- **现状**：保留头 50% + 尾 50%，中间 `[已截断]`
- **砍掉理由**：对真实工具语义几乎从不正确：
  - `read_file`：关键函数往往在中间
  - `grep`：头尾匹配毫无关联
  - `list_files`：分页天然单位是"前 N 个 + 总数"
- **简化方案**：默认尾切，截断标记包含 `[已截断，原文 X 字符，可用 read_file/grep 再读 N-M 行]`，把"还需要更多就再调用一次"的责任甩给 LLM
- **风险**：极少数 case（超长 stack trace 等）尾部信息更重要——但这是少数派，用户可调

### [x] X8. 收敛 `pruneStaleSystemMessages` + `upsertWorkingMemoryContextMessage`

- **当前位置**：`src/orchestrator/loopPromptScaffolding.ts`
- **现状**：两个函数各自处理"系统消息时效性"。如果 upsert 是幂等的，prune 应该不必要
- **简化方案**：抽出 `PinnedSystemSlots` 概念——每个 slot 有 key（如 `working-memory` / `workspace-refresh` / `skill-context`），set 时自动替换；删除独立的 prune 函数
- **预期收益**：代码可读性提升；为 M1（prompt caching）的"前缀稳定"目标铺路
- **风险**：低，纯重构

### [x] X9. `ensureUserPresence` 改为 assert

- **当前位置**：`src/orchestrator/contextBudget.ts:464-472`
- **现状**：压缩后整个数组没有 user 消息时塞回最后一条——理论上不可达的兜底
- **简化方案**：改成 `assert`：触发了说明上游切片逻辑有 bug，应该崩而不是默默修复
- **风险**：如果真有未知 case 触发，会从"静默修复"变"崩溃"——但崩溃才能暴露 bug

---

## 三、落地顺序

按"先扫清前提，再补能力，最后清理"组织：

### 第一周：扫清前提
**目标**：把缓存吃下来 + 修最明显的 bug + 砍假抽象。这一周做完，后面很多简化的判断会变得显然。

- [x] M1 Prompt caching（重点）
- [x] X4 修 `refreshWorkspaceContext` 硬编码
- [x] X5 删 `computeAdaptiveCompressionParams` 假抽象
- [x] X8 收敛 pinned system slots（为 M1 的前缀稳定铺路）

**完成标志**：cache_read_tokens 出现在 audit log，长会话成本明显下降。

**第一周实现备注（2026-04-25）**：
- M1 单锚点策略：在 `piAiBridge.ts` 的 `onPayload` 里给 Anthropic system prompt 末尾打 `cache_control: { type: "ephemeral" }`；OpenAI 走自动前缀缓存
- 透传字段：`piAiBridge` normalized response 里同时暴露 `cache_creation_input_tokens` / `cache_read_input_tokens` 与 `prompt_tokens_details.cached_tokens`，audit log 与会话末尾日志都能看到
- X8 关键不变量：`setPinnedSlot` 通过 `PINNED_SLOT_ORDER` 保证 `workspace-refresh` 永远在 `working-memory` 之前，与调用顺序无关——稳态字节稳定
- X8 范围权衡：保留 `pruneStaleSystemMessages`（处理 cache anchor 之后的 tail-appended reminders，不影响 M1）。文档里"删除 prune"的目标需要把所有 tail reminder 也改 slot，留作后续

### 第二周：纯砍代码
**目标**：把 caching 之后不再必要的复杂度清掉。预计 -300~400 行，行为等价或略优。

- [x] X1 三层压缩判决合一
- [x] X2 删 MessageTokenTracker
- [x] X3 删 per-model 校准
- [x] X7 smartTruncate 改尾切
- [x] X9 ensureUserPresence 改 assert

**完成标志**：`pnpm test` 全绿；`compressionScheduler.ts` + `contextBudget.ts` 行数显著下降。

**第二周实现备注（2026-04-25）**：
- X1 删除 `compressionScheduler.ts` 整个文件（safe-zone gate / 动态冷却 / canSummarizeNow / markSummarizedNow）。每 turn 直接调 `compressMessagesToFitBudget`，由它内部的 "tokens already fit" 快速路径做无操作短路
- X2 删除 `MessageTokenTracker` class 与所有 `update/invalidate/notifyAppend` 调用。`estimateCurrentTokens` 直接走 `estimateTokensForMessages`，把"无瓶颈优化"砍掉
- X3 删除 `tokenCalibration` / `updateTokenCalibration` / `resetTokenCalibration` / `getTokenCalibrationFactor` / `calibrationByModel` / `TokenCalibrationState`，估算用静态多脚本权重（保留对中文友好的部分）。`[CtxMetric:post]` 日志保留以便监测漂移
- X9 不可达兜底改 assert 后跑测试发现 2 处真触发——把"必有 user 消息"的不变量推到了 `sliceRecentMessagesByBudget`：循环结束后若 recent 切片无 user，就额外往前走直到找到一条 user。不变量落到合理位置，assert 是真正的最后防线
- X7 `smartTruncate` 从"头 50% + 尾 50% + 中间省略"改为"头 + 尾切"，截断标记带 `已截断尾部 N 字符 / 原文 X 字符 / 总 Y 行 / 用 read_file/grep 再读`；移除 `headRatio` 参数

**净减码**：~250 行（compressionScheduler 122 + MessageTokenTracker 70 + EMA calibration 70 + smartTruncate 简化 ~10，扣除新增不变量代码）

### 第三周以后：补关键能力
**目标**：补齐与成熟工具的核心差距。这两项较大，按团队优先级二选一先做。

- [ ] M2 Sub-agent 隔离探索
- [x] M3 文件作为一等公民
- [~] X6 合并 `discoveredFacts` ↔ `fileKnowledge`（已做 X6-lite；完整结构合并 + checkpoint migration 留待后续）

**第三周（M3 + X6-lite）实现备注（2026-04-25）**：
- M3 保守变体：read_file 行为不变（首次读 LLM 同步看到 content_preview），但工具成功后把完整 body 缓存到 `WorkingMemory.fileKnowledge[path].content`；下一 turn 进 LLM 前 `dedupeStaleFileReads` 把更早的 read 重写为 stub，只保留最新一份完整内容
- M3 核心 API: `setFileContent(memory, path, content, ...)` 幂等且 contentVersion 仅在内容真变时 bump；`invalidateFileContent` 清空 content + version 但保留 metadata
- M3 失效策略：propose_file_edit 一旦成功（无论 auto-execute 还是 HITL pending）就失效目标 slot——LLM 即将编辑的文件，缓存内容应被视为不可信。Speculative invalidation 在 HITL 拒绝场景的代价仅是一次额外 read_file，永不送过期 bytes
- M3 已知 gap：HITL 跨 session 路径未做。用户 approve 之后下一个 session 从 checkpoint 恢复 WM，slot 仍带旧 content。下一轮 session 起步时按 mtime 校验 slot 新鲜度可填这个洞，留作后续
- X6-lite 范围：未改 checkpoint 格式，避开 migration 风险；只把 fact section 重复渲染逻辑抽成 `buildFactSection`，并在 serializeWorkingMemory 的"已读取文件"行加 `✓ 内容已缓存 v{N}` 标记，让 LLM 知道可不重读
- X6 完整版（统一 ContextEntity）需要 V2 snapshot + restore 兼容旧 checkpoint，留待下次 session

### 第四周以后（看反馈）
- [ ] M4 Repo-map symbol 化（计划 C 路线 regex 补漏，等 M5 完成后启动）
- [x] M5 消息编辑 UI
- [ ] M6 语义检索 — **暂不做**

**M5 实现备注（2026-04-26）**：见上文 §一·M5 实现备注。9 个新测试覆盖 truncateMessagesFrom（4）+ ChatComposer 编辑模式（3）+ ChatThreadSection 编辑按钮（6）。

---

## 四、决策记录（待团队确认）

每个决策点等用户/团队 review 后填写。

| 决策项 | 立场 | 状态 |
|--------|------|------|
| 是否优先做 prompt caching？ | 是（P0） | 用户批准 |
| 是否砍掉 token 校准 EMA？ | 是（与 caching 协同） | 用户批准 |
| sub-agent 是否走独立的 LLM 调用预算？（vs 共享主会话预算） | 独立预算 | 用户批准 |
| 文件一等公民是否破坏 ToolExecutor 旧契约？需要 feature flag 吗？ | 是，建议 flag | 用户批准 |
| 是否引入 tree-sitter 做 repo-map symbol 化？ | 倾向引入但工作量大 | 用户要求先不做 |
| 是否做语义检索？ | 不做 | 用户要求先不做 |

---

## 五、相关文档

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — 整体技术架构
- [`PRD.md`](./PRD.md) — 产品需求

---

## 附录 A：当前上下文管理涉及的核心文件

| 文件 | 职责 |
|------|------|
| `src/orchestrator/contextPolicy.ts` | 所有 token / 压缩参数的单一真源 |
| `src/orchestrator/contextBudget.ts` | Token 估算、消息切片、2-stage 压缩 |
| `src/orchestrator/compressionScheduler.ts` | Safe-Zone 判决、动态冷却 |
| `src/orchestrator/summarization.ts` | 单次摘要 + 缓存 |
| `src/orchestrator/loopPromptScaffolding.ts` | 工作记忆/workspace 注入、pinned system 维护 |
| `src/orchestrator/workingMemory.ts` | fileKnowledge + discoveredFacts + 序列化 |
| `src/orchestrator/checkpointBridge.ts` | 增量 checkpoint 触发 |
| `src/orchestrator/repoMapService.ts` | Repo-map 生成 |
| `src/lib/piAiBridge.ts` | LLM 网关，prompt caching 接入点 |
| `src-tauri/src/infrastructure/checkpoint_repo.rs` | SQLite checkpoint 持久化 |
