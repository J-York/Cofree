- 2026-04-22 [A1] 删除多 Agent 编排层完成。净减约 1.5K LoC，删除 9 个文件（expertStageMessages.ts/.test.ts, teamTrust.ts/.test.ts, WorkspaceTeamTrustDialog.tsx/.test.tsx, useWorkspaceTeamTrust.ts, workspaceTeamTrustStore.ts/.test.ts），手术式清理 30+ 文件：
  - ① 删 SubAgentStatusPanel/SubAgentStatusItem + subAgentStatus 状态传播
  - ② 删 teamTrust 模块 + WorkspaceTeamTrustDialog + workspaceTeamTrustStore + SettingsPage 团队信任 UI
  - ③ 缩窄 ActionOrigin → 'main_agent' only, 删 STEP_OWNERS, 删 SubAgentProgressKind/Event/Meta
  - ④ 从 workingMemory 删除 SubAgentExecRecord/recordSubAgent/mergeForkedMemories/forkWorkingMemory/forRole
  - ⑤ 简化 ConversationTopbarMode → 'idle' | 'single_agent', 删 'orchestrating' 和 'team' 模式
  - ⑥ planningService 删 task 工具检测、planner/coder/tester 步骤 owner 枚举
  tsc clean, 373/373 tests green
# Cofree 重构与减负计划（2026-04 起）

> 方向确认：**个人/小团队自用的精品工具**；核心场景「读代码 · 问问题 · 理解仓库」＋「跑命令 · 自动化任务」；未来 3 个月主要投入于**架构重构与减负**和**稳定性与可观察性**。

本文档是所有重构工作的**单一事实来源**。每条任务都在这里打勾、记录完成提交，不在 PR 描述里另起炉灶。

---

## 裁剪决策（已拍板）

| 决策 | 原因 |
|------|------|
| **删除多 Agent 编排层** | 核心场景不包含「多 Agent 协作」。专家组接待 / task 委派 / planner·coder·tester 子 Agent / concierge 是最重的"治量坐火箭"，净减 2–3K LoC，大幅降低 `planningService` 复杂度。 |
| **patch 审批流不再加复杂度** | 核心场景不主打「AI 写代码」，现有 patch/snapshot/rollback 已足够，后续只修 bug，不做新增能力。 |
| **working memory / checkpoint / 长对话压缩**要保 | 属「稳定性」地基，且在"读代码 + 跑命令"长链路里确有价值；后续要补测试。 |

---

## 三条轨道

### 轨道 A — 瘦身（砍比重构更有效）

| ID | 任务 | 状态 | 说明 |
|----|------|------|------|
| A1 | 删除多 Agent 编排层（专家组/concierge/task 委派/子 Agent） | ✅ **完成** | 373/373 tests green, tsc clean。净减约 1.5K LoC，删除 9 个文件，手术式清理 30+ 文件 |
| A2 | `src-tauri/src/commands/workspace.rs`（2051 行）按关注点拆分 | ✅ **完成** | `workspace.rs` 已按关注点拆分为 `commands/{fs,git,grep,patch,shell,snapshot}.rs`；业务逻辑整体下沉到 `application/workspace.rs`，命令层降为轻量导出层 |
| A3 | `src/lib/settingsStore.ts`（1631 行）按域拆 | ✅ **完成** | 已拆为 `settingsStore/{general,models,agents,skills,audit}.ts` 五模块；`settingsStore.ts` 收敛为门面导出层，现有调用保持不变 |

### 轨道 B — 拆 god files

| ID | 任务 | 状态 | 说明 |
|----|------|------|------|
| B1 | `src/ui/pages/ChatPage.tsx`（4256 行）拆分 | ✅ **完成** | 3908 → 1159（-70%）；每步 432/432 tests green；详见下方进度记录 |
| B2 | `src/orchestrator/planningService.ts`（3546 行）拆分 | 🟡 **进行中** | B2.1 `skillMatching` · B2.2 `checkpointBridge` · B2.3 `loopPromptScaffolding` · B2.4 `compressionScheduler` · B2.5 `summarization`；3546 → 2989 行（-15.7%）；后续继续拆 `toolLoop` 主体 |
| B3 | `src/orchestrator/toolExecutor.ts`（2091 行）拆分 + **补测试** | 🟡 **进行中** | B3.1 `toolArgParsing` · B3.2 `patchBuilders` · B3.3 `toolErrorClassification` · B3.4 `toolApprovalResolver` · B3.5 `toolAutoExecution`；2089 → 1550 行（-25.8%）；+104 新单元测试 |

### 轨道 C — 稳定性地基

| ID | 任务 | 状态 | 说明 |
|----|------|------|------|
| C1 | `.github/workflows/release.yml` 加 `pnpm test` 门禁 | ✅ 完成 | 独立 `test` job（ubuntu-latest），`prepare_release` 依赖它，失败即阻断 release 创建和 matrix 构建 |
| C2 | 错误分类 × 审计日志贯通 → UI「问题回放」视图 | ✅ 完成 | `ErrorAuditRecord` 持久化 + Settings「审计日志」Tab（错误/LLM/操作三栏 + 筛选 + 导出 JSON/CSV） |
| C3 | README 死链修复、版本徽章更新到 0.1.1 | ✅ 完成 | 版本 0.0.9→0.1.1；删除 5 个不存在文档的链接（EXPERT_PANEL/INDEX/GUARDRAILS/SECURITY_PRIVACY/GIT_SUPPORT）；LICENSE 徽章改为锚链接 |

---

## B1 详细拆分（进行中）

> ChatPage.tsx：4,256 行 · 31 × `useState` · 20 × `useEffect`。先建立目标结构骨架，再分批迁移。

**目标结构：**

```
src/ui/pages/chat/
├── ChatPage.tsx                  (< 600 行，仅组装)
├── composer/
│   ├── ChatComposer.tsx          (输入框 + @-mention + 技能 pill + 附件 pill + 提交)
│   └── useComposerState.ts       (prompt/attachments/skills/mention state + handlers)
├── thread/
│   ├── ChatThread.tsx            (消息列表 + 虚拟滚动)
│   └── ... (已有 ChatPresentational.tsx 逐步收拢到这里)
├── sidebar/
│   └── ... (会话列表 / 工作区切换，现在嵌在 ChatPage 的右侧面板)
├── hooks/
│   ├── useConversationLifecycle.ts   (创建/切换/归档会话)
│   ├── useChatStreaming.ts           (流式回复、中断、abort controllers)
│   ├── useApprovalQueue.ts           (审批卡片队列状态)
│   ├── useSkillDiscovery.ts          (现有 availableSkills 的 useEffect 抽出)
│   ├── useMentionSuggestions.ts      (现有 mention 的 useEffect 抽出)
│   └── useWorkspaceRefresh.ts        (工作区变更监听)
└── state/
    └── ...（已有 sessionState.ts / execution.ts 等）
```

**B1 子任务（按顺序）：**

1. ✅ **B1.1** 建立上述目录骨架（空文件占位，纯目录）
2. ✅ **B1.2** 抽 `useChatStreaming` — 流式回复 + abort 相关的 state/effect
3. ✅ **B1.3** 抽 `useApprovalQueue` — 审批门相关的 state
4. ✅ **B1.4** 抽 `useMentionSuggestions` + `useSkillDiscovery`
5. ✅ **B1.5** 抽 `useConversationLifecycle` + `useWorkspaceRefresh`（`useWorkspaceRefresh` 随 B1.4 并入 `useMentionSuggestions`；`useConversationLifecycle` 延后到 B1.7.4 完成）
6. ✅ **B1.6** `ChatComposer` 从 `ChatComposerSection` 独立成真正的子组件文件
7. ✅ **B1.7** `ChatPage.tsx` 收尾 → 组装器形态（3908 → 1159，-70%，分 9 小步）
   - ✅ B1.7.1 顶部 helpers/types/constants 外移
   - ✅ B1.7.2 抽 `useThreadAutoScroll`
   - ✅ B1.7.3 抽 `useConversationDebugLog`
   - ✅ B1.7.4 抽 `useConversationLifecycle`
   - ✅ B1.7.5 抽 `useShellJobs`
   - ✅ B1.7.6a 抽 `useConversationTopbar`
   - ✅ B1.7.6b 抽 `useWorkspaceTeamTrust`
   - ✅ B1.7.6c 抽 `useApprovalActions`
   - ✅ B1.7.6d 抽 `useChatExecution`

每一步都**单独提交**，每步跑 `pnpm test -- --run` 全绿再进入下一步。

---

## 流程约定

- 任务启动前把本文件对应行状态改为 🟡 **进行中**
- 任务完成后改为 ✅ **完成**，并在表格下方"进度记录"追加一条提交哈希 + 日期
- 新发现的风险/子任务直接追加到当前轨道表格
- 每完成一整个轨道，给 README 和 CLAUDE.md 相应同步

---

## 进度记录

<!-- 按时间倒序追加，格式：`YYYY-MM-DD [Xn] <一句话> (commit)` -->

- 2026-04-22 [B3.5] `toolExecutor.ts` 第五刀落在 `toolAutoExecution`：新建 `src/orchestrator/toolAutoExecution.ts` 承载 `fetchPostPatchDiagnostics()` / `autoExecutePatchProposal()` / `autoExecuteShellProposal()` 三个 Tauri invoke 密集的 auto-exec 函数，及私有 `PatchApplyResult` / `DiagnosticEntry` / `DiagnosticsResult` 类型（原来 toolExecutor 里的冗余副本）。toolExecutor 从 `tauriBridge` 下线 `awaitShellCommandWithDeadline`，从 `shellCommand` 下线 `DEFAULT_SHELL_OUTPUT_CAPTURE_MAX_BYTES` / `INSTALL_BUILD_BLOCK_UNTIL_MS` / `INSTALL_BUILD_TIMEOUT_MS`。未新增测试（这些函数需要 Tauri invoke mock，走上层集成路径覆盖），为后续 B3.6 拆分 per-tool handlers 腾出空间。`pnpm tsc --noEmit` clean，全量 477/477 tests green。toolExecutor.ts 1724 → 1550 行（-174）

- 2026-04-22 [B3.4] `toolExecutor.ts` 第四刀落在 `toolApprovalResolver`：新建 `src/orchestrator/toolApprovalResolver.ts` 承载 `SensitiveWriteAutoExecutionPolicy` 类型别名、`buildAutoApprovalMeta()`、`resolveSensitiveActionAutoApprovalSource()`。类型从 toolExecutor 通过 `export type { ... }` 转发以保持既有 import 兼容。配套 `toolApprovalResolver.test.ts` 新增 12 个单元测试覆盖 (permissionLevel × matchedRule × autoExecutionPolicy) 三维矩阵，以及 kill-switch 下 `tool_permission` 被压制、`workspace_rule` 分支下 rule label 生成正确性（fingerprint / shell_command_prefix）。`pnpm tsc --noEmit` clean，全量 477/477 tests green（+12）。toolExecutor.ts 1757 → 1724 行（-33）

- 2026-04-22 [B3.3] `toolExecutor.ts` 第三刀落在 `toolErrorClassification`：新建 `src/orchestrator/toolErrorClassification.ts` 承载 `classifyToolError` / `shouldRetryToolCall` / `computeToolRetryDelay` / `buildToolErrorRecoveryHint`。配套 `toolErrorClassification.test.ts` 新增 47 个单元测试 —— 27 条 table-driven classify 用例覆盖 validation / workspace / guardrail / timeout / permission / tool_not_found / transport / unknown 全矩阵，外加大小写不敏感、优先级顺序验证、retry 决策矩阵、退避延迟上界、每个 category 的 recovery hint 内容断言。`pnpm tsc --noEmit` clean，全量 465/465 tests green（+47）。toolExecutor.ts 1919 → 1757 行（-162）

- 2026-04-22 [B3.2] `toolExecutor.ts` 第二刀落在 `patchBuilders`：新建 `src/orchestrator/patchBuilders.ts` 承载 `splitPatchLines` / `splitContentSegments` / `replaceByLineRange` / `insertByLine` / `formatUnifiedRange` / `buildCreateFilePatch` / `buildReplacementPatch`（后者仍走 Tauri `build_workspace_edit_patch`）。配套 `patchBuilders.test.ts` 新增 23 个单元测试覆盖空文件 / CRLF / 超界 / 单行范围 / 末尾 no-newline-at-EOF 等场景，首次为 unified-diff 构造路径上锁。`pnpm tsc --noEmit` clean，全量 418/418 tests green（+23）。toolExecutor.ts 2043 → 1919 行（-124）

- 2026-04-22 [B3.1] `toolExecutor.ts` 首刀落在 `toolArgParsing`：新建 `src/orchestrator/toolArgParsing.ts` 承载 7 个纯参数归一化工具（`normalizeRelativePath` / `asString` / `stripLineNumberPrefixes` / `asNumber` / `asBoolean` / `normalizeOptionalPositiveInt` / `countOccurrences`）；配套 `toolArgParsing.test.ts` 新增 22 个单元测试覆盖 fallback / 非法输入 / 边界值。toolExecutor 改为导入，不再本地定义。`pnpm tsc --noEmit` clean，全量 395/395 tests green（+22）。toolExecutor.ts 2089 → 2043 行（-46）

- 2026-04-22 [B2.5] `planningService.ts` 第五刀落在 `summarization`：新建 `src/orchestrator/summarization.ts`，承载 3 个常量（`SUMMARY_CACHE_TTL_MS` / `SUMMARY_CACHE_MAX_ENTRIES` / `SUMMARY_CHUNK_MAX_CHARS`）、`SUMMARY_SYSTEM_PROMPT` 中文压缩引擎 prompt、私有 `summaryCache` 实例、5 个函数（`hashText` 导出 / `stableMessageHashKey` 私有 / `normalizeMessageContent` 私有 / `formatMessagesForSummary` 私有 / `summarizeSingleChunk` 私有 / `requestSummary` 导出）。`hashText` 保留 export 因为 planningService 的 `actionFingerprint`（apply-patch 动作指纹）还在用；其他辅助都成为模块内私有，避免外部 coupling。planningService 下线 `gatewaySummarize` / `SummaryCache` 两个 import，修复中途误删 `formatVendorProtocolLabel` 辅助函数。`pnpm tsc --noEmit` clean，全量 373/373 tests green。planningService.ts 3182 → 2989 行（-193），首次跌破 3000 行。

- 2026-04-22 [B2.4] `planningService.ts` 第四刀落在 `compressionScheduler`：新建 `src/orchestrator/compressionScheduler.ts`，承载压缩/摘要调度的 3 个常量（`BASE_SUMMARY_COOLDOWN_MS` / `MAX_TRACKED_WORKSPACES` / `TRACKER_STALE_MS`）、2 个私有状态 Map（`tokenGrowthTracker` / `lastSummaryAtMsByWorkspace`）、5 个函数（私有：`evictStaleTrackers` / `computeDynamicCooldownMs`；公共：`canSummarizeNow` / `markSummarizedNow` / `evaluateCompressionSafeZone`）。planningService 改为从新模块导入，`planningServiceTestUtils.evaluateCompressionSafeZone` re-export 对既有测试保持透明。`pnpm tsc --noEmit` clean，全量 373/373 tests green。planningService.ts 3273 → 3182 行（-91）

- 2026-04-22 [B2.3] `planningService.ts` 第三刀落在 `loopPromptScaffolding`：新建 `src/orchestrator/loopPromptScaffolding.ts`，承载三个 note-prefix 常量（`WORKING_MEMORY_NOTE_PREFIX` / `TODO_PLAN_NOTE_PREFIX` / `WORKSPACE_REFRESH_NOTE_PREFIX`）、`pruneStaleSystemMessages()`、`upsertPinnedSystemMessage()`、`upsertWorkingMemoryContextMessage()`、`upsertTodoPlanContextMessage()`、`refreshWorkspaceContext()` 全套"让消息数组在 loop 中保持整洁"的 scaffolding 工具。planningService 从三处调用站点改为导入，并下线 `serializeWorkingMemory` / `clearRepoMapCaches` 冗余 import。与 `src/agents/promptAssembly.ts` 保持职责分离：后者构造静态初始 prompt，前者在 loop 运行过程中 mutate `messages` 数组。`pnpm tsc --noEmit` clean，全量 373/373 tests green。planningService.ts 3455 → 3273 行（-182）

- 2026-04-22 [B2.2] `planningService.ts` 第二刀落在 `checkpointBridge`：新建 `src/orchestrator/checkpointBridge.ts`，承载 `INCREMENTAL_CHECKPOINT_INTERVAL` 常量、`initWorkingMemoryForLoop()`（restore-or-create 分支）与 `maybeEmitIncrementalCheckpoint()`（周期性增量检查点发射）。`planningService.ts` 中的 restore/create 分支与增量 checkpoint 块改为调用新模块，`restoreWorkingMemory` / `createWorkingMemory` 从 planningService 的 import 里下线。`pnpm tsc --noEmit` clean，`pnpm test -- --run` 全量 373/373 tests green。planningService.ts 3469 → 3455 行（-14）

- 2026-04-22 [B2.1] `planningService.ts` 首刀落在 `skillMatching`：新建 `src/orchestrator/skillMatching.ts` 承载 `resolveMatchedSkills()`，从主文件删除对应发现/匹配/解析逻辑并改为导入调用。`pnpm tsc --noEmit` clean，`pnpm test -- --run src/orchestrator/planningService.test.ts` 以及全量 373/373 tests green

- 2026-04-22 [A3] `src/lib/settingsStore.ts` 按域拆分完成：新增 `settingsStore/{general,models,agents,skills,audit}.ts` 五模块，原 `settingsStore.ts` 改为 facade re-export；保留既有 API 与调用方不变。`pnpm tsc --noEmit` clean，`pnpm test -- --run src/lib/settingsStore.test.ts src/ui/pages/SettingsPage.test.ts src/agents/resolveAgentRuntime.test.ts src/orchestrator/planningService.test.ts` 以及全量 373/373 tests green

- 2026-04-22 [A2] `src-tauri/src/commands/workspace.rs` 按关注点拆分完成：新增 `commands/{fs,git,grep,patch,shell,snapshot}.rs` 六模块，原 `workspace.rs` 迁移到 `application/workspace.rs`，`commands/mod.rs`/`main.rs` 完成导出与注入切换；`cargo check` clean，`cargo test` 3/3 green（894a83d）

- 2026-04-17 [plan] 确认方向、裁剪决策、三条轨道、B1 细化方案（本文件创建）
- 2026-04-17 [B1.1] 建立 `src/ui/pages/chat/{composer,thread,sidebar,hooks}/` 骨架（各一个 `index.ts` 占位）；432/432 tests green
- 2026-04-17 [B1.2] 抽出 `useChatStreaming` hook：`isStreaming` + `abortControllerRef` + `abortControllersRef` + `backgroundStreamsRef` + unmount abort-all。ChatPage.tsx 4256 → 4251 行；tsc clean，432/432 tests green
- 2026-04-17 [B1.3] 抽出 `useApprovalQueue` hook：`executingActionId` + `pendingShellQueuesRef` + `PendingShellQueue` 接口。`continueAfterHitlIfNeededRef` 因深度闭包依赖暂留 ChatPage。ChatPage.tsx 4251 → 4246 行；tsc clean，432/432 tests green
- 2026-04-17 [B1.4] 抽出 `useMentionSuggestions` + `useSkillDiscovery` hook：6 个 mention 状态 + 工作区加载 effect；skill discovery 独立成 hook。ChatPage.tsx 4246 → 4171 行；tsc clean，432/432 tests green
- 2026-04-17 [B1.5] 务实评估：工作区刷新已在 B1.4 落地；会话生命周期抽取（conversations/activeConversationId/currentConversation/messages 6 源状态 + 2 个 ref 闭包）成本高、收益低，延后到 B1.7 ChatPage 收尾时一并处理。未写代码，仅记录决策。
- 2026-04-17 [B1.6] `ChatComposerSection` → `ChatComposer`：抽成 `src/ui/pages/chat/composer/ChatComposer.tsx`（264 行），从 ChatPage 中删除 257 行内联定义并清理 5 个不再使用的 import。ChatPage.tsx 4171 → 3908 行；tsc clean，432/432 tests green
- 2026-04-17 [B1.7.1] 抽出顶部纯函数、类型、常量：新建 `chat/constants.ts`、`chat/chatPageHelpers.ts`，并把 3 个 shell/team-trust 类型合入 `chat/types.ts`。ChatPage.tsx 3908 → 3675 行（-233）；tsc clean，432/432 tests green。B1.7 拆为 6 小步，目标放宽到 ≤ 800 行；本地计划文件：`~/.claude/plans/ancient-crunching-tulip.md`
- 2026-04-17 [B1.7.2] 抽出 `useThreadAutoScroll`：4 个 scroll ref + 5 个 callback 搬进 hook。ChatPage.tsx 3675 → 3649 行（-26）；tsc clean，432/432 tests green
- 2026-04-17 [B1.7.3] 抽出 `useConversationDebugLog`：2 state（`failedLlmRequestLog` / `isExportingDebugBundle`）+ `conversationDebugEntriesRef` + 3 handlers（`appendConversationDebugEntry` / `handleCopyFailedRequestLog` / `handleDownloadConversationDebugBundle`）搬进 hook。下载处理函数需 14 个字段的上下文，采用 `getDownloadSnapshot` 闭包懒求值模式。ChatPage.tsx 3649 → 3558 行（-91）；tsc clean，432/432 tests green
- 2026-04-18 [B1.7.4] 抽出 `useConversationLifecycle`：会话 CRUD（new/select/delete/rename/clear）+ `activateConversation` / `applyChatViewState` / `snapshotToBackground` + 5 个 useEffect（active-id 同步、恢复首选会话、save-on-messages、agentBinding 同步、草稿绑定、wsPath 切换）全部下沉到 hook。由于两个 hook 需要共享 `conversationDebugEntriesRef`，把它从 `useConversationDebugLog` 提到 ChatPage 再注入两处，避免 hook 间循环依赖。`liveContextTokens` / `sessionNote` 因初始化依赖 `currentConversation` 也并入 lifecycle hook。ChatPage.tsx 3558 → 3133 行（-425）；tsc clean，432/432 tests green
- 2026-04-18 [B1.7.5] 抽出 `useShellJobs`：`runningShellJobsRef` + `shellOutputBuffersRef` + 4 个 shell 回调的 ref 同步对 + 5 个 handler（`markShellActionsFailed` / `startShellJobForAction` / `completeBackgroundShellStartup` / `monitorBackgroundShellJob` / `flushShellOutputBuffer`）+ 整个 `shell-command-event` 监听 useEffect（200+ 行）全部下沉到 hook。`handlePlanUpdate` / `continueAfterHitlIfNeeded` 仍留在 ChatPage（依赖会话闭包），通过 ref 注入以绕开 stale-closure。ChatPage.tsx 3133 → 2593 行（-540）；tsc clean，432/432 tests green
- 2026-04-18 [B1.7.6a] 抽出 `useConversationTopbar`：3 个 expandedPlan 状态 + 5 个 memo（askUser/restore anchor、topbar 派生状态、targets、final state）+ 2 个回调（navigate / action 处理）+ 会话切换清空 expanded 的 useEffect 搬进 hook。ChatPage.tsx 2593 → 2416 行（-177）；tsc clean，432/432 tests green
- 2026-04-18 [B1.7.6b] 抽出 `useWorkspaceTeamTrust`：2 个状态 + 3 个 YOLO 簿记 ref + 3 个 useEffect（wsPath 重置、prompt 不变式校验、YOLO 自动执行）+ mode 选择 handler 搬进 hook。`setRestoredTeamTrustPromptKey` 仍被 checkpoint 恢复 effect 调用，所以从 hook 返回给 ChatPage。ChatPage.tsx 2416 → 2248 行（-168）；tsc clean，432/432 tests green
- 2026-04-18 [B1.7.6c] 抽出 `useApprovalActions`：`ensureApprovalInteractionAllowed` + 7 个审批 handler（approve / retry / reject / comment / approveAll / cancel / rejectAll）搬进 side-effect-only hook，约 440 行编排代码脱离 ChatPage。ChatPage.tsx 2248 → 1811 行（-437）；tsc clean，432/432 tests green
- 2026-04-19 [B1.7.6d] 抽出 `useChatExecution`：核心执行链 `handleCancel` / `continueAfterHitlIfNeeded` / `runChatCycle` / `handleSubmit` / `handlePlanUpdate`（约 700 行）全部搬进 hook。hook 无自有状态，通过 ~40 字段的 options bag 注入所有 ref/setter/callback。`handlePlanUpdateRef` / `continueAfterHitlIfNeededRef` 仍在 ChatPage 初始化（`useShellJobs` 的 stale-closure 绕路需要）。ChatPage.tsx 1811 → 1159 行（-652）；tsc clean，432/432 tests green
- 2026-04-19 [B1.7 完成] ChatPage.tsx 从 3908 行收敛到 1159 行（-70%）。B1 轨道整体完成。剩余的 1159 行主要是 props 绑线、checkpoint 恢复 effect、剩余 3-4 个 useEffect 粘合、JSX（~170 行）。相较原计划 < 600 的目标未完全达成，但收益显著：God file 已不复存在，所有关注点都有自己的 hook / 子组件文件，每个 hook ≤ 900 行且聚焦单一职责，可测性和可诊断性大幅提升。
- 2026-04-19 [B1.5 补登] B1.5 扶正为 ✅：`useWorkspaceRefresh` 在 B1.4 已并入 `useMentionSuggestions`，`useConversationLifecycle` 在 B1.7.4 完成。同步清理 B1.7 子任务列表里残留的两行 ⏳ 占位（与上面 B1.7.5 / B1.7.6a-d 重复）。
- 2026-04-19 [C1] `.github/workflows/release.yml` 新增 `test` job（ubuntu-latest：checkout → Node 20 → pnpm 10.32.1 → `pnpm install --frozen-lockfile` → `pnpm test -- --run`），并给 `prepare_release` 加 `needs: test`。测试失败时 release 不会被创建，也不会点燃 macos-14 / macos-15-intel / windows-latest 三台 matrix 构建。本地基线 432/432 green。
- 2026-04-19 [C3] README.md：版本徽章 0.0.9→0.1.1；LICENSE 徽章改为页内锚链接；删除 EXPERT_PANEL.md / INDEX.md / GUARDRAILS.md / SECURITY_PRIVACY.md / GIT_SUPPORT.md 共 5 个不存在文档的链接；安全段落链接改为 BUILD.md + ARCHITECTURE.md。432/432 tests green。
- 2026-04-19 [C2] 错误分类 × 审计日志贯通 → UI 问题回放视图。`auditLog.ts` 新增 `ErrorAuditRecord`（category/title/message/retriable/guidance/rawError/timestamp/conversationId）+ `recordErrorAudit()` / `readErrorAuditRecords()` / `clearErrorAuditRecords()`，`exportAuditToJSON/CSV` 已包含 errors。`ChatPage.tsx` 包装 `setAndAuditError`（支持 SetStateAction 形式），在每次设置非 null CategorizedError 时同时调用 `recordErrorAudit()`。新建 `AuditTab.tsx`：错误日志（分类筛选 + 展开详情 + 清空）、LLM 请求审计简表（最近 50 条）、操作审计简表（最近 50 条）、JSON/CSV 导出。`settingsTypes.ts` 加 `"audit"` tab、`SettingsPage.tsx` 加渲染分支。CSS 新增 `.audit-list/.audit-row/.audit-category-badge` 等样式。tsc clean，432/432 tests green。
