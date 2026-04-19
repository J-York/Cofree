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
| A1 | 删除多 Agent 编排层（专家组/concierge/task 委派/子 Agent） | ⏳ 待启动 | 评估 → 分批删除；要触及 `builtinChatAgents.ts` / `resolveAgentRuntime.ts` / `explicitContextService.ts` / `hitlContinuationMachine.ts` / `planningService` 中相关分支 |
| A2 | `src-tauri/src/commands/workspace.rs`（2051 行）按关注点拆分 | ⏳ 待启动 | 拆为 `commands/{fs,git,grep,patch,shell,snapshot}.rs`；业务逻辑下沉到 `application/` |
| A3 | `src/lib/settingsStore.ts`（1631 行）按域拆 | ⏳ 待启动 | general / models / agents / skills / audit |

### 轨道 B — 拆 god files

| ID | 任务 | 状态 | 说明 |
|----|------|------|------|
| B1 | `src/ui/pages/ChatPage.tsx`（4256 行）拆分 | ✅ **完成** | 3908 → 1159（-70%）；每步 432/432 tests green；详见下方进度记录 |
| B2 | `src/orchestrator/planningService.ts`（3546 行）拆分 | ⏳ 待启动 | 抽出 `promptAssembly` / `toolLoop` / `skillMatching` / `checkpointBridge` |
| B3 | `src/orchestrator/toolExecutor.ts`（2091 行）拆分 + **补测试** | ⏳ 待启动 | 当前 0 覆盖，是最大单点风险 |

### 轨道 C — 稳定性地基

| ID | 任务 | 状态 | 说明 |
|----|------|------|------|
| C1 | `.github/workflows/release.yml` 加 `pnpm test` 门禁 | ✅ 完成 | 独立 `test` job（ubuntu-latest），`prepare_release` 依赖它，失败即阻断 release 创建和 matrix 构建 |
| C2 | 错误分类 × 审计日志贯通 → UI「问题回放」视图 | ⏳ 待启动 | `errorClassifier.ts` + `auditLog.ts` 串起来 |
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
