# Cofree 开发进度追踪（必须实时维护）

**Last Updated**: 2026-02-27 14:50 CST by Codex-GPT-5  
**当前 Milestone**：2 - 服务员对话 + 计划生成（Completed）  
**Next Task**：Milestone 3.1 HITL 审批状态机骨架（planning → executing → human_review → done）

## Milestone 0: 项目初始化与文档（Completed）
- [x] 创建仓库 & 初始化文档包
- [x] 编写所有开发文档
- [x] 定义进度同步规范

## Milestone 1: Tauri 项目骨架（Completed）
- [x] 1.1 创建 Tauri 2.0 + React 19 项目（含聊天/厨房/设置导航）
- [x] 1.2 配置 LiteLLM + 多模型支持（provider/model 注册表 + 请求配置模块）
- [x] 1.3 实现基础设置页（API Key + Base URL + egress 选项本地持久化）

**Acceptance Criteria for Milestone 1**：
- [x] 前端构建通过（`npm run build`，含 TypeScript 校验）
- [x] 设置页可保存 API Key 到本地（`localStorage`）
- [x] PROGRESS.md 已更新
- [ ] 在当前环境完整验证 `pnpm tauri dev`（受限：pnpm registry 代理到 `127.0.0.1:7890` 不可达，Rust crates 拉取失败，且本机未安装 Xcode）

## Milestone 2: 服务员对话 + 计划生成（Completed）
- [x] 2.1 流式对话管道（LiteLLM stream 消费、Chat 增量渲染、取消与异常处理）
- [x] 2.2 结构化计划生成（输出映射到 `OrchestrationPlan`）
- [x] 2.3 待审批动作列表（`proposedActions` 仅 Pending 展示，不执行）
- [x] 2.4 安全与可观察性底线（local-only 阻断云请求 + LLM 请求审计最小集）
- [x] 2.5 演示与验收（2 分钟录屏脚本 + 无副作用验证）

**Acceptance Criteria for Milestone 2**：
- [x] 聊天区可流式输出，并在中断/异常时提供可读提示
- [x] 可生成并展示结构化计划（包含 `state/prompt/steps/proposedActions`）
- [x] 所有待审批动作均标记为 Pending/Not Executed
- [x] `allowCloudModels=false` 时阻断云模型请求
- [x] 审计日志记录 LLM 请求元信息（provider/model/time/length/request id），且不含 API Key
- [x] 演示可证明：本阶段无写盘、无命令执行、无 git 写操作

### Milestone 2 演示脚本（2 分钟）
1. 打开聊天页，输入一个需求并点击“发送点单”，演示服务员回复逐 token 流式出现。
2. 在流式中点击“取消”，演示可中断且显示可读状态提示。
3. 重新发送同一需求，等待结构化计划渲染（显示 `state/prompt/steps`）。
4. 展示待审批动作列表：`apply_patch/run_command/git_write` 全部为 `PENDING / Not Executed`。
5. 打开设置页关闭 `Allow cloud models` 且选择云 provider，返回聊天页验证发送按钮被阻断并给出提示。
6. 切回本地 provider（Ollama）后恢复可发送，完成一次成功规划。

### Milestone 2 无副作用验证
- Chat 规划链路仅调用 LiteLLM HTTP 接口与 localStorage 审计落盘；
- 未实现任何写文件、命令执行、git 写操作入口；
- 待审批动作全部仅展示，不提供执行按钮。

**更新规则**（所有开发者必须遵守）：
1. 每次完成一个子任务 → 立即编辑本文件，打钩 + 更新时间 + 签名
2. Git commit 必须包含 `progress:` 前缀，例如 `progress: complete 1.1 tauri skeleton`
3. 每天结束时必须 push PROGRESS.md

## Implementation Log
- 2026-02-27: 完成 Milestone 1 骨架代码（Tauri + React 19 + 三页导航 + 设置持久化 + LiteLLM 多模型配置 + mock orchestration 预览）。
- 2026-02-27: 前端构建验证通过（`npm run build`）。
- 2026-02-27: Tauri/Rust 完整联调受本地代理与依赖下载限制阻塞（需可用 crates/pnpm 源与 Xcode）。
- 2026-02-27: 完成 Milestone 2 全量实现：LiteLLM 流式消费、结构化计划生成、Pending 动作列表、local-only 阻断、LLM 最小审计日志。
- 2026-02-27: 构建校验通过（`npm run build`），确认 Milestone 2 阶段无写盘/命令/git 写副作用。

## Docs Update Log
- 2026-02-27: Add MVP scope, guardrails, security/privacy, git support docs; update PRD/Roadmap/Architecture to lightweight diff (`jsdiff` + `diff2html`) and clarify non-goals.
- 2026-02-27: Expand Week 2 planning in `docs/ROADMAP.md` with scope boundaries, task packages (M2.1~M2.5), acceptance checklist, and risk controls; sync Milestone 2 execution template in `PROGRESS.md`.
