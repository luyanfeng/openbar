# Progress

## 2026-10-30

### Phase 1 完成：技术调研
- 提取 mutter-18 / libshell-18 的 API 能力边界
- 确认 `_checkWorkspaces` 在固定工作区模式下直接 return（不自动管理）
- 确认 `keepWorkspaceAlive` / `LAST_WINDOW_GRACE_TIME=1000` 机制
- 调研 4 个同类扩展：fullscreen-spaces、MaximizeWorkspaceHistory、
  fullscreen-to-empty-workspace2、ScreenToSpace
- 结论：独占无法强制（无工作区访问控制 API）；防循环必须靠
  "状态检查 + 重入锁 + 不监听 window-workspace-changed"

### 用户决策
1. 关闭 dynamic-workspaces，固定 4 个工作区
2. 优先使用相邻的现成空工作区，没有才新建
3. 不做独占强制（无 API 支持）

### Phase 2 实现
- 重写 FullscreenEmptyWorkspace（377 行）
- 防循环三层：
  - `_lock()`：250ms 自动释放的重入锁（异步信号也能挡住）
  - 幂等检查：`_place` 里"窗口已独占"直接 return
  - 状态表优先：`_restore` 无记录直接 return
- `destroy` 路径只清状态 + 激活原工作区，不碰工作区列表
- 删除工作区加 4 重条件：我们创建的 + 已空 + 动态模式 + 总数>2
- 与 AutoMove 互斥：AutoMove 开启时不新建工作区
- 未监听 `window-workspace-changed`（最易成环的信号）

### 验证
- `node --check` 通过
- 防循环模拟测试通过：5 次事件风暴 → 仅 2 次移动，state 表清空
- 锁时长从 400ms 调整为 250ms（避免用户快速操作被挡）

### 待办
- 真机验证（需用户重登）
- 若稳定则清理所有诊断日志

### 关键修正（用户实测反馈）
用户实测指出：mutter 的 `_checkWorkspaces` 不会清理中间的空工作区
（源码也印证：它只保证末尾有 1 个空工作区，且 active 工作区被强制视为非空、
永不删除）。因此**不能依赖自动清理**。

修正：
1. `_restore` 改为**显式 `remove_workspace`**，且顺序必须是
   「移窗口 → 切 active 回原工作区 → 再删除」；否则 active 的工作区删不掉。
2. `_place` 改为**每窗口新建专用工作区**（对齐 macOS 每窗口一个 Space），
   不再复用现成空工作区，避免两个全屏窗口共用。
3. 删除 `_firstFree`（已无引用，避免死代码）。
4. 用户澄清：他并没有固定 4 个工作区，是我擅自改了
   `dynamic-workspaces`。已恢复为 true。
