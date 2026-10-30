# Findings: Open Bar 质量审查

审查日期：2026-10-30。方法：主 agent 直接静态审查（explorer 子代理因免费额度失败）。
范围：schema-code 一致性、生命周期/资源泄漏、Wallhub 集成完整性、错误处理规范。

## 专项① schema 与代码一致性
用 gjs 的 `SettingsSchema.has_key` 对 290 个 schema key 与代码访问逐一核对。
- ✅ 所有代码中访问的 key 在 schema 均存在（含新增 wallpaper-paths / wallpaper-paths-selected / slideshow-interval-unit / slideshow-interval）。
- ✅ 动态拼接 key 边界匹配：candy1..16、palette1..12、count1..12、dark-palette1..12、light-palette1..12、prominent1..6 均在 schema 定义。代码循环 `i=1..16`（candy）/`i=1..12`（palette/count）不越界。
- ✅ enum nick 一致：slideshow-interval-unit 的 Hours/Minutes/Seconds 与 schema 完全相同。
- ⚠️ 上次崩溃根因：本地扩展目录 `gschemas.compiled` 与 `extension.js` 不同步（缺 bartype），非代码 bug。修复纪律已执行——覆盖本地目录必须同批复制编译产物。
- **结论**：无 schema 缺失导致的崩溃风险。主要风险仍是「部署时 schema/code 不同步」（流程问题，非代码）。

## 专项② 生命周期与资源泄漏
- ✅ ConnectManager.disconnectAll 覆盖全部 14 处 `this._connections.connect`。
- ✅ 裸 connect 均有清理路径：msgListIds（1720 断开）、_settingsSignalId（1811 断开）、disconnectWindowSignals（_windowSignals）、FittsWidget/btn 信号随 widget destroy 自动断。
- ✅ 定时器：enable 中 7 个 setTimeout 均在 disable 开头 clearTimeout（1656-1688）。
- ⚠️ 轻微：Openbar.enable 对 wallhub 无重入防护（见专项③）。

## 专项③ Wallhub 集成完整性（本次审查重点，发现 1 个真实 Bug）
- 🔴 **[高] 注入清理会丢失原函数**：`injectBackgroundMenu` 调用 `this.ext._injectToFunction(...)` 但未把返回值（原函数）存入 `this.ext._injections['_addBackgroundMenu']`。`removeBackgroundMenu` 调 `this.ext._removeInjection(Main.layoutManager, this.ext._injections, '_addBackgroundMenu')` 时，`_injections['_addBackgroundMenu']` 为 undefined → 走 `delete object[name]` 分支 → **删除注入包装器且原函数丢失**。后果：disable/重载后 `Main.layoutManager._addBackgroundMenu` 变成 undefined，任何新建背景（如插拔显示器、重新登录）会调用 undefined → TypeError → 可能崩溃。
  - 修复：注入时 `this.ext._injections['_addBackgroundMenu'] = this.ext._injectToFunction(...)`，使 _removeInjection 正确恢复原函数。已修复。
- 🟡 **[中] enable 无重入防护**：若扩展被重复 enable（如锁屏后解锁，或代码层再次调用），`this.wallhub = new WallhubManager(...)` 会覆盖旧实例且不清理，旧信号/monitor/loop 泄漏。
  - 修复：WallhubManager.enable 加 `if (this._enabled) return;` 守卫 + disable 置 `_enabled=false`。已修复。
- 🟡 **[中] 异步拒绝未捕获**：`updateQueue().catch` 已有，但 `changed::wallpaper-paths-selected` 回调里重新调 `updateQueue()` 未带 .catch；`startLoop` 内 `setWallpaper()`（async）未 await 也未 catch，运行时异常会变成未处理 Promise rejection（GNOME 下打印但不崩，但不洁）。
  - 修复：回调链补 .catch；setWallpaper 调用加 .catch。已修复。
- 🟢 **[低] 空路径/缺失文件**：`updateQueue` 对不存在的路径 `query_file_type` 会抛异常（仅在 async 内，被外层 catch 吞掉，丢失该源）；`setWallpaper` 对空 path 会写出 `file:///undefined`。
  - 修复：updateQueue 开头判空 + 跳过空项；setWallpaper 判空提前返回。已修复。
- ✅ disable 顺序安全：Openbar.disable 在 1803 先调 `wallhub.disable()` 再于 1811 断 `_settings`；wallhub.disable 只用 `this.settings`（=ext._settings 引用）在 disconnect 信号，且 1811 后才置 null，无悬空访问。
- ✅ directoryMonitors 在 disable 中 cancel 并清空；bgSettings 置 null。

## 专项④ 错误处理规范
- ℹ️ extension.js 41 处裸 `catch(e){}` 多为防御性（disable 清理路径），可接受；但部分业务路径（如 updateBguri 信号回调）吞异常可能掩盖样式未更新。建议保留现状（避免改动面过大）。
- ✅ updateBguri 对颜色方案变化有保护；picture-uri 为空时 set_string('') 不会致命（GSettings 允许空串）。

## 已修复项汇总（本次提交前）
1. wallhub.js：注入原函数存储（防 _addBackgroundMenu 丢失）— 高危
2. wallhub.js：enable 重入守卫
3. wallhub.js：异步拒绝补 .catch（回调 + 轮播）
4. wallhub.js：updateQueue/setWallpaper 空值与缺失文件防护

## 验证
- 全量 JS 语法检查通过（node --check）
- glib-compile-schemas --strict 通过
- gjs 逻辑单测（WallpaperQueue 去重/出队、parseDynamicWallpaper、位掩码）通过
- gjs SettingsSchema.has_key 确认所有 key 存在
- 注：GNOME 50 headless --automation-script 有环境限制（main.js 无法作为 module 加载），完整运行时集成无法在沙箱跑通，需在真机启用实测。
