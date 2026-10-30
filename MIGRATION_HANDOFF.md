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

## 3. Git 状态

```
HEAD = 466a5a5  feat(integrations): refuse to run alongside the standalone extension
工作树干净
```

remotes（**已按用户要求调整完毕**）：

| remote | 仓库 | 说明 |
|---|---|---|
| `origin` | `https://github.com/luyanfeng/openGnomeBox.git` | **新插件仓库，主力。`main` 已跟踪 `origin/main`** |
| `oldbar` | `https://github.com/luyanfeng/openbar.git` | 原插件仓库，仅留作参考 |

裸 `git push` 现在直接进新仓库。`oldbar` 只读参考，不要再往里推。

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

## 5. 本地安装状态

- **新插件已安装并启用**：`~/.local/share/gnome-shell/extensions/opengnomebox@lyf`，
  在 `enabled-extensions` 里，状态 ACTIVE。
- **旧插件已不存在**：`openbar@neuromorph` 目录在重登后已消失，`disabled-extensions`
  里的残留项已清掉。旧插件的 dconf 配置仍在 `/org/gnome/shell/extensions/openbar/`，
  **已全量迁移**到 `/org/gnome/shell/extensions/opengnomebox/`（133 项，key 与类型
  完全一致，无缺失）。备份在 `~/.config/dconf-backup-openbar-to-opengnomebox-*/`。

改完代码后同步到安装目录（**代码 + schema 必须同一批**）：
```bash
cd <工作目录>/opengnomebox@lyf
glib-compile-schemas schemas/
D=~/.local/share/gnome-shell/extensions/opengnomebox@lyf
cp *.js "$D/"
cp schemas/*.xml schemas/gschemas.compiled "$D/schemas/"
cp locale/zh_CN/LC_MESSAGES/opengnomebox.{po,mo} "$D/locale/zh_CN/LC_MESSAGES/"
diff -rq . "$D" | grep -v 'Only in'   # 应为空
```
`prefs.js` / schema / 翻译改完重开偏好窗口即可；**`*.js`（extension 侧）必须注销重登**。

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
   - 键盘/菜单移动跳过专用区；全屏窗口被移出自己的专用区 → 弹回原区 + 提示
   - 缩略图置灰 + 红框用 `_contents.opacity`（`set_style('opacity')` 无效），
     **只是视觉标记，不代表拖放被拒**
   - **已知无法实现**：拖放阶段无法拒绝（无禁止光标、无红框反馈），拖拽本身会成功，
     事后由 `_evict` 沿行进方向把窗口挪到下一个非专用区；拖出全屏窗口的专用区也只能
     松手后弹回。`045674f` 已把 `NO_DROP` / `acceptDropInternal` /
     `handleDragOverInternal` / `beginWindowDrag` patch 全部删除，**代码里没有残留**。
     根因：`WindowPreview` 每次开概览重建，禁用到的是旧实例。
4. **日志页**（偏好页）
   - 扩展错误：`Gio.DBus` 调 `ListExtensions` + `GetExtensionErrors`
   - Shell 日志：`journalctl -b _COMM=gnome-shell`，带过滤、行数选择、复制
   - 超过约 1MB 自动截断
5. **中文翻译**：`locale/zh_CN/LC_MESSAGES/opengnomebox.{po,mo}`，95 条，
   在 `fillPreferencesWindow()` 和 `enable()` 里显式调 `initTranslations()`。
   **本机没有 `msgfmt`**，用 `python3` 的纯标准库脚本编译 `.mo`
   （GNU MO 格式很小，脚本见下）；改完 `.po` 必须重编 `.mo` 并同步到安装目录。
6. **与独立扩展互斥**（`conflicts.js`）
   - Ubuntu 26.04 把 gnome-shell-extensions 套装作为**系统级**扩展装在
     `/usr/share/gnome-shell/extensions`，所以「Auto Move Windows」「Removable
     Drive Menu」可能已从系统侧启用。
   - `conflicts.js` 存「设置键 → 独立扩展 uuid」映射，仅依赖 Gio/GLib
     （prefs 在独立 gjs 进程里，不能导入 shell UI 模块）。
   - 偏好页：拨开关时若独立扩展已启用 → 弹窗「只能启用其中一个」；取消则不写 key，
     确认则先 `DisableExtension` 并**确认真的停用**才写 key。
   - 运行时：**一律让位**，绝不停用别人的扩展。key 为 true 但独立扩展也开着
     （启动时/外部 gsettings 写入）→ 把 key 写回 false 并告警。

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

## 11. 迁移已完成（本节的检查清单已执行完毕）

以下均已完成，仅留作记录：

1. 工作目录已在 `~/IdeaProjects/lyf/ai/openGnomeBox`（`~/IdeaProjects` 是
   `Documents/IdeaProjects` 的软链接，同一目录）。
2. 扩展代码目录为 `opengnomebox@lyf/`。
3. remote 已整理：`origin` = 新仓库，`oldbar` = 旧仓库（只读参考）。
4. 新插件已安装、已启用、旧插件已移除。
5. dconf 配置已全量迁移（133 项）。
6. 已修 `integrations.js` 里 `045674f` 遗留的失效调用，以及 `_shouldPlace()` 的
   `fullscreen-maximized-too` 反向逻辑。
7. 已加 `conflicts.js`：与系统级 Auto Move Windows / Removable Drive Menu 互斥。

**新会话开始时只需**：读 AGENTS.md 的「数据流」「必须知道的坑」「全屏专用工作区」
三节，然后确认 `git status` 干净、`git log --oneline -1` 与远端一致即可开工。
