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
| B1 | `src/ui/pages/ChatPage.tsx`（4256 行）拆分 | 🟡 **进行中 → B1.2** | 按 composer / thread / sidebar / 状态 hooks 切分；31 个 useState 至少一半迁到 custom hook |
| B2 | `src/orchestrator/planningService.ts`（3546 行）拆分 | ⏳ 待启动 | 抽出 `promptAssembly` / `toolLoop` / `skillMatching` / `checkpointBridge` |
| B3 | `src/orchestrator/toolExecutor.ts`（2091 行）拆分 + **补测试** | ⏳ 待启动 | 当前 0 覆盖，是最大单点风险 |

### 轨道 C — 稳定性地基

| ID | 任务 | 状态 | 说明 |
|----|------|------|------|
| C1 | `.github/workflows/release.yml` 加 `pnpm test` 门禁 | ⏳ 待启动 | 今天就能做；改动最小、收益最大 |
| C2 | 错误分类 × 审计日志贯通 → UI「问题回放」视图 | ⏳ 待启动 | `errorClassifier.ts` + `auditLog.ts` 串起来 |
| C3 | README 死链修复、版本徽章更新到 0.1.1 | ⏳ 待启动 | 对"精品感"重要 |

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
4. **B1.4** 抽 `useMentionSuggestions` + `useSkillDiscovery`
5. **B1.5** 抽 `useConversationLifecycle` + `useWorkspaceRefresh`
6. **B1.6** `ChatComposer` 从 `ChatComposerSection` 独立成真正的子组件文件
7. **B1.7** `ChatPage.tsx` 收尾 → 组装器形态，目标 < 600 行

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
