# Cofree UI 视觉重构计划

> 状态追踪文档。每阶段完成后在本文件更新勾选框与「完成情况」小节；遇到问题直接补在「问题记录」。不开新文档。

## 一、背景与目标

当前 UI 的核心问题是**色彩策略偏向消费级 AI 玩具**：大面积紫蓝渐变背景 + 毛玻璃气泡 + 紫色 accent 让它脱离了「开发者日常工具」的气质。

目标：把整体视觉重做到与 Linear / Vercel / Zed / Raycast / Cursor 同一档次的专业感，路径是**中性深色打底 + 极度克制的点缀 + 靠排版与间距撑气场**。

**决策基线**（已确认）：

1. 彻底取消助手气泡（贴背景显示，仅靠 avatar 缩进区分）
2. **不保留紫色**：全 UI 走纯灰阶，`--accent` token 保留但默认为近白，供未来品牌化使用
3. Logo / Avatar 暂不重做，只去紫色渐变与发光
4. 不保留 legacy 主题，直接推翻重来

## 二、设计原则

| 原则 | 含义 |
|---|---|
| 中性打底 | 背景用近黑 `#0A0A0B` 纯色，取消所有渐变与径向光晕 |
| 去质感化 | 全 UI 删除 `backdrop-filter`；实色块 + 极细 1px 边框；去外发光、去内发光 |
| 排版撑气场 | 正文字重 500；模型名 / token / 路径 / 命令 / 时间戳全部走 JetBrains Mono |
| 降低视觉噪声 | 圆角缩小（24→12、18→12、10→6）；去 badge 背景；去装饰性阴影 |
| 一次到位 | 不保留 legacy 主题；`theme.legacy.css` 不建；老 token 直接删 |

## 三、颜色体系（最终方案）

### 深色（默认）

```css
:root {
  /* 背景阶梯 */
  --bg-app:             #0A0A0B;
  --bg-panel:           #131316;
  --bg-surface:         #1A1A1F;
  --bg-surface-hover:   #22222A;
  --bg-surface-active:  #2A2A32;

  /* 边框 */
  --border-subtle:      #1F1F24;
  --border-default:     #26262C;
  --border-strong:      #35353D;
  --border-focus:       #3D3D48;  /* 聚焦也走中性；不用紫 */

  /* 文本 */
  --text-1: #E8E8EC;
  --text-2: #9B9BA3;
  --text-3: #6B6B75;
  --text-4: #4A4A52;

  /* accent（保留为 hook，默认中性近白；当前 UI 不出现紫色） */
  --accent:         #E8E8EC;
  --accent-hover:   #FFFFFF;
  --accent-subtle:  rgba(232,232,236,0.08);

  /* 语义色 */
  --color-success:  #4ADE80;
  --color-error:    #F87171;
  --color-warning:  #FACC15;
  --color-info:     #60A5FA;
}
```

### 浅色（`[data-theme="light"]`）

```css
[data-theme="light"] {
  --bg-app:             #FAFAFB;
  --bg-panel:           #F4F4F6;
  --bg-surface:         #ECECEF;
  --bg-surface-hover:   #E4E4E8;
  --bg-surface-active:  #DCDCE0;

  --border-subtle:      #E8E8EC;
  --border-default:     #DCDCE0;
  --border-strong:      #C8C8CE;
  --border-focus:       #A8A8B0;

  --text-1: #18181B;
  --text-2: #52525B;
  --text-3: #71717A;
  --text-4: #A1A1AA;

  --accent:         #18181B;
  --accent-hover:   #000000;
  --accent-subtle:  rgba(24,24,27,0.06);

  --color-success:  #16A34A;
  --color-error:    #DC2626;
  --color-warning:  #CA8A04;
  --color-info:     #2563EB;
}
```

### 删除的旧 token（theme.css 整理）

- `--bg-gradient`、`--bg-overlay`（径向光晕）
- `--glass-blur-sm/md/lg/xl`
- `--glass-border-glow`、`--glass-inner-glow`、`--glass-inner-glow-strong`
- `--accent-glow`、`--accent-glow-sm`
- `--neon-blue`、`--neon-purple`、`--neon-cyan`
- `--accent-solid`、`--accent-bright`、`--accent-muted`、`--accent-text`（替换为新的 `--accent` 语义）
- `--surface-0..5` 旧的 rgba 阶梯（替换为实色 `--bg-*`）

## 四、阶段规划与进度

> 每阶段独立 PR；完成后勾选并填写「完成情况」。

### Phase 1：色彩 token 重铸 `[x]`

**目标文件**：`src/styles/base/theme.css`, `src/styles/base/reset.css`

- [x] 清空旧 token（gradient / glass / accent-glow / neon / surface 阶梯）
- [x] 写入新的 `--bg-*` / `--border-*` / `--text-*` / `--accent*` 变量（深色 + 浅色）
- [x] `body` 背景由 `var(--bg-gradient)` 改为 `var(--bg-app)`
- [x] 全局正文字重提到 `500`，加 `letter-spacing: -0.005em`

**验收**：`pnpm dev` 启动后整体呈现近黑纯色背景，无渐变、无光晕；旧界面依然能勉强使用（后续 Phase 会修好细节）。

**完成情况**：
- 2026-04-23 — theme.css 重写完成（v7 "Neutral Workbench"）。保留了一层 legacy token 别名块，使后续 Phase 未迁移完的 CSS 在过渡期依然能渲染；Phase 6 结尾已删除此块。
- reset.css 简化：去除 `body::before` 径向光晕层、滚动条改中性细线。
- `pnpm build` 通过。

---

### Phase 2：去玻璃化 + 助手气泡取消 `[x]`

**目标文件**：
- `src/styles/features/chat/bubble.css`
- `src/styles/features/chat/panel.css`
- `src/styles/features/chat/input.css`
- `src/styles/layout/titlebar.css`
- `src/styles/features/settings.css`
- `src/styles/components/dialogs.css`

**操作**：

- [x] 全局删除 `backdrop-filter` / `-webkit-backdrop-filter`（`grep -rn "backdrop-filter" src/styles/` 清零）
- [x] 用户气泡：实色 `--bg-surface-active`，去边框去阴影，圆角 12px，padding 10px 14px
- [x] **助手气泡彻底取消**：`background: transparent; border: none; padding: 0; box-shadow: none;`
- [x] `.chat-row.assistant` 的 `gap` 与 avatar 对齐微调，确保正文基线与 avatar 顶部对齐
- [x] 顶栏 / 侧栏 / 输入框 / 设置 Modal / 对话框 全部替换为 `var(--bg-panel)` 或 `var(--bg-surface)` 实色 + 1px `var(--border-default)` 边框
- [x] 输入框圆角 24→12，聚焦态只变边框色，不再有紫色外发光
- [x] 助手消息中若有「工具调用卡片」「plan 卡片」等子块，检查它们原本依赖气泡边界的视觉逻辑，必要时加 1px `var(--border-subtle)` 自行维持边界

**验收**：聊天长文从视觉上「贴背景呼吸」；顶栏 / 侧栏不再有朦胧感；输入框焦点是一条清晰的边线变化。

**完成情况**：
- 改写文件：`bubble.css`、`panel.css`、`input.css`、`titlebar.css`、`settings.css`、`dialogs.css`
- 助手气泡完全透明；用户气泡实色 + 圆角 12px；输入框圆角 24→12，聚焦只变边框色
- 顶栏/侧栏/Modal/对话框均走实色 + 1px 边框，无 backdrop-filter
- 工具卡片（plan-step、action-item、shell-result 等）本身已有独立 border，无需额外加线

---

### Phase 3：侧栏信息层级 `[x]`

**目标文件**：`src/styles/features/chat/panel.css`, `src/ui/components/ConversationSidebar.tsx`

- [x] `.conv-panel-item` 去整圈 border；`border-radius: 6px`
- [x] `.conv-panel-item.active::before` 竖条：`left: 0; width: 2px; background: var(--text-1); box-shadow: none; border-radius: 0`（竖条改用近白，不用紫色）
- [x] `.conv-panel-item.active` 背景改 `var(--accent-subtle)`，去 `accent-glow-sm`
- [x] 时间戳：`color: var(--text-4); font-size: 11px; font-family: var(--font-mono)`
- [x] 消息数角标 `.conv-panel-item-count`：去背景、`color: var(--text-4); font-family: var(--font-mono); padding: 0`
- [x] 「新对话」按钮：`background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: 6px; height: 30px`，hover 去发光
- [x] 新对话按钮图标换成 lucide `Plus` 细线版（若当前非细线版）

**验收**：侧栏整体视觉重量明显降低；选中项一眼可辨但不喧宾；时间戳与消息数不再抢注意力。

**完成情况**：
- `ConversationSidebar.tsx` 里把原裸文本的时间戳包进 `.conv-panel-item-time` span，走 mono 样式。
- 现有 `IconPlus`（strokeWidth 1.5）已是细线版，直接保留。

---

### Phase 4：顶栏 + 输入框 + 按钮 `[x]`

**目标文件**：
- `src/ui/components/TitleBar.tsx`
- `src/styles/layout/titlebar.css`
- `src/styles/features/chat/input.css`
- `src/ui/pages/chat/composer/ChatComposer.tsx`
- `src/styles/components/buttons.css`
- `src/ui/pages/chat/ChatPresentational.tsx`（token ring 颜色逻辑）

**操作**：

- [x] `TitleBar.tsx`：新增 `shortenModelName()` 工具，把 `claude-sonnet-4-5-20250929` 这种长名显示成 `sonnet-4.5`；完整名放 `title` 属性作为 hover tooltip
- [x] `.titlebar-model-name` 保留 monospace；加 `text-overflow: ellipsis`
- [x] `.titlebar-actions`：按钮间 gap 从 4px 调到 8px；在 settings 按钮前插一个 1px `var(--border-default)` 垂直分隔
- [x] `.titlebar-btn.active`：去紫色背景，改 `background: var(--bg-surface-active); color: var(--text-1); box-shadow: none`
- [x] `.chat-textarea::placeholder`：`color: var(--text-4); font-weight: 400`
- [x] `ChatComposer.tsx`：placeholder 文案改为「描述你的编码任务…」；快捷键提示块 放在输入框右下角，`color: var(--text-4); font-size: 11px; font-family: var(--font-mono)`
- [x] `.btn-primary`：改白底黑字 `background: #E8E8EC; color: #18181B; border: none; box-shadow: none; font-weight: 600`；hover 变 `#FFFFFF`；disabled 降到 `var(--bg-surface-active) + var(--text-3)`（不靠 opacity）
- [x] 浅色主题下 `.btn-primary` 反转为黑底白字
- [x] `ChatPresentational.tsx` 的 token ring `getColor()`：`< 85%` 使用 `var(--text-3)`（中性灰）；`85-95%` warning；`> 95%` error

**验收**：顶栏干净、不挤；模型名可读且可展开；发送按钮白底黑字像工具而非彩色方块；token ring 平时几乎隐形，临近上限才抢注意力。

**完成情况**：
- `shortenModelName` 策略：去尾部日期后缀（`-YYYYMMDD` / `-YYYY-MM-DD`）、去 `claude-` 前缀、把 `4-5` 型版本段转成 `4.5`。完整模型名通过 `title` 作为 hover tooltip。
- 快捷键提示块放在 `.chat-input-actions` 内作为 `.chat-shortcut-hint`（footer 最右侧有发送按钮，绝对定位会遮挡，改为内联文字依然处于「右下角」视觉位置）。
- token ring 平时用 `--text-3`，85% 转 warning、95% 转 error；SVG 背景圈改用 `--border-subtle`。

---

### Phase 5：Avatar 去紫色 `[x]`

**目标文件**：`src/styles/features/chat/bubble.css`

- [x] `.chat-avatar`：`width/height` 30→28，`border-radius` 10→6，`font-family: var(--font-mono); font-weight: 600; font-size: 11px`
- [x] `.chat-avatar.user`：去紫蓝渐变，改 `background: var(--bg-surface-active); color: var(--text-1); border: 1px solid var(--border-default); box-shadow: none`
- [x] `.chat-avatar.assistant`：同上，完全去 `accent-muted` 和紫色 glow
- [x] 字符渲染逻辑保持不变（复用 agent displayName 首字），Logo 重做留后续 issue

**验收**：avatar 从「发光紫方块」变成「方正等宽灰块」，与开发者工具的气质一致。

**完成情况**：
- user / assistant 共用同一组样式，28×28、`--r-sm`(6px)、mono 11px。

---

### Phase 6：排版与细节打磨 `[x]`

**目标文件**：
- `src/styles/features/chat/markdown.css`
- `src/styles/base/theme.css` 或 `reset.css`
- 其他零散处

**操作**：

- [x] `body` 正文字重 `500`（若 Phase 1 未完成）
- [x] Markdown `ul > li` 圆点改为 `·`（或 `–`），颜色 `var(--text-3)`
- [x] 扩展 monospace 覆盖：`.token-usage-ring span`、`.chat-code-block-lang`、`.conv-panel-item-time`、`.conv-panel-item-count`、shell 输出路径、diff 文件路径、diagnostics 错误码
- [x] Inline `<code>` 背景换成 `var(--bg-surface)`；去所有原紫色着色
- [x] 扫一遍 `src/styles/**/*.css`，排查残留的 `rgba(139,142,232,...)`、`rgba(168,85,247,...)`、`#8B8EE8`、`#A8ABF0`、`#A855F7`、`violet-*`、`purple-*` 字样全部清除

**验收**：`grep -rniE "rgba\(139|rgba\(168|#8b8ee8|#a8abf0|#a855f7|violet|purple" src/styles/` 零命中。

**完成情况**：
- 改写了 `markdown.css`、`layout.css`、`topbar.css`、`cards.css`、`alerts.css`、`forms.css`、`update-banner.css`、`terminal.css`、`tools/plan.css`、`tools/diff.css`、`tools/executions.css`。
- `ChatPresentational.tsx` 中两处硬编码的 `var(--surface-0)` / `var(--surface-2)` 内联样式替换为 `--bg-panel` / `--bg-surface`。
- 删除了 Phase 1 留下的 legacy token 别名块；`grep -rnE "var\(--surface-|var\(--glass-|var\(--accent-solid|…|#8b8ee8|#a8abf0|#a855f7|violet|purple"` 全部零命中。
- `pnpm build` 通过；`pnpm test --run` 46 个 test file、475 条 test 全绿。

---

## 五、最终验收清单

每阶段完成都按此清单过一次（同时走深色 + 浅色）：

- [ ] 空对话（welcome screen）
- [ ] 长对话（多轮、含代码块、含 diff）
- [ ] 工具审批弹窗（patch / shell）
- [ ] 侧栏有 20+ 会话的滚动
- [ ] 顶栏 workspace / model chip 的 hover 与下拉展开
- [ ] 输入框空态 / 输入中 / 即将满 token
- [ ] 设置页各 Tab
- [ ] 终端面板展开
- [ ] 低端显示器 / 非 HiDPI 实机看一眼（原毛玻璃性能瓶颈验证）

## 六、风险与回滚

- **风险**：老用户的自定义 CSS hack（若有）会因 token 名变化失效。可接受，无外部用户。
- **回滚策略**：不保留 legacy。每个 PR 独立可 revert；重构过程中 main 分支始终可运行。
- **兼容性**：`--accent*` 保留名字以防某处组件硬编码引用；若有零散硬编码 `#8B8EE8` 会在 Phase 6 扫清。

## 七、问题记录

> 实施中遇到的未预期情况、决策变更、范围调整写在这里。

<!-- 示例：
### 2026-04-24 — Phase 2 发现
ToolExecutionCard 原本没有独立 border，完全靠气泡边界界定。改为 `border: 1px solid var(--border-subtle)` 后与外层视觉冲突，最终决定去掉 border，改用 `padding-left: 12px` + 左侧 1px 竖线。
-->

## 八、相关链接

- 原始评价（用户 review）：见 PR / issue 讨论
- 参考系：Linear、Vercel、Zed、Raycast、Cursor
