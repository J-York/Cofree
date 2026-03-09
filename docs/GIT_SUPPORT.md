# Cofree Git 支持现状（v0.0.8）

本文件描述当前版本与 Git 相关的真实能力和限制。

## 1. 工作区与 Git 的关系

### 1.1 当前行为
- 用户选择的工作区只要求“路径存在且是目录”。
- 当前 `validate_git_repo()` 不会真正校验该目录是否是 Git 仓库。
- `get_workspace_info()` 会尝试读取 Git 分支；如果不是 Git 仓库，仍会返回目录名，但分支为空。

### 1.2 文档结论
- Git 仓库是 **推荐工作区类型**，不是严格前置条件。
- 如果选择非 Git 目录，应用仍可读取和修改文件，但 Git 状态与 diff 能力会受限。

## 2. 当前已支持的 Git 读能力

- `git_status`：查看 modified / added / deleted / untracked。
- `git_diff`：查看工作区 diff，可按文件读取。
- 工作区信息中展示当前分支名（如果仓库可识别）。

## 3. 当前 Git 写能力

Git 写操作目前不走专用 Git API，而是统一通过 shell 执行。

### 3.1 实际可行的操作
- `git add`
- `git commit`
- `git checkout -b`
- 其他用户或模型明确提出并经审批的 Git 命令

### 3.2 执行方式
1. 模型通过 `propose_shell` 生成完整命令。
2. 用户在 UI 中审批该命令。
3. 后端在工作区目录执行命令。
4. 执行结果通过 shell 结果面板返回。

## 4. 当前不应被写成“已支持”的内容

- 专用 Git commit UI
- 自动 push 流程
- submodule 专项支持
- Git LFS 专项支持
- merge / rebase 冲突自动解决

## 5. 失败行为

- `git_status` / `git_diff` 在非 Git 目录或异常仓库中可能失败，前端应把它当作普通工具失败处理。
- Git shell 命令失败时，用户会看到 stderr 与 exit code。
- 如果是 patch 应用失败，系统依靠快照回滚，而不是 Git reset。

## 6. 风险与建议

- Git 写命令本质上是 shell 命令，因此风险模型与普通 shell 相同。
- 若项目强依赖 Git 审查与提交，实际使用时仍应选择标准 Git 仓库。
- 文档中不应再写“必须先选择 Git 仓库才能进入应用”，因为这与当前实现不符。
