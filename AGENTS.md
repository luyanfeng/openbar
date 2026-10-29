# AGENTS.md

GNOME Shell 扩展（Top Bar / 菜单 / Dash / GTK 主题）。纯 GJS，无构建系统、无 lint/测试框架（没有 `package.json` / `Makefile`）。CI 只有一个打包 workflow（`.github/workflows/package.yml`）。

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

### 隔离沙箱（首选运行时验证方式）
在**完全不碰用户真实会话**的前提下加载扩展。全程产物落在临时目录：
```bash
H=/tmp/sb; mkdir -p $H/{config/glib-2.0/settings,data,cache,runtime}; chmod 700 $H/runtime
GSETTINGS_BACKEND=keyfile XDG_CONFIG_HOME=$H/config XDG_DATA_HOME=$H/data \
XDG_CACHE_HOME=$H/cache XDG_RUNTIME_DIR=$H/runtime gnome-extensions install --force --print-uuid ext.zip
printf "[org/gnome/shell]\nenabled-extensions=['openbar@neuromorph']\n" > $H/config/glib-2.0/settings/keyfile
dbus-run-session -- gnome-shell --headless --virtual-monitor 1920x1080 \
  --wayland-display sbdisp --no-x11 --automation-script drive.js
```
- 必须 `dbus-run-session`：否则会连到真实会话的 `org.gnome.Shell` 并报 `already exists on bus`。
- 必须 `GSETTINGS_BACKEND=keyfile`：否则读写用户真实 dconf。
- `--automation-script` 是 **ES module**，导出 `export async function run()`；脚本内用
  `Main.extensionManager.lookup('openbar@neuromorph')` 拿 `{state, error, stateObj}`，
  `stateObj` 即扩展实例，可直接调 `updatePanelStyle` / `applyMenuStyles` / `setWindowMaxBar`
  等方法覆盖真实会话才走的分支。
- shell 退出时会打印 `mainloop.h ... assertion failed` 并以 134 退出，这是 perf harness
  收尾行为，**不是崩溃**。
- `--headless` 无法复现真实硬件合成器与其它扩展共存的情况；最终仍需用户在真机手动启用确认。

### 真机验证纪律
- **绝不** 向运行中的 `gnome-shell` 发 `SIGTERM` / `SIGHUP` / `kill` 来强制它重扫扩展目录。
  Wayland 会话会失去合成器输出直接黑屏（已发生过）。新装扩展要么经 Extensions 应用启用，
  要么让用户自己重启/注销。
- 安装用 `cp -r` 或 `gnome-extensions install`，不要用符号链接指向工作区。
- 启用后核查：`gnome-extensions info <uuid>`（状态 ACTIVE）、
  `GetExtensionErrors` 返回 `@as []`、`$XDG_RUNTIME_DIR/io.github.neuromorph.openbar/stylesheet.css`
  已生成、`journalctl --user` 无 `JS ERROR` / `Gjs-CRITICAL`、shell pid 未变。

## 发版

发布走 GitHub Releases，不再提交到 extensions.gnome.org。

1. 改 `openbar@neuromorph/metadata.json` 的 `version`，从当前值 +1（这是发布序号，不是语义化版本；历史 38→39→41→42→43）。
2. 提交并推送 `main`。
3. 打 tag 并推送，tag 名必须等于新版本号（允许 `v` 前缀）：
   ```bash
   git tag -a v43 -m "Open Bar 43: <摘要>" && git push origin v43
   ```

CI（`.github/workflows/package.yml`）行为：
- `push` 到 `main` 或 `PR` → 只构建并上传 artifact `openbar-extension-zip`，不动 Release。
- `push` tag → 额外把 zip 附到该 tag 的 Release，并用「Verify tag matches metadata version」校验 tag 名与 `version` 一致，不一致直接 fail。
- Job 需要 `permissions: contents: write`，否则第 9 步 `Attach zip to release` 会因默认只读 token 失败。

打包必须用 `zip -r`，**不要**用 `gnome-extensions pack`：后者只收集入口文件和 schema，会静默漏掉 `stylesheets.js` / `autothemes.js` / `quantize.js` / `utils.js` / `prefs.css` / `media/`，打出来的包装上就是坏的；而且它依赖 gnome-shell 环境，GitHub runner 上默认没有。workflow 里有显式清单校验（9 个必需条目 + uuid 匹配）防止回归。

已在 Release 上的 tag 若要重发，需先删远端 tag 再重建指向修复后的 commit：
```bash
git push origin :refs/tags/v43
git tag -a v43 -m "..." <commit> && git push origin v43
```

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
- `metadata.json` 的 `_generated` 字段来自 extensions.gnome.org，不要动。但 `version` 现在**由本仓库手动维护**（改走 GitHub Releases 发布后不再由 EGO 分配），见下方「发版」。
- 导入/导出设置走 `dconf dump|load /org/gnome/shell/extensions/openbar/`（键值文本），不是 JSON。
- 生命周期必须对称：`enable()` 里 `connect` 的信号/定时器，`disable()` 必须断开/清除。历史上
  `_settings.connect('changed')` 未断开，导致 disable 后 `_settings = null` 仍被回调解引用报错。
- `applyMenuStyles()` 的 DateMenu 分支里 `clearBtn` 靠 `let` 在 if/else 外声明；曾经误用
  `const` 声明在分支块内，使 GNOME 49/50 直接 `ReferenceError` 无法启用。
- 代码风格沿用现状：4 空格缩进、分号、注释英文、UI 文案用 `_()` 包裹。
