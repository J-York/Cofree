# Git 依赖移除说明

## 修改概述

Cofree 现已支持在非 Git 仓库目录中正常工作。所有 Git 相关功能已变为可选功能。

## 主要修改

### 1. Rust 后端 (src-tauri/src/main.rs)

#### `validate_git_repo()`
- **修改前**: 检查目录是否为有效 Git 仓库，非 Git 目录返回 false
- **修改后**: 只要目录存在就返回 true，允许所有有效目录

#### `get_workspace_info()`
- **修改前**: 尝试打开 Git 仓库，失败时返回 (None, None)
- **修改后**: 非 Git 目录时返回目录名作为 repo_name，git_branch 为 None

#### `git_status_workspace()`
- **修改前**: 必须是有效 Git 仓库，否则返回错误
- **修改后**: 非 Git 目录返回空的 GitStatus 结构（所有字段为空数组）

#### `git_diff_workspace()`
- **修改前**: 必须是有效 Git 仓库，否则返回错误
- **修改后**: 非 Git 目录返回空字符串

#### `apply_patch_internal()`
- **修改前**: 使用 git apply，依赖 Git 仓库
- **修改后**: git apply 在非 Git 目录中也可以工作，补丁应用逻辑保持不变

### 2. 前端 UI (src/ui/pages/SettingsPage.tsx)

#### `loadWorkspaceInfo()`
- **修改前**: 先调用 `validate_git_repo`，非 Git 仓库显示错误
- **修改后**: 直接调用 `get_workspace_info`，不再显示 Git 仓库警告

#### 工作区信息显示
- **修改前**: 显示 Git 分支和仓库名，非 Git 仓库显示错误提示
- **修改后**: 只在有 Git 分支信息时显示，否则只显示目录路径

### 3. 编排层 (src/orchestrator/planningService.ts)

#### Git 工具定义
- 在 `git_status` 和 `git_diff` 的 description 中添加了说明：
  - "Returns empty result for non-git directories"
  - 明确说明非 Git 目录会返回空结果

#### 系统提示更新
- **ASSISTANT_SYSTEM_PROMPT**:
  - 移除了 "或 git 写操作" 的强制要求
  - 添加说明："Git 操作仅在 Git 仓库中有效，非 Git 目录会返回空结果"

#### `inferToolRoutingPolicy()`
- 添加注释说明 Git 工具始终可用，但在非 Git 目录中返回空结果

#### `createRuntimeContextPrompt()`
- 添加说明："Git 工具说明：git_status 和 git_diff 在非 Git 仓库中会返回空结果，这是正常的。"
- 移除了 "git 写操作" 的 Guardrails 限制说明

## 使用场景

### 场景 1: Git 仓库目录
- 所有功能正常工作
- `git_status` 返回实际的文件状态
- `git_diff` 返回实际的差异
- Git 分支信息在 UI 中显示

### 场景 2: 非 Git 目录
- 文件读写、列表等基本功能正常工作
- `git_status` 返回空结果（所有数组为空）
- `git_diff` 返回空字符串
- UI 只显示目录路径，不显示 Git 信息
- Patch 应用仍然可以工作（git apply 不依赖 .git 目录）

## 测试建议

1. **在 Git 仓库中测试**：
   - 选择一个 Git 仓库作为工作区
   - 验证 Git 分支信息正确显示
   - 验证 git_status 和 git_diff 返回正确结果

2. **在非 Git 目录中测试**：
   - 创建一个新目录：`mkdir /tmp/test-cofree && cd /tmp/test-cofree`
   - 在 Cofree 中选择这个目录作为工作区
   - 验证没有错误提示
   - 验证可以创建、编辑、读取文件
   - 验证 git_status 返回空结果不会导致错误

3. **混合场景测试**：
   - 在非 Git 目录中创建文件
   - 使用 propose_file_edit 创建新文件
   - 使用 propose_shell 执行普通命令（如 ls, cat 等）
   - 验证所有操作正常完成

## 向后兼容性

- 所有现有的 Git 仓库工作区继续正常工作
- 现有的工作流程不受影响
- API 接口保持不变，只是返回值语义略有调整（空结果而不是错误）

## 依赖说明

- `git2` 依赖保留，因为在 Git 仓库中仍需要使用
- `git` 命令行工具仍然需要安装（用于 patch 应用）
- 在非 Git 环境中，这些依赖不会导致错误，只是返回空结果

## 后续优化建议

1. 可以考虑在 UI 中添加一个指示器，显示当前工作区是否为 Git 仓库
2. 可以在非 Git 目录中提供初始化 Git 仓库的快捷按钮
3. 可以优化错误提示，明确区分 Git 相关错误和其他文件系统错误
