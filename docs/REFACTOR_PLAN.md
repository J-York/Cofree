# Cofree UI 精简计划（2026-04-22 起）

> 背景：2026-04 完成的大重构（A1 多 Agent 编排层删除 / B1-B3 god file 拆分 / A2-A3 workspace 与 settings 按域拆分）移除了功能，但没有完全清理**视觉上的疤痕**。本轮聚焦"删掉已经不存在概念在 UI 上的残影"。

本文档是当前重构工作的**单一事实来源**。每条任务完成后在这里打勾、记录提交哈希。

---

## 方向

> **只剪死重，不动核心交互。** Composer / Thread / Sidebar / 审批卡片视觉层级都不在本轮范围——那些要等真实使用反馈驱动，不是代码结构臆测。

---

## 轨道 D — UI 精简（手术式）

### 🟢 明确执行（纯死重）

| ID | 任务 | 状态 | 说明 |
|----|------|------|------|
| D1 | 删除 `ActionOrigin` 单值 union + 关联 UI | ⏳ | `src/orchestrator/types.ts` 的 `ActionOrigin = "main_agent"` 单值类型、`planGuards.ts` 的 origin 校验、`ChatPresentational.tsx` 的 `formatActionOrigin()` / `ActionOriginMeta` 组件。UI 影响：每条 action 卡片上那个"main_agent"meta 标签消失。预计 -40 行 |
| D2 | 删除 plan step 的 `owner` 字段 | ⏳ | `todoPlanState.ts` 默认值 `"planner"`、`toolRegistry.ts` owner enum `["planner"]`、`planGuards.ts` 的 owner 校验、`ChatPresentational.tsx:1018` 的 `<span>{step.owner}</span>` 渲染。UI 影响：plan 面板每个步骤不再显示"planner"字样。预计 -30 行 |
| D3 | 重命名 `ConversationTopbarMode` | ⏳ | `conversationTopbarState.ts` 的 `"idle" \| "single_agent"` 中的 `"single_agent"` 暗示存在其它模式，是纯语义遗迹。重命名为 `"active"` 或直接收敛为布尔 `isIdle`。用户不可见，内部类型清洁 |

**小计**：预计 ~1.5 小时，-70 ~ -100 行。

### 🟡 暂缓（结构上可以再瘦，但纯为减行数不划算）

| ID | 任务 | 状态 | 暂缓理由 |
|----|------|------|---------|
| D4 | `ChatPage.tsx` 剩余 518 行 return block + 7 个 useEffect 再拆 | ⏸ | 现在 1107 行已是"组装器"形态，不是 god file。再切可能引入无用抽象层。**等下一次真改 ChatPage 功能时顺手做** |
| D5 | `SettingsPage` 默认 tab 调整 | ⏸ | 只有一个内置 Agent 的情况下，从 `"agents"` 改成 `"models"` 或 `"general"` 作为落脚点更合理。但属于口味问题，没有硬证据支撑 |

### 🔴 明确不做（等真实使用信号）

以下视觉层需要**使用反馈驱动**，不在本轮范围：

- Composer（@-mention / skill pill / attachments pill / 提交按钮）
- Thread / 消息气泡 / 工具调用折叠 / 审批卡片视觉层级
- Sidebar（会话列表 / 工作区切换）
- `agentBinding` per-conversation 概念（虽然内置 Agent 只剩一个，但用户可派生自定义 Agent 并绑到会话上，概念仍成立）

---

## 流程约定

- 任务启动前把对应行状态改为 🟡 **进行中**
- 任务完成后改为 ✅ **完成**，并在本文件下方"进度记录"追加一条：`YYYY-MM-DD [Dn] <一句话> (commit)`
- 每步跑 `pnpm tsc --noEmit` + `pnpm test -- --run` 全绿再进入下一步
- D1-D3 都是纯删除，不应改变任何测试断言；如果测试需要改，说明有依赖没理清，停下来先讨论
- 本轮（D1-D3）全部完成后，README `.docs/PRD.md` 若涉及旧概念也要同步清理

---

## 进度记录

<!-- 按时间倒序追加，格式：`YYYY-MM-DD [Dn] <一句话> (commit)` -->

- 2026-04-22 [plan] 本文件创建，承接 A1-C3 完成后的 UI 精简计划
