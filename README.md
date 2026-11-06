# Open Gnome Box

一个面向 GNOME Shell（45–50）的整合型桌面增强扩展：顶栏/菜单主题、指示器管理、
剪贴板历史、全屏专用工作区、壁纸轮换等能力集中在一个扩展里。

## ⚠️ 关于原创性（请先读这一段）

**本项目不是原创作品。** 扩展的主体（主题引擎、设置界面与大部分面板能力）**fork 自
[Open Bar](https://extensions.gnome.org/extension/6580/open-bar/)**；其它功能也是把
社区已有扩展**移植、整合、汉化并做了改进与问题修复**，而非重新发明。代码与设计上的
功劳属于下述原作者：

| 功能 | 来源 |
|---|---|
| 主题引擎、面板/菜单样式、设置界面（整体基础） | **Open Bar**（fork） |
| 壁纸轮换（托盘控制、动态壁纸、收藏加权） | **Wallhub**（`wallhub@sakithb.github.io`） |
| 指示器分组（Lilypad 式折叠分组） | **Lilypad**（`lilypad@shendrew.github.io`，GPL-3.0） |
| 全屏专用工作区 | **fullscreen-to-empty-workspace2**（`fullscreen-to-empty-workspace2@corgijan.dev`） |
| Auto Move Windows、驱动器菜单等 | 来自 GNOME Shell 官方扩展集的思路与实现 |
| 电池自动隐藏、状态区间距、四指手势 | 整合自社区扩展（随 Open Bar 一并带入） |
| 剪贴板历史管理 | 移植整合自社区剪贴板管理扩展的思路与实现 |

本项目的工作主要是：把这些能力合并到一个扩展里、适配 GNOME 45–50、补中文翻译、
修 bug 与做局部增强。**如果只需要其中某一项功能，优先使用对应的原版扩展。**

## 功能一览

### 外观与主题
- 顶栏/面板样式：多种形态（Mainland / Floating / Islands / Trilands）、颜色、渐变、
  圆角、边框、霓虹光晕、阴影，支持独立设置窗口最大化时的顶栏样式
- 菜单样式：日期菜单、快捷设置，以及（可选）全 Shell 弹出菜单统一配色
- Dash / Dock 样式、GTK3/GTK4 应用主题（自动备份原配置）与 Flatpak 全局主题覆盖
- 自动取色：从当前壁纸提取配色生成主题；支持跟随 GNOME 强调色
- 自定义字体与字号

### 面板与指示器
- 指示器分组：把多个托盘图标折叠进一个可展开按钮（Lilypad 式）
- 状态区间距、电池/电源指示器自动隐藏（充电/满电/阈值）
- Fitts 定律热区：无需精确瞄准面板按钮
- 窗口最大化时顶栏样式联动

### 桌面效率
- Auto Move Windows：按 `应用:工作区` 规则自动把新窗口送到指定工作区
- 四指触摸板手势映射为工作区切换（可三/四指互换）
- 驱动器菜单：挂载/卸载移动存储
- 剪贴板历史：搜索、置顶、标签、图片、快捷键、私有模式
- 设置备份与导入/导出（JSON 文件）

### 窗口与工作区
- 全屏专用工作区：全屏窗口自动独占一个新的工作区，退出全屏后归还并清理；
  非属主窗口无法停留在专用工作区内

### 壁纸轮换
- 顺序 / 加权随机两种轮换模式，随机模式下收藏壁纸权重可调（1–10 倍）
- 托盘控制：上一张 / 下一张 / 随机 / 收藏 / 暂停，悬停预览下一张
- 支持 GNOME 原生动态壁纸（`.xml`），自动排除其内部时间帧
- 记住上次轮换位置，重启后接续而不是从头开始

## 安装

### 推荐：下载 Release 安装包

从本仓库的 Releases 页面下载 `opengnomebox@lyf.shell-extension.zip`，然后：

```bash
gnome-extensions install --force opengnomebox@lyf.shell-extension.zip
```

安装后**注销并重新登录**（Wayland 必需；Xorg 可用 `Alt+F2` → `r` 重启 Shell），
再在「扩展」应用（或 `gnome-extensions enable opengnomebox@lyf`）中启用。

### 手动安装

把仓库中的 `opengnomebox@lyf` 目录复制到：

```
~/.local/share/gnome-shell/extensions/opengnomebox@lyf/
```

目录名必须与扩展 uuid（`opengnomebox@lyf`）一致。同样需要重新登录后启用。

> 注意：扩展目录需完整复制（含 `schemas/`、`media/`、`locale/` 等），
> 不要用 `gnome-extensions pack` 自行打包——它会漏掉资源文件。

## 兼容性

- GNOME Shell **45 – 50**
- 与其它顶栏/主题类扩展可能冲突（扩展内置了常见冲突检测）
- 启用后会改写 `~/.config/gtk-3.0/gtk.css`、`~/.config/gtk-4.0/gtk.css`
  （原文件自动备份为 `gtk_backup_byOpenBar.css`）以及 Flatpak 全局主题覆盖，
  这是主题功能的设计行为

## 许可

- 本项目整体：**GPL-2.0-or-later**
- `lilypad.js` / `lilypadPrefs.js`（移植自 Lilypad）：**GPL-3.0-or-later**
- 各上游项目的版权归其原作者所有，详见上方来源表

## 截图

![Screenshot](screens/github0.png)
![Screenshot](screens/github1.png)
![Screenshot](screens/github2.png)
