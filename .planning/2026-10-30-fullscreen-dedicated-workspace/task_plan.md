# Task Plan: 全屏窗口专用工作区（macOS 风格 Space）

## Goal

实现接近 macOS 全屏 Space 的行为：全屏时为该窗口新建相邻的专用工作区，退出全屏时销毁该工作区并把窗口放回原工作区。

## Next Step

等待用户重登后做真机验证（Phase 3）。验证点：全屏 → 移到新工作区；退出 → 回原工作区且专用工作区消失；快速反复全屏/退出不出现工作区暴涨或卡死。

## Current Phase

Phase 3（验证）

## Phases

### Phase 1: 技术调研与方案论证
- [x] 摸清 GNOME 工作区 API 能力边界
- [x] 摸清 mutter 自动工作区管理机制（`_checkWorkspaces` / `_windowRemoved`）
- [x] 确认独占强制的可行性（结论：无工作区访问控制 API，无法强制）
- [x] 识别冲突源（内置 AutoMove 的 `_checkWorkspaces` hook）
- [x] 查阅 macOS 官方文档，对齐设计思路（每窗口动态创建独立 Space）
- **Status:** complete

### Phase 2: 实现
- [x] `_place`：每窗口新建相邻工作区并把窗口移入
- [x] `_restore`：移回原工作区 + 显式删除专用工作区
- [x] 防循环：`_busy` 锁（250ms 定时释放）+ 幂等检查 + 状态表优先
- [x] 与 AutoMove 冲突互斥（AutoMove 开启时不新建工作区）
- [x] `destroy` 路径只清状态，不操作工作区
- [x] 独占维持 —— **不做**（无 API 支持，明确告知用户）
- **Status:** complete

### Phase 3: 验证
- [x] 语法校验（node --check）
- [x] 防循环模拟测试（5 次事件风暴 → 2 次移动，state 清空）
- [ ] 真机行为验证（待用户重登）
- **Status:** in_progress

### Phase 4: 白名单式独占（macOS Auxiliary 对齐）
用户诉求：不硬拒绝，而是「跳过 + 置灰」——快捷键移动时跳过专用工作区，
概览拖拽时专用工作区显示为灰色且不可放入。

- [ ] 维护专用工作区集合（`Set<Meta.Workspace>`）
- [ ] 拦截 `Meta.Window.prototype.change_workspace_by_index`：跳过专用工作区
- [ ] 拦截 `Meta.Window.prototype.change_workspace`：同上
- [ ] 拦截拖拽落点（`ThumbnailsBox.acceptDropInternal` 或
      `Main.moveWindowToMonitorAndWorkspace`）：拒绝放入专用工作区
- [ ] 专用工作区缩略图置灰（`thumbnail.metaWorkspace` 匹配 → set_style）
- [ ] 内部移动豁免标记（我们自己的 `_place`/`_restore` 必须放行）
- [ ] 用官方 `InjectionManager` 存取原始方法，保证可正确 restore
- [ ] 做成设置开关（默认关闭，因为是侵入性行为）
- **Status:** pending

### 关键技术结论（Phase 4 预研）
- `InjectionManager._installMethod` 直接写 `prototype[methodName] = method`，可 patch
- 快捷键移动：`Main.wm.actionMoveWindow` → `window.change_workspace(ws)`
- 概览拖拽：`WorkspaceThumbnail.acceptDropInternal` →
  `Main.moveWindowToMonitorAndWorkspace(win, monitor, index)`
- 缩略图对象可从 `WorkspaceThumbnail.metaWorkspace` 反查，**不依赖私有字段**
- 风险：与其他 patch 同一方法的扩展可能相互影响；置灰依赖
  `_workspacesViews`/`_thumbnails` 私有层级，GNOME 升级可能失效

