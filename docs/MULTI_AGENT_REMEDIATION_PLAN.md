# Cofree 多 Agent 调度链路整改方案

本文档是针对 `Cofree` 当前多 Agent 调度链路的工程整改提案，用于实施、排期和进度追踪。

说明：
- 这是一份整改方案，不代表当前实现状态。
- 当前状态仍以 `docs/ARCHITECTURE.md`、`docs/IMPLEMENTATION_STATUS.md` 和代码实现为准。
- 本文档聚焦多 Agent 之间的权限边界、结果协议、恢复能力和测试覆盖。

## 1. 背景

基于本轮代码审查，当前多 Agent 链路的主问题不在“有没有多 Agent 能力”，而在于 Agent 与 Agent 之间的协议没有闭环，主要表现为：

- 顶层 Agent 的角色白名单可以被 `task(team=...)` 间接绕过。
- 子 Agent / Team 的结果向父编排器回传时存在有损压缩。
- 子 Agent 失败可能被父循环误判为成功。
- 子 Agent 继承自动审批后，可能直接产生真实副作用，但父层不可见或不可审计。
- checkpoint 仅恢复 `plan/toolTrace`，不能无损恢复多 Agent 的共享上下文。
- Team 执行器的并行异常、配置语义和结果聚合仍不完整。

这些问题会直接影响：

- 权限边界是否可信。
- 审批链路是否完整。
- 自动续跑是否可靠。
- 并发执行是否安全。
- 故障是否可恢复、可追踪、可回归验证。

## 2. 整改目标

本次整改目标分为 5 类：

1. 建立可信的委派边界，确保顶层 Agent 的授权在 team 和 sub-agent 路径上都成立。
2. 建立无损的父子 Agent 结果协议，让动作、反馈、结构化输出和失败语义都能正确上传。
3. 收紧副作用治理，避免子 Agent 在父层不可见的情况下直接写工作区或执行命令。
4. 补齐恢复能力，让 HITL、reload、续跑和多 Agent 上下文恢复保持一致。
5. 建立回归测试和里程碑追踪机制，避免同类问题反复出现。

## 3. 非目标

本次整改不建议同时做以下事项：

- 不重写整个 `planningService.ts`。
- 不引入新的分布式 Agent 执行框架。
- 不在本轮扩展新的 Agent 角色或新的 Team 类型。
- 不把现有 prompt 体系整体重构成新的 DSL。

原则是先修正协议和边界，再考虑架构美化。

## 4. 总体策略

建议按以下顺序推进：

1. `P0 止血`：修复已知回归和最危险的权限/审批缺口。
2. `P1 协议收敛`：统一父子 Agent 的结果模型和成功/失败语义。
3. `P1 恢复能力`：补齐 working memory、checkpoint、session scope。
4. `P2 语义补全`：完善 Team 执行器的并行、预算和配置语义。
5. `P2 测试与观测`：把关键交互场景做成回归测试与诊断输出。

不建议一上来做跨文件的大重构。优先让系统重新变得“边界可信、语义一致、可回滚”。

## 5. 工作分解结构

### 5.1 优先级与阶段

| 阶段 | 优先级 | 目标 | 结果 |
|---|---|---|---|
| Phase 0 | P0 | 止血与风险封堵 | 修复现有回归，堵住越权和续跑异常 |
| Phase 1 | P0/P1 | 父子 Agent 协议收敛 | 子 Agent/Team 结果无损上传 |
| Phase 2 | P1 | 副作用治理与审批收口 | 子 Agent 不再绕过父层审批主线 |
| Phase 3 | P1 | 恢复与状态一致性 | checkpoint + working memory + session scope 对齐 |
| Phase 4 | P2 | Team 执行语义补全 | 并行、预算、条件和异常处理完整 |
| Phase 5 | P2 | 测试、观测与发布 | 建立回归保护和验收基线 |

### 5.2 追踪看板

状态约定：
- `TODO`：尚未开始
- `DOING`：进行中
- `BLOCKED`：被依赖项阻塞
- `DONE`：已完成

| ID | 阶段 | 事项 | 牵头文件/模块 | 依赖 | 状态 |
|---|---|---|---|---|---|
| P0-1 | Phase 0 | 修复 blocked fingerprint 在 continuation 中未被抑制的问题 | `src/orchestrator/planningService.ts` | 无 | DONE |
| P0-2 | Phase 0 | 禁止 `task(team=...)` 绕过 `allowedSubAgents` | `src/orchestrator/planningService.ts`, `src/agents/agentTeam.ts` | 无 | DONE |
| P0-3 | Phase 0 | 明确 `handoffPolicy` 的运行时语义并实际生效 | `src/agents/resolveAgentRuntime.ts`, `src/orchestrator/planningService.ts` | P0-2 | DONE |
| P1-1 | Phase 1 | 扩展父子 Agent 结果协议，支持多动作回传 | `src/orchestrator/planningService.ts`, `src/orchestrator/types.ts` | P0-2 | DONE |
| P1-2 | Phase 1 | Team 路径回传 `stageResults/structuredOutput/feedback/toolTrace` | `src/orchestrator/teamExecutor.ts`, `src/orchestrator/planningService.ts` | P1-1 | DONE |
| P1-3 | Phase 1 | 修正 `task` 工具的 success/failure 语义映射 | `src/orchestrator/planningService.ts` | P1-1 | DONE |
| P2-1 | Phase 2 | 子 Agent 写操作统一回父层审批，不直接 auto execute | `src/orchestrator/planningService.ts` | P1-1 | TODO |
| P2-2 | Phase 2 | 为多 Agent 副作用增加串行化或工作区写锁 | `src/orchestrator/planningService.ts`, `src/orchestrator/hitlService.ts` | P2-1 | TODO |
| P3-1 | Phase 3 | checkpoint 持久化 `workingMemory` | `src/orchestrator/checkpointStore.ts`, `src/orchestrator/workingMemory.ts` | P1-1 | TODO |
| P3-2 | Phase 3 | planning loop 从 checkpoint 恢复 `workingMemory` | `src/orchestrator/planningService.ts`, `src/ui/pages/ChatPage.tsx` | P3-1 | TODO |
| P3-3 | Phase 3 | 使用 `buildScopedSessionKey` 对齐 conversation + agent 级 session | `src/orchestrator/checkpointStore.ts`, `src/ui/pages/ChatPage.tsx` | P3-1 | TODO |
| P3-4 | Phase 3 | 明确后台 shell 的可恢复边界并补最小快照 | `src/ui/pages/ChatPage.tsx`, `src/orchestrator/hitlService.ts` | P3-3 | TODO |
| P4-1 | Phase 4 | 让 `sharedWorkingMemory` 与 `maxTotalTurns` 真正生效 | `src/orchestrator/teamExecutor.ts` | P1-1 | TODO |
| P4-2 | Phase 4 | 修复并行 stage reject 未进入最终聚合的问题 | `src/orchestrator/teamExecutor.ts` | 无 | TODO |
| P4-3 | Phase 4 | 补齐 Team 条件、失败策略和 partial 语义 | `src/orchestrator/teamExecutor.ts` | P4-1, P4-2 | TODO |
| P5-1 | Phase 5 | 补回归测试：委派白名单、team 并行、恢复、审批续跑 | `tests/`, `src/**/*.test.ts` | 全部 | TODO |
| P5-2 | Phase 5 | 增加调试输出和审计字段，便于现场定位 | `src/orchestrator/*`, `src/lib/auditLog.ts` | P1-2, P2-1 | TODO |

## 6. 详细实施方案

### 6.1 Phase 0：止血与风险封堵

#### P0-1 修复 continuation 中 blocked fingerprint 失效

现象：
- 已有测试表明，被 block 的 shell 提案在 continuation 过程中仍会重新出现。

实施动作：
- 检查 `buildProposedActions()`、`runPlanningSession()` 和 continuation 输入链路中 `blockedActionFingerprints` 的使用点。
- 确保 blocked fingerprint 的过滤发生在最终动作入 plan 之前，而不是仅在部分路径生效。
- 补充子 Agent 和 Team 路径在 continuation 中的同类过滤。

验收标准：
- 现有失败测试恢复通过。
- continuation 时被 block 的 pending action 不再重新出卡。
- 工具 trace 仍保留，方便诊断“模型提出过动作，但因 block 被抑制”。

#### P0-2 堵住 `task(team=...)` 的越权委派

现象：
- `task.role` 受 `allowedSubAgents` 约束，但 `task.team` 目前没有同步校验 team 内部角色。

实施动作：
- 为 `BUILTIN_TEAMS` 增加运行时校验函数，例如 `isTeamAllowed(team, allowedSubAgents)`。
- 在 `task(team=...)` 执行前，校验 team 的所有 stage 是否都在当前 runtime 的 `allowedSubAgents` 范围内。
- 若不满足，直接返回 validation error，不启动 team。
- 同时在 prompt/runtime context 中只展示当前 Agent 可用的 team，避免模型误用。

验收标准：
- 受限 Agent 无法通过 team 间接调用未授权角色。
- `task(role=...)` 与 `task(team=...)` 的授权语义一致。

#### P0-3 让 `handoffPolicy` 从保留字段变成真实约束

现象：
- `handoffPolicy` 已写入 runtime，但当前没有看到实际执行约束。

实施动作：
- 明确语义：
  - `none`：禁止同轮多 `task` 并发，且禁止 team 委派。
  - `sequential`：允许委派，但父层只能串行执行多个 `task`。
  - `parallel`：允许当前的并发 `task` 和 team 并行 stage。
- 在 `planningService` 的 `taskCalls` 执行分支强制生效。
- 在 team 入口处同步检查该策略。

验收标准：
- `handoffPolicy` 不是仅显示在配置上的“装饰字段”。
- 不同策略下，tool loop 的执行行为可预测、可测试。

### 6.2 Phase 1：父子 Agent 结果协议收敛

#### P1-1 把单动作回传升级为多动作回传

现象：
- 当前 `ToolExecutionResult` 只承载一个 `proposedAction`。
- 子 Agent 产生多个动作时，其余动作直接丢失。

建议改法：
- 在 `ToolExecutionResult` 中新增 `proposedActions?: ActionProposal[]`。
- 保留 `proposedAction` 一段时间做兼容，但父循环优先消费数组字段。
- `processToolResult()` 统一处理 0..N 个动作，并全部关联到 plan step。

配套改动：
- 所有 `propose_*` 工具仍可只返回单动作。
- `task` 和 `team` 路径开始返回多动作数组。

验收标准：
- 子 Agent 提出的多个 patch/shell 动作可以完整出现在父级审批面板。
- 去重、续跑、批量审批和 plan step 绑定都基于完整动作集工作。

#### P1-2 Team 结果不再只回 summary 文本

现象：
- Team 目前只回 `finalReply/status`，缺少 stage 级执行细节。

建议改法：
- 为 team 返回结构增加：
  - `stageResults`
  - `proposedActions`
  - `toolTrace`
  - `structuredOutputs`
  - `feedback`
- 父层将 team 看作“一个复合 task 工具”，但内部结果应可观测。

验收标准：
- UI 或调试导出中可以看到 team 内每个 stage 的状态和关键产出。
- 父编排器能基于 team 的真实结果做后续判断，而不是只看一段 summary。

#### P1-3 修正 `task` 工具的 success/failure 语义

现象：
- `task` 当前固定返回 `success: true`，会误导父循环。

建议改法：
- 建立明确映射：
  - `completed` => `success: true`
  - `partial` => `success: true`，但增加 `completionStatus: "partial"`
  - `need_clarification` => `success: false` 或单独的 `waiting_for_user`/`clarification_needed`
  - `blocked` => `success: false`
  - `failed` => `success: false`
- 父循环的 `turnSuccessCount/turnFailureCount` 基于真实语义统计。

验收标准：
- 子 Agent 失败会正确触发上层失败控制与修复提示。
- 连续失败熔断不再被 delegation 的“假成功”污染。

### 6.3 Phase 2：副作用治理与审批收口

#### P2-1 子 Agent 写操作统一冒泡回父层

现象：
- 子 Agent 继承父层工具权限后，可能直接 auto execute patch/shell。

短期建议：
- 对 sub-agent 运行时增加约束：
  - `propose_file_edit` / `propose_apply_patch` / `propose_shell` 在子 Agent 中永远只生成 proposal，不直接执行。
- 所有真实写入和 shell 执行统一回到父层审批或父层 auto-policy 决策。

中期建议：
- 若后续确实需要子 Agent 自动执行，也必须先经过父层的 action registration、审计记录和串行调度。

验收标准：
- 子 Agent 不再直接对工作区产生父层不可见的副作用。
- 所有副作用都能在父级 plan、audit 和 continuation 中追踪到。

#### P2-2 对多 Agent 写入增加串行化控制

现象：
- 当前 `task` 可并行，子 Agent 之间可能同时提出甚至执行写动作。

建议改法：
- 引入“副作用串行化”原则：
  - 读取可以并发。
  - 写 proposal 可以并发生成。
  - 真正落地执行必须串行。
- 若保留 auto mode，至少增加工作区级写锁或 action queue。

验收标准：
- 不会出现多个子 Agent 对同一工作区同时落地写入的竞态。
- plan/action timeline 与真实执行顺序一致。

### 6.4 Phase 3：恢复与状态一致性

#### P3-1 checkpoint 持久化 `workingMemory`

现象：
- `WorkflowCheckpointPayload` 定义了 `workingMemory`，但保存时未写入。

实施动作：
- `saveWorkflowCheckpoint()` 写入 `snapshotWorkingMemory(memory)`。
- 恢复时读取并校验 `workingMemory` 快照。

验收标准：
- reload/HITL 恢复后，file knowledge、facts、sub-agent history、task progress 保持连续。

#### P3-2 planning loop 能从 checkpoint 恢复 `workingMemory`

现象：
- `planningService` 当前总是 `createWorkingMemory()`，没有恢复入口。

实施动作：
- 为 `runPlanningSession()` 增加可选输入，如 `restoredWorkingMemory`。
- `ChatPage` 在读取 checkpoint 后，不只恢复 `plan/toolTrace`，也传入 `workingMemory`。
- 保证 continuation 和 normal replay 走同一恢复语义。

验收标准：
- 恢复后上下文不再“失忆”，不会重复读取和重复委派。

#### P3-3 session key 对齐 conversation + agent

现象：
- 代码里已有 `buildScopedSessionKey()`，但主链路仍多处直接用 `getChatSessionId()`。

实施动作：
- checkpoint、continuation memory、ask_user session 都改用 scoped session key。
- 至少保证“不同 conversation”与“不同 agent binding”不会共享同一运行态。

验收标准：
- 切换对话或切换 Agent 后，不会混入错误的 checkpoint / continuation memory。

#### P3-4 明确后台 shell 的恢复语义

现象：
- 后台 shell 运行态主要保存在 UI ref，reload 后无法完整恢复监听。

建议两步走：
- 第一阶段：明示“不支持恢复运行中的后台 shell 监听”，恢复后把 action 标记为 `unknown/interrupted`，提示用户手动确认状态。
- 第二阶段：若需要完整恢复，再为后台 job 持久化最小运行快照并重建监听。

验收标准：
- reload 后不再出现“UI 以为还在跑，但实际监听已丢”的假状态。

### 6.5 Phase 4：Team 执行语义补全

#### P4-1 让 `sharedWorkingMemory` 和 `maxTotalTurns` 生效

现象：
- Team 定义层已声明，但执行器未消费。

实施动作：
- 当 `sharedWorkingMemory=false` 时，为 stage 创建隔离 memory，必要时只做只读摘要传递。
- 为 team 引入总 turn budget，避免多个 stage 各自跑满导致预算失控。

验收标准：
- Team 配置字段与真实执行行为一致。

#### P4-2 修复并行 stage reject 未进入最终聚合

现象：
- 并行 stage 抛异常时，失败未进入 `stageResults`，最终 team 状态可能误报。

实施动作：
- 为 rejected stage 写入带 stage label 的失败结果，并进入最终聚合。
- 确保 `aggregateTeamResults()` 始终基于完整 stage 集合工作。

验收标准：
- 任一并行 stage 崩溃都不会被最终状态吞掉。

#### P4-3 补齐条件、失败策略和 partial 语义

实施动作：
- 明确 `if_previous_succeeded`、`if_issues_found` 在 partial/blocked/failed 情况下的行为。
- 明确 `failurePolicy=skip` 的可观察结果。
- Team 最终状态需要能区分：
  - `completed`
  - `partial`
  - `failed`
  - 如有必要，新增 `blocked`

验收标准：
- Team 聚合语义稳定、可预测、可测试。

### 6.6 Phase 5：测试、观测与发布

#### P5-1 补齐回归测试矩阵

至少新增以下测试：

1. 顶层 Agent 对 `task(team=...)` 的角色白名单约束。
2. `handoffPolicy` 对单轮多 `task` 的串行/并行控制。
3. 子 Agent 多动作回传到父 plan。
4. Team stage 结果、动作、反馈、trace 的完整回传。
5. 子 Agent `failed/blocked/need_clarification/partial` 对父层 success/failure 计数的影响。
6. 子 Agent 在 auto 权限下不会直接落地副作用。
7. checkpoint 对 `workingMemory` 的保存与恢复。
8. scoped session key 对 conversation/agent 的隔离。
9. 并行 team stage reject 后的聚合结果。
10. blocked fingerprint 在 normal run 与 continuation 中都能稳定抑制。

#### P5-2 增强调试与审计

建议增加：
- `task` 工具结果中的标准化字段，如 `completionStatus`、`childActionCount`、`childFailureCount`。
- 调试导出中增加 `workingMemory` 摘要和 team stage 明细。
- 审计日志中标记动作来源：
  - `origin=main_agent`
  - `origin=sub_agent`
  - `origin=team_stage`

验收标准：
- 线上出现问题时，可从导出日志定位“是谁提的动作、谁执行的、父层有没有看到”。

## 7. 建议的代码改动边界

建议优先修改以下文件：

- `src/orchestrator/planningService.ts`
- `src/orchestrator/teamExecutor.ts`
- `src/orchestrator/checkpointStore.ts`
- `src/orchestrator/workingMemory.ts`
- `src/orchestrator/hitlService.ts`
- `src/ui/pages/ChatPage.tsx`
- `src/agents/agentTeam.ts`
- `src/agents/resolveAgentRuntime.ts`
- `src/agents/promptAssembly.ts`
- `tests/agentTeam.test.ts`
- `src/orchestrator/planningService.test.ts`

不建议首轮把 UI 大面积改造作为前置条件。先把 orchestrator 协议和测试修正，再增量改善 UI 展示。

## 8. 建议里程碑

### Milestone A：边界可信

范围：
- P0-1
- P0-2
- P0-3

完成定义：
- 已知 blocked fingerprint 回归修复。
- Team 无法越权。
- `handoffPolicy` 有真实行为约束。

### Milestone B：结果可信

范围：
- P1-1
- P1-2
- P1-3
- P2-1

完成定义：
- 子 Agent/Team 的动作、反馈、结构化输出和失败状态都能被父层完整感知。
- 子 Agent 不再直接绕过父层审批主线。

### Milestone C：恢复可信

范围：
- P2-2
- P3-1
- P3-2
- P3-3
- P3-4

完成定义：
- reload/HITL continuation 后的多 Agent 状态与执行边界一致。

### Milestone D：执行语义可信

范围：
- P4-1
- P4-2
- P4-3
- P5-1
- P5-2

完成定义：
- Team 并行与异常语义稳定。
- 关键交互都有回归测试保护。

## 9. 风险与取舍

### 9.1 建议先接受的取舍

- 短期内宁可减少子 Agent 的自动化自由度，也要先保证审批链条完整。
- 短期内宁可把后台 shell 恢复语义降级为“中断待确认”，也不要维持虚假的 running 状态。
- 短期内宁可让 Team 的并行能力保守一些，也不要让异常在聚合中被吞掉。

### 9.2 可能的实施风险

- `planningService.ts` 体量较大，局部修复容易引发连锁回归。
- 如果一口气同时改协议、checkpoint、UI，调试成本会显著上升。
- 若不先补测试，后续继续优化时容易再次打破 continuation/HITL 路径。

## 10. 建议实施顺序

建议按以下节奏推进：

1. 先做 `P0-1/P0-2/P0-3`，把最危险的回归和越权问题堵住。
2. 再做 `P1-1/P1-2/P1-3`，把父子 Agent 结果协议统一。
3. 紧接着做 `P2-1`，收紧副作用入口。
4. 然后做 `P3-*`，补恢复链路。
5. 最后再完成 `P4-*` 和 `P5-*`，把 Team 语义和测试矩阵补齐。

## 11. 进度更新模板

建议每次推进后按下面格式更新本文件：

```md
### YYYY-MM-DD
- 完成：
- 风险：
- 下一步：
- 阻塞项：
```

如果需要周维度跟踪，可再补一个简单表格：

| 日期 | 完成项 | 当前风险 | 下一步 | 负责人 |
|---|---|---|---|---|
| TBD | TBD | TBD | TBD | TBD |

## 12. 当前建议的首批落地项

若只做第一批最值得的修复，建议优先实施：

- `P0-1` 修复 blocked fingerprint 回归。
- `P0-2` 封住 team 越权委派。
- `P1-1` 把子 Agent 多动作完整上传。
- `P1-3` 修正 `task` 工具的 success/failure 语义。
- `P2-1` 禁止子 Agent 直接 auto execute 写操作。
- `P3-1/P3-2` 恢复 `workingMemory` 的 checkpoint 闭环。

这 6 项完成后，系统的安全性、可解释性和可恢复性会先回到一个可控水平。

## 13. 与「专家组」产品能力的排期对齐

「专家组」功能（见 [EXPERT_PANEL.md](./EXPERT_PANEL.md)）依赖可信的 `task` / Team 委派与父子结果回传。与上表对应关系建议如下：

| 专家组能力 | 依赖的整改能力 |
|------------|----------------|
| 接待 Agent 使用 `task(team=...)` | P0-2、P1-2 |
| `handoffPolicy: sequential` 接待 Agent | P0-3 |
| 子阶段动作进入父级审批 | P1-1、P1-3、P2-1（后续收紧） |
| 续跑与 checkpoint | P3-*（按需） |

**说明**：上表 P0-1～P1-3 已在代码库中落地并有 `planningService.test.ts` 等回归；P2-1 及之后条目仍按原优先级独立推进。若后续调整实现，请同步更新本节与第 5.2 节状态列。
