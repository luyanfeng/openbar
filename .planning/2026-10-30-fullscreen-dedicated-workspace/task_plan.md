# Task Plan: 全屏窗口专用工作区（macOS 风格 Space）

## Goal

实现接近 macOS 全屏 Space 的行为：全屏时为一个窗口创建相邻的专用工作区（独占），退出全屏时销毁该工作区并把窗口放回原工作区。

## Next Step

Phase 2：按论证后的方案实现 `_place` / `_restore`，并处理独占强制与冲突互斥。

## Current Phase

Phase 1（技术调研）完成 → Phase 2（实现）

## Phases

### Phase 1: 技术调研与方案论证
- [x] 摸清 GNOME 工作区 API 能力边界
- [x] 摸清 mutter 自动工作区管理机制（`_checkWorkspaces` / `_windowRemoved`）
- [x] 确认独占强制的可行性
- [x] 识别冲突源
- **Status:** complete

### Phase 2: 实现
- [ ] `_place`：新建相邻工作区并把窗口移入
- [ ] `_restore`：移回原工作区 + 清理专用工作区
- [ ] 独占维持（新窗口进入时迁出）
- [ ] 与 AutoMove 冲突互斥
- **Status:** in_progress

### Phase 3: 验证
- [ ] 语法 / schema 校验
- [ ] 真机行为验证
- **Status:** pending
