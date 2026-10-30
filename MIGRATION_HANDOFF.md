# 迁移交接文档（给下一个会话的自己）

写于 2026-10-30。用户即将把工作目录改名并重启会话，届时你没有本轮对话的记忆。
**先读完本文件再动手。**

---

## 1. 项目是什么

GNOME Shell 扩展，纯 GJS，无构建系统、无 lint、无测试框架。CI 只有一个打包 workflow。

**本轮已完成一次改名**：从 `openbar@neuromorph`（Open Bar）fork 成
`opengnomebox@lyf`（Open Gnome Box），作为**独立新插件**存在，可与原插件共存。

## 2. 目录变更（用户正在做）

| | 迁移前 | 迁移后（预期） |
|---|---|---|
| 工作目录 | `~/Documents/IdeaProjects/lyf/ai/openbar` | `~/Documents/IdeaProjects/lyf/ai/openGnomeBox` |
| 扩展代码目录 | `openbar@neuromorph/` | **`opengnomebox@lyf/`**（已在改名提交里完成） |

**如果新目录里还是 `openbar@neuromorph/`，说明用户的移动没成功或移动错了版本，
先确认再动手，别假设。**

## 3. Git 状态（迁移前的确切状态）

```
HEAD = 70f0094  refactor: rename to Open Gnome Box (opengnomebox@lyf)
工作树干净
```

remotes：

| remote | 仓库 | 说明 |
|---|---|---|
| `origin` | `https://github.com/luyanfeng/openbar.git` | 原插件仓库，最后提交是改名前的 `f071211` |
| `newbox` | `https://github.com/luyanfeng/openGnomeBox.git` | **新插件仓库，`main` 已推送（含 70f0094）** |

**注意**：`origin` 指向旧仓库，`newbox` 指向新仓库。默认 push 会去 `origin`
（旧仓库）——**推代码前务必确认推到哪个**，别把新代码推到旧仓库。

用户可能希望：把 `origin` 改成新仓库，或继续用 `newbox`。**先问，别自己改 remote。**

## 4. 改名改了什么（已完成，不要重做）

| 项目 | 新值 |
|---|---|
| uuid | `opengnomebox@lyf` |
| settings-schema | `org.gnome.shell.extensions.opengnomebox` |
| schema path | `/org/gnome/shell/extensions/opengnomebox/` |
| enum id | `org.gnome.shell.extensions.opengnomebox.slideshow-interval-units` |
| 运行时目录 | `io.github.neuromorph.opengnomebox` |
| gettext-domain | `opengnomebox`（`locale/zh_CN/LC_MESSAGES/opengnomebox.{po,mo}`） |
| 显示名 | Open Gnome Box |
| version | 1 |

**有意保留、不要改**：
- CSS class `openbar`（`stylesheets.js` 的 `openbarClass = '.openbar'` 与
  `extension.js` 的 `add_style_class_name('openbar')`）。是本扩展样式表内部标识，
  不会与其他扩展冲突，改名只会破坏选择器耦合。
- `/*** Open Bar GTK CSS ***/ ` 标记。写入和检测都用这个字符串，改名会让**已安装
  用户的 gtk.css 备份无法被识别还原**。

## 5. 本地安装状态（重要）

- **旧插件仍安装并启用**：`~/.local/share/gnome-shell/extensions/openbar@neuromorph`，
  在 `enabled-extensions` 里。
- **新插件尚未安装**：`~/.local/share/gnome-shell/extensions/opengnomebox@lyf` 不存在。

所以用户现在跑的还是旧的 Open Bar。要测新插件必须安装：
```bash
cd <新工作目录>/opengnomebox@lyf
glib-compile-schemas schemas/
cp -r . ~/.local/share/gnome-shell/extensions/opengnomebox@lyf
gnome-extensions enable opengnomebox@lyf
```
**两个插件可以共存**（uuid 不同），但都改 panel 样式，同时启用会打架，
建议测新插件时先禁用旧的。

## 6. 绝对不能忘的教训（都踩过）

### 6.1 覆盖本地扩展目录必须同步 schema
上一轮曾因 `cp -r` 只覆盖 `extension.js` 而没同步 `gschemas.compiled`，
运行中的 gnome-shell 读新代码 + 旧 schema，缺 key → **SIGABRT 崩溃，会话重启**。
**永远同批复制：代码 + `schemas/gschemas.compiled` + `schemas/*.xml`。**

### 6.2 GNOME 50 / Wayland 无法热重载 JS
- `disable`→`enable` 复用已加载的 ES module，**不加载新代码**
- `ReloadExtension` 返回 `deprecated and does not work`
- 卸载重装也没用（模块缓存在进程内存）
- `Alt+F2 r` 在 Wayland 不可用
- **唯一可靠方式：注销重登。不要执行 reboot/shutdown/logind/kill gnome-shell**，
  用户明确要求过不要擅自重启。只提醒用户自己重登。

### 6.3 `prefs.js` 的改动不需要重登
偏好窗口每次打开都重新加载。改 `prefs.js` 后让用户重开偏好窗口即可。

### 6.4 不要猜 API（本轮反复出错）
踩过的坑，全部确认过：

| 错误用法 | 正确做法 |
|---|---|
| `St.Align.MIDDLE` | `Clutter.ActorAlign.CENTER` |
| `Meta.Workspace.equal()` / `equals()` | 用 `===` 或 `.index()` 比较 |
| `Gtk.ListItem.get_position()` | GTK4 没有，用 `get_item()` |
| `Gtk.Image.set_from_icon_name` | GTK4 用 `set_from_gicon` |
| `St.Label` 的 `text_align` | 不存在 |
| `ClutterText.set_font_size()` | 不存在，用 `font-name`（如 `'Sans 20'`） |
| `St.Bin.child = St.ImageContent` | 只接受 ClutterActor，ImageContent 挂 `St.Widget.content` |
| `Meta.Display` 的 `workspace-changed` | 是 **`Meta.Window`** 的信号 |
| `Gio.Settings.bind()` 绑 int 键到 `Adw.SpinRow.value`（double） | **静默失败**，用 `notify::value` 手工写 |
| patch `Meta.Window.prototype` | GI 原型，赋值不可靠 |
| 重赋值 `Main.moveWindowToMonitorAndWorkspace` | ES module 导出是只读绑定 |

**正确方法：先 grep `libshell-18.so` / mutter typelib 确认名字和归属，再写代码。**

### 6.5 用 `str.replace` 批量改代码要小心
曾用 Python `replace` 时 oldString 匹配到多处，把 `integrations.js` 从 1672 行
写成 98 万行。**改大段代码前先备份、用 `edit` 工具或带断言的精确替换，
改完立刻 `wc -l` + `node --check`。**

## 7. 本项目已实现的功能清单

### 原始功能（Open Bar 自带）
顶栏/面板/菜单/Dash/GTK 主题化。核心链路：
- `extension.js` → `enable()` 读 GSettings、加 CSS class、调 `StyleSheets.reloadStyle`
- `stylesheets.js` → `getStylesheet()` 把 280+ 设置拼成整份 CSS，写入
  `$XDG_RUNTIME_DIR/.../stylesheet.css` 再由 `St.ThemeContext` load
- `prefs.js` → Adw 偏好页，改设置只翻转 `trigger-reload` 键

### 本轮新增
1. **Wallhub 壁纸幻灯片**（`wallhub.js`）
   - 顶栏托盘图标 + 菜单：上一张/下一张/随机/暂停/设置
   - 下一张预览图（悬停切换预览）
   - 支持 GNOME 原生动态壁纸 `.xml`（直接设 `picture-uri` 交给 GNOME 播放）
   - 默认预览显示**当前桌面壁纸**
2. **五个小扩展内建**（`integrations.js`）
   - Battery 自动隐藏、状态区间距、Auto Move Windows、四指手势、可移动驱动器菜单
   - Auto Move 的「应用」用下拉选（`Gio.AppInfo.get_all()`），规则工作区可编辑
3. **全屏专用工作区**（macOS Space 风格）
   - 全屏 → 新建相邻专用工作区；退出 → 回原工作区并删除专用区
   - 键盘移动跳过专用区；概览拖入被拒（`NO_DROP` + 红边框）；拖出被弹回 + 提示
   - 缩略图置灰用 `_contents.opacity`（`set_style('opacity')` 无效）
   - **已知无法实现**：专用区窗口在概览中仍能发起拖拽（`WindowPreview` 每次开概览
     重建，禁用到的是旧实例；patch `beginWindowDrag` 也无效）。纯视觉问题。
4. **日志页**（偏好页）
   - 扩展错误：`Gio.DBus` 调 `ListExtensions` + `GetExtensionErrors`
   - Shell 日志：`journalctl -b _COMM=gnome-shell`，带过滤、行数选择、复制
   - 超过约 1MB 自动截断
5. **中文翻译**：`locale/zh_CN/LC_MESSAGES/opengnomebox.{po,mo}`，88 条，
   在 `fillPreferencesWindow()` 和 `enable()` 里显式调 `initTranslations()`

## 8. 关键架构约束（改代码前必读）

- **设置键全按字符串访问，无类型检查**：新增/改名设置要同时改
  gschema XML、`prefs.js` 控件、读取处（`stylesheets.js` / `extension.js` /
  `integrations.js`）。漏改不报错，静默取默认值。
- **生命周期必须对称**：`enable()` 里 connect 的信号/定时器，`disable()` 必须断开/清除。
- **防循环**（全屏功能）：`_lock()` 250ms 定时释放（不能用 `finally` 立即释放），
  幂等检查，状态表优先；**绝不监听 `window-workspace-changed`**。
- **不要依赖 mutter 自动清理空工作区**：`_checkWorkspaces` 把 active 工作区视为非空，
  且只保证末尾有一个空工作区。必须显式 `remove_workspace`，顺序是
  「移窗口 → 切回原工作区 → 再删除」。
- 扩展会写用户真实配置：`~/.config/gtk-3.0/gtk.css`、`gtk-4.0/gtk.css`、
  `~/.local/share/flatpak/overrides/global`。启用/禁用即改写。
  `import-export` 或 `pause-reload` 为 true 时样式不生效。

## 9. 验证命令

```bash
cd <工作目录>/opengnomebox@lyf

# 语法（每个改过的 .js 都跑）
for f in *.js; do node --input-type=module --check < "$f" || echo "FAIL $f"; done

# schema（改了 XML 必须重编，否则键不生效）
glib-compile-schemas --strict schemas/

# 确认 key 可读
GSETTINGS_SCHEMA_DIR=schemas gsettings get \
  org.gnome.shell.extensions.opengnomebox fullscreen-new-workspace

# 看运行日志
journalctl --user -b -n 100 | grep -iE "Open Gnome Box|opengnomebox"

# 扩展状态
gnome-extensions info opengnomebox@lyf
```

## 10. 工作习惯（用户明确要求过）

- **每次改完代码就提交 git**，不要攒着。
- **不要擅自执行重启/注销/kill gnome-shell**。只能提醒用户自己重登。
- 用中文回复，简洁直接。
- 不确定就查证，不要猜（本轮因猜 API 反复返工）。
- `.planning/` 已加入 `.gitignore`，pwf 计划文件不入库。

## 11. 迁移后第一件事

用户改名目录并重启会话后，建议按顺序确认：

1. `pwd` 确认新路径，`ls` 确认有 `opengnomebox@lyf/`
2. `git log --oneline -1` 确认还是 `70f0094`
3. `git remote -v` — **确认推代码前目标仓库正确**（`origin` 是旧仓库！）
4. `git status` 确认工作树干净
5. 问用户接下来做什么（安装新插件测试？继续开发？）
