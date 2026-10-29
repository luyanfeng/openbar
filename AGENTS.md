# AGENTS.md

GNOME Shell 扩展（Top Bar / 菜单 / Dash / GTK 主题）。纯 GJS，**无**构建、打包、lint、测试工具链：没有 `package.json` / `Makefile` / CI。

## 目录与分支
- `openbar@neuromorph/` 是唯一的安装单元，目录名必须等于 `metadata.json` 的 `uuid`。
- `patches/` 是历史单文件快照，代码中无任何引用；不要在这里改功能，真实代码只在 `openbar@neuromorph/`。
- 分支：`main` = GNOME 45–50；`g42-44` = 旧版 GNOME 42–44，勿在 `main` 上兼容 42–44。
- GNOME 50 对 `extension.js` 无破坏性变更（官方升级指南确认）。新增支持只需在 `metadata.json` 的 `shell-version` 加入 `"50"`；代码里的版本判断都用相对比较，50 自动落入正确分支（含 49 的 DND 按钮布局修复）。

## 验证
- 语法检查（仓库唯一的自动化检查，无 ESLint）：
  `node --input-type=module --check < openbar@neuromorph/extension.js`
  对每个改动过的 `.js` 各跑一次。
- 改了 schema XML 必须重编，否则设置键不生效：
  `glib-compile-schemas openbar@neuromorph/schemas/`（`gschemas.compiled` 已入库，需一并提交）
- 运行时只能手动验证：软链/克隆到 `~/.local/share/gnome-shell/extensions/openbar@neuromorph` → Wayland 重新登录、Xorg `alt+f2` 输入 `r` → 跟踪日志
  `journalctl -f -o cat /usr/bin/gnome-shell`（排错用 `SHELL_DEBUG=all`）。偏好窗口可用 `gnome-extensions prefs openbar@neuromorph`。

## 数据流（改样式前先读这条）
- `extension.js`：`enable()` 读 GSettings → 给 panel / panelBox 等加 CSS class（如 `openbar`）→ 调用样式生成；负责所有信号与窗口事件。
- `stylesheets.js`：`getStylesheet()` 把 280+ 个设置项拼成**整份 CSS 字符串**，写入 `$XDG_RUNTIME_DIR/io.github.neuromorph.openbar/stylesheet.css`，再由 `St.ThemeContext` load；同一流程还会生成 GTK 主题和 Flatpak override。
- `prefs.js`：Adwaita 偏好页。修改设置后只翻转 `trigger-reload` 布尔键来通知扩展重载，**不直接调用扩展代码**（扩展侧监听该键）。
- `autothemes.js` 从壁纸取色生成主题，`quantize.js` 是 MMCQ 取色实现，`utils.js` 是颜色/亮度计算。`prefs.css` 只作用于偏好窗口。

## 必须知道的坑
- 扩展会写用户真实配置：`~/.config/gtk-3.0/gtk.css`、`~/.config/gtk-4.0/gtk.css`（原文件备份为 `gtk_backup_byOpenBar.css`）和 `~/.local/share/flatpak/overrides/global`。启用/禁用即触发改写，别在无关任务里随手 enable。
- `import-export` 或 `pause-reload` 为 true 时，`reloadStyle()` / `saveGtkCss()` 直接 return；样式改了不生效先查这两个键。
- 样式生效链路是两段：重写 CSS 文件 + 翻转 `reloadstyle` 键让 St 重新加载。只写文件不够。
- 设置键全按字符串访问，无类型检查：新增/改名设置要同时改 gschema XML、`prefs.js`（控件）、`stylesheets.js` / `extension.js`（读取处）。漏改不报错，只静默取默认值。
- CSS 中的图标 `url()` 指向运行时目录的 `assets/`（启动时从 `media/assets` 复制），新增图标放 `media/assets`。
- CSS 选择器与 `extension.js` 添加的 class 强耦合，改一边要同步另一边。
- `metadata.json` 由 extensions.gnome.org 生成（`_generated` 字段）：`version` 由 EGO 分配，不要手改。
- 导入/导出设置走 `dconf dump|load /org/gnome/shell/extensions/openbar/`（键值文本），不是 JSON。
- 代码风格沿用现状：4 空格缩进、分号、注释英文、UI 文案用 `_()` 包裹。
