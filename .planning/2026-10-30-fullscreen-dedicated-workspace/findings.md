# Findings: 全屏专用工作区可行性调研

## 一、GNOME 工作区 API 能力边界（从 mutter-18.typelib / libshell-18.so 提取）

| API | 存在 | 说明 |
|---|---|---|
| `append_new_workspace(before, time)` | ✅ | 只能加在首/尾，`before=false` 加末尾 |
| `reorder_workspace(ws, newIndex)` | ✅ | 可把工作区移到任意位置 |
| `remove_workspace(ws, time)` | ✅ | 删除指定工作区 |
| `get_n_workspaces()` | ✅ | |
| `get_workspace_by_index(i)` | ✅ | |
| `keepWorkspaceAlive(ws, duration)` | ✅ | **shell 私有**，让空工作区在 duration 内不被自动删 |
| **锁定工作区 / 拒绝窗口移入** | ❌ | **不存在** |
| **隐藏工作区（不在概览/快捷键里）** | ❌ | 不存在 |

## 二、mutter 的自动工作区管理（决定性）

从 `Main.wm._workspaceTracker._checkWorkspaces()` 源码：

```js
if (!Meta.prefs_get_dynamic_workspaces()) {
    this._checkWorkspacesId = 0;
    return GLib.SOURCE_REMOVE;      // ← 固定工作区模式：完全不管
}
...
// 动态模式：
// 1. 若末尾不是空的 → append_new_workspace
// 2. 强制至少 MIN_NUM_WORKSPACES = 2 个
// 3. 从后往前删除空工作区（跳过末尾那个），但永不删到少于 2 个
for (i = lastIndex; i >= 0; i--) {
    if (workspaceManager.n_workspaces === MIN_NUM_WORKSPACES) break;
    if (emptyWorkspaces[i] && i !== lastEmptyIndex)
        workspaceManager.remove_workspace(this._workspaces[i], ...);
}
```

`_windowRemoved()`：窗口离开工作区后，`LAST_WINDOW_GRACE_TIME = 1000ms` 宽限期，之后 `_queueCheckWorkspaces()`。

**结论**：
- **动态工作区模式**：空工作区会被 mutter 自动删除（1 秒后）。**我们不需要手动 remove_workspace**，只需保证窗口离开后工作区变空。
- **固定工作区模式**：`_checkWorkspaces` 直接 return，**mutter 完全不管**。`remove_workspace` 在固定模式下行为不受 shell 保护，但 mutter 底层仍支持。

## 三、独占能否强制

**不能。** 没有工作区级别的访问控制。

只能事后纠正：
```js
global.display.connect('window-created', (d, win) => { ... });
global.display.connect('window-workspace-changed', ...);  // 该信号名需确认
```

风险：
- 窗口已经显示才被挪走 → **可见闪烁**
- 用户手动 `Super+Shift+方向键` 移动窗口 → 只能事后拉回
- 纠正动作本身触发事件 → **死循环风险**（原版 Auto Move 用 `_keepAliveId` 打补丁正是为此）

## 四、冲突源

| 冲突 | 状态 | 影响 |
|---|---|---|
| `fullscreen-to-empty-workspace2@corgijan.dev` | INITIALIZED（未启用） | 无 |
| `auto-move-windows@...` | INITIALIZED（未启用） | 无 |
| **OpenBar 内置 AutoMove** | 由设置开关控制 | ⚠️ 它替换了 `_checkWorkspaces`，会"保留尾部空工作区"，与删除空工作区**直接矛盾** |
| DING（桌面图标） | ACTIVE | 独立进程，无冲突 |

## 五、动态 vs 固定工作区的取舍（用户已选：固定 4 个）

| | 动态模式 | 固定模式（当前选择） |
|---|---|---|
| 空工作区自动清理 | ✅ mutter 1 秒后删 | ❌ 永不删，需手动 |
| 工作区编号稳定 | ❌ 会变 | ✅ 稳定 |
| 可直接用现成空工作区 | 不一定有空 | ✅ 4 个里通常有空 |
| 新建后需要手动删 | 不必（自动） | 需要，但可省略（空着无害） |

## 六、方案设计（最接近 macOS）

### macOS 行为分解
1. 全屏 → 新建专用 Space（紧邻当前）
2. 该 Space 只有这个窗口
3. 其他窗口**无法**进入（系统强制）
4. 退出全屏 → Space 销毁，窗口回原位

### GNOME 可达成度

| macOS 行为 | 可达成 | 方案 |
|---|---|---|
| 1. 新建相邻 Space | ✅ | `append_new_workspace` + `reorder_workspace` 到 `current+1` |
| 2. 只有该窗口 | ✅ | `win.change_workspace(newWs)` |
| 3. 无法进入 | ⚠️ 部分 | 监听 `window-created`，新窗口若落在专用工作区则迁出；**有短暂闪烁，无法阻止用户手动移动** |
| 4. 退出销毁 | ✅ | 移回原工作区后变空；固定模式下显式 `remove_workspace`，动态模式下交给 mutter |

### 关键设计决策

**D1：优先用现成相邻空工作区，还是每次新建？**
→ 用户选：**优先现成**（固定 4 个工作区，通常有空位）。没有空位才新建并在退出时删除。

**D2：专有工作区如何标记？**
→ 用 `Map<workspace, { winId, originWs, originIndex }>` 记录，键是**工作区对象**（不是索引，索引会变）。

**D3：独占如何维持？**
→ 监听 `global.display` 的 `window-created`；若新窗口落在专用工作区，用 `win.change_workspace()` 移到最近的非专用工作区。
→ **限制**：无法阻止用户手动移动；不做 `window-workspace-changed` 监听以免死循环。

**D4：与 AutoMove 的互斥**
→ AutoMove 替换 `_checkWorkspaces` 保留尾部空工作区，与删除冲突。
→ 解决：**全屏专用工作区启用时不新建工作区**（只用现成空工作区），彻底避开冲突；仅在无空工作区时才新建，且删除前检查 AutoMove 是否启用。

**D5：删除工作区的安全条件**
→ 必须同时满足：
- 该工作区是**我们创建的**（不在 map 里则不删）
- 该工作区**只包含 0 个窗口**（窗口已移走）
- 工作区总数 > 2（mutter 的 `MIN_NUM_WORKSPACES`）
- 包在 try/catch 里，失败就保留

## 七、风险清单

| 级别 | 风险 | 缓解 |
|---|---|---|
| 🔴 高 | `remove_workspace` 删错工作区 → 用户窗口丢失 | 只删"我们创建且为空"的工作区；先移窗口再删；总数 > 2 |
| 🔴 高 | 与内置 AutoMove 的 `_checkWorkspaces` hook 冲突 | 互斥：AutoMove 启用时全屏功能不新建/删除工作区 |
| 🔴 高 | **事件循环 / 工作区来回弹跳** | 见下方第八节，专门的防重入设计 |
| 🟡 中 | `reorder_workspace` 后索引失效 | 始终用**对象**引用而非索引 |
| 🟡 中 | 独占被用户手动操作破坏 | 明确告知无法强制；不做激进纠正以免闪烁/死循环 |
| 🟡 中 | 窗口 `destroy` 时 `meta_window` 失效 | `_restore` 全程 try/catch，用 `record` 里的数据而非重新查询 |
| 🟢 低 | 多显示器 / workspaces-only-on-primary | 只在主显示器处理（`_primaryOnly` 检查） |
| 🟢 低 | 固定模式下空工作区越积越多 | 退出时清理我们创建的；用户现有的空工作区不动 |

## 八、防循环设计（最高优先级要求）

### 8.1 循环是怎么产生的

`change_workspace()` 会触发 `size-change` / `map` 等信号，我们的回调又可能再次调用 `change_workspace()`，形成：

```
size-change(FULLSCREEN) → _place() → win.change_workspace(wsB)
    → 触发 size-change → _place() → change_workspace(wsC) → ...
```

同理 `_restore()` 会触发 `UNFULLSCREEN` 的后续事件，可能再次进入 `_restore()`。

### 8.2 四层防护

**防护 1：全局重入锁**
```js
this._busy = false;
_place(win) {
    if (this._busy) return;
    this._busy = true;
    try { ... } finally { this._busy = false; }
}
_restore(act) {
    if (this._busy) return;
    this._busy = true;
    try { ... } finally { this._busy = false; }
}
```

**防护 2：幂等检查 —— 已在目标状态就什么都不做**
- `_place`：若窗口已独占某个工作区（该工作区只有它一个普通窗口）→ 直接 return
- `_restore`：若窗口已在记录的原工作区 → 只做清理，不再移动

**防护 3：状态标记优先于计算**
- 用 `this._windowState = new Map()` 记录 `winId -> { originWs, originIndex, dedicatedWs }`
- **只有** `_place` 成功移动后才写入状态
- `_restore` **必须**有状态才动作，且立即 `delete`，防止二次进入
- 没有状态的窗口，`_restore` 一律忽略

**防护 4：事件源过滤**
- 只处理 `window_type === Meta.WindowType.NORMAL`
- 跳过 `is_always_on_all_workspaces()` 的窗口
- 只在 `primaryOnly` 时校验 monitor
- 对 `destroy` 事件走单独的轻量路径（只清理状态 + 激活原工作区，不做工作区操作）

### 8.3 关键规则

1. **绝不监听 `window-workspace-changed`** —— 这是最容易成环的信号（我们改工作区会触发它）
2. **绝不在 `_restore` 里调用 `remove_workspace` 之后再做任何工作区操作**
3. **`_place` 与 `_restore` 共用同一个 `_busy` 锁**，避免交叉触发
4. **`destroy` 路径不移动窗口**（窗口已销毁，移动无意义且易崩）

### 8.4 验证方法

- 压测：连续快速触发全屏/退出全屏 20 次，确认工作区数不增长、无堆栈溢出
- 日志：`_place` / `_restore` 各打一条带 `busy` 状态的日志，若出现连续同窗口重复调用即异常
