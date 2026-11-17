# 搬运分析：Date Menu Formatter + Compiz alike magic lamp effect

日期：2026-11-13
目标：把两个独立扩展的功能并入 `opengnomebox@lyf`，由 Open Gnome Box 首选项统一配置。
本机环境：GNOME Shell 50.1，gnomebox 支持 shell-version 45–50。

## 1. 源扩展现状

| | Date Menu Formatter | Compiz alike magic lamp effect |
|---|---|---|
| uuid | `date-menu-formatter@marcinjakubowski.github.com` | `compiz-alike-magic-lamp-effect@hermes83.github.com` |
| 版本 | 19 | 25 |
| 声明支持 | 45–50 | 45–51 |
| 代码量 | extension.js 328 行 + prefs 584 行 + formatters/lib/utils 6 文件（luxon.js 245 KB） | extension.js 486 行 + prefs 163 行 + settings_data.js |
| schema 键 | 15 | 4 |
| 当前状态 | INACTIVE | INACTIVE |
| GetExtensionErrors | `[]` | `[]` |

## 2. Date Menu Formatter

### 2.1 实现要点（源 extension.js）

- 面板定位：`panel.statusArea.dateMenu.get_children()[0]` 取 DateMenuButton 的内部容器。
- 插入自定义 `St.Label`（`style_class: 'clock'`）到 index 1，并 `remove_child(dateMenu._clockDisplay)`（:184-195）。
- 禁用时把 `_clockDisplay` 插回 index 1，移除并销毁自建 label（:197-213）。
- 文案由 `formatter.format(PATTERN, new Date())` 产出；异常时回落 `_clockDisplay.text` 并 `console.log`（:284-296）。
- 刷新节奏：`update-level` 0 = 60 s，1..7 = 1000/n ms（`PRIORITY_DEFAULT`），8..15 = 1000/n ms（`PRIORITY_HIGH`）（utils/general.js:22-32）。
- Dash to Panel 多面板：`global.dashToPanel.panels` 与 `apply-all-panels` 决定作用范围（:169-182）。
- `remove-messages-indicator`：额外移除 `dateMenu._indicator`（:149-166）。
- 三个 formatter：`01_luxon`（Luxon token）、`02_original`（SimpleDateFormat，16 KB）、`03_swatch`（Swatch Beats）。当前用户配置 `formatter='01_luxon'`。
- 用户当前 pattern：`MM月dd日 H:mm EEE`，`font-size=13`，`text-align='center'`，`apply-all-panels=false`。

### 2.2 搬运决策

| 项 | 决策 | 理由 |
|---|---|---|
| Luxon 依赖 | **原样 vendor `lib/luxon.js` → `luxon.js`**（245 KB，ESM，`export { DateTime, ... }`） | 保证 token 语义、时区、日历与非拉丁日历行为与现用配置完全一致；自行用 Intl 拼 token 必然在 `outputCalendar`／token 边界上产生差异 |
| formatter 选择 | 只保留 Luxon | 用户实际只用 `01_luxon`；`02_original` 依赖 16 KB 的 SimpleDateFormat 旧实现，`03_swatch` 是装饰性功能，均属死代码 |
| `remove-messages-indicator` | 不搬 | 与「格式化时钟」无关，且直接操作 `dateMenu._indicator` 私有成员，风险高于收益 |
| 4 个 `use-default-*` 布尔 + `custom-*` 字符串 | 收敛为 3 个字符串键，**空串 = 跟随系统** | 少 4 个键、少一半分支；语义等价 |
| `/etc/localtime` 监听、`org.gnome.desktop.datetime` 监听 | 不搬 | 每次格式化都重新解析系统时区/日历/语言，刷新周期内自然收敛 |
| `apply-all-panels` | 搬（键名 `date-menu-format-all-panels`） | Dash to Panel 共存能力保留 |
| 预览 | 搬到首选项 | 纯文本 pattern 没有预览基本没法用 |
| 日历选项表 | 放在 `prefs.js`（`calendarOptions()`） | 文案要过 gettext，而 gettext 在 `fillPreferencesWindow` 里才绑定，不能放模块级常量 |

### 2.3 依赖的私有 API（必须在真机确认）

- `Main.panel.statusArea.dateMenu.get_children()[0]`
- `Main.panel.statusArea.dateMenu._clockDisplay`

两者在 GNOME 45–50 一直存在，上游版本 19 明确声明支持 50。搬运实现中**显式检查**：缺失时 `console.error` 并保持不启用，不做静默降级。

## 3. Compiz alike magic lamp effect

### 3.1 实现要点（源 extension.js）

- patch `Main.wm._shouldAnimateActor`：调用栈含 `_minimizeWindow` / `_unminimizeWindow` 时返回 `false`，绕过 shell 自带最小化动画（:47-57）。
- 把 `Main.wm._shellwm.completed_minimize` / `completed_unminimize` 置空，改由特效结束时手动调用原函数（:59-67）。
- `global.window_manager` 的 `minimize` / `unminimize` 信号里挂 `Clutter.DeformEffect`（:69-95）。
- 图标位置：`meta_window.get_icon_geometry()` → Dash 图标 → 显示器底部中点（:129-165）。
- 特效：`AbstractCommonMagicLampEffect extends Clutter.DeformEffect`，四个方向分支（BOTTOM/LEFT/RIGHT/TOP）+ `default`/`sine` 两种波形（:184-415）。
- `X_TILES` / `Y_TILES` 通过 `set_n_tiles()` 控制网格细分；`DURATION` 与窗口/显示器面积比相加得到时间线时长（:305-310）。

### 3.2 搬运决策

| 项 | 决策 |
|---|---|
| 两个 wm patch | **全量搬**（这是特效的前提），保存原函数到实例字段而非 `Main.wm.original_*` |
| 特效类 | 全量搬，数学公式一字不改 |
| 图标回退链 | 保留；找不到图标时返回 `null`，由特效落显示器底部中点（源扩展用 `{0,0}` 哨兵，效果相同） |
| 禁用顺序 | **先销毁所有 effect（触发原 `completed_*`），再还原 patch**（原扩展顺序相反，可能让窗口停在未完成状态） |
| 幂等 | `enable()` 二次调用直接返回；`disable()` 关闭后字段清空 |

### 3.3 风险

- 依赖 `Main.wm._shouldAnimateActor`、`Main.wm._shellwm.completed_minimize/unminimize` 三个私有成员。缺失时 `console.error` 并跳过，不半启用。
- 与 gnomebox 自身的全屏专用工作区无信号交集（后者监听 `Meta.Window.workspace-changed`、`window-created`）。

## 4. 与 gnomebox 的冲突面

1. **同功能扩展并存**：两个源扩展若同时启用，会和内置副本双重 patch。注册进 `conflicts.js` 的 `CONFLICTING_EXTENSIONS`，开关走 `_bindConflictingFeature`，开启内置副本前先让独立扩展让位。
2. **lilypad 的 `addToStatusArea` patch**：只影响新注册的面板指示器，本搬运不动面板项注册，无影响。
3. **面板样式**：`#panel.openbar .panel-button` 规则不涉及日期按钮内部 label；自建 label 使用 `clock` class，会继承 gnomebox 既有时钟样式（预期行为）。
4. **`_settings.connect('changed')`**：gnomebox 主流程对任意键变更都会 `updatePanelStyle`，新增键变更会多跑一次样式刷新，无副作用。

## 5. 落地文件清单

| 文件 | 变更 |
|---|---|
| `opengnomebox@lyf/luxon.js` | 新增，从源扩展 `lib/luxon.js` 原样复制 |
| `opengnomebox@lyf/dateformat.js` | 新增，纯格式化层（shell 无关，prefs 可复用做预览） |
| `opengnomebox@lyf/datemenu.js` | 新增，日期按钮时钟集成 |
| `opengnomebox@lyf/magiclamp.js` | 新增，最小化特效集成 |
| `opengnomebox@lyf/conflicts.js` | 新增 2 条冲突注册 |
| `opengnomebox@lyf/integrations.js` | 注册两个集成 + 键映射 |
| `opengnomebox@lyf/prefs.js` | 新增「Clock & Window Effects」页 |
| `opengnomebox@lyf/schemas/...gschema.xml` | 新增 15 个键 |
| `opengnomebox@lyf/locale/zh_CN/LC_MESSAGES/opengnomebox.po` + `.mo` | 新增文案翻译 |

## 5.1 实施中的两处收紧（与设计稿的差异）

1. **空 pattern / 格式化失败 → 交还系统时钟。** 初始实现把 `_clockDisplay.text` 抄到自建 label 上，
   但 shell 时钟被摘下后文案不一定继续刷新，可能冻结。现在：
   - `pattern` 为空：`_apply()` 不摘系统时钟，直接保持原样；只在日志里提示一次。
   - 格式化抛错：记一次 `console.error`，并把系统时钟装回去；用户改好设置后 `_apply()` 自动重挂。
2. **`formatPattern` 增加有效性检查。** Luxon 对未知时区不抛异常，而是返回
   `Invalid DateTime`，`toFormat` 会把字面量 "Invalid DateTime" 写进面板。现在检查
   `dateTime.isValid`，无效时抛 `Error(invalidReason)`，走上一条的日志 + 回退路径。

## 6. 验证计划

1. `node --input-type=module --check` 逐个检查改动的 `.js`。
2. `glib-compile-schemas opengnomebox@lyf/schemas/`。
3. 按钦定协议部署：停用 → `rsync -a --delete` → 启用；`diff -rq` 校验。
4. `gnome-extensions info` / `GetExtensionErrors` / `journalctl --user` 检查无 `JS ERROR`。
5. 真机行为（需用户操作）：改 pattern 观察时钟；最小化/还原窗口看特效。

### 6.1 隔离沙箱实测（2026-11-13，GNOME Shell 50.1 headless）

命令按 AGENTS.md 的沙箱流程执行（`dbus-run-session` + `GSETTINGS_BACKEND=keyfile` + `--automation-script`），
脚本依次改设置并断言面板结构，日志前缀 `###TEST`：

| 用例 | 结果 |
|---|---|
| 启用时钟格式化（pattern `HH:mm`） | 自建 label 接管，`_clockDisplay` 脱离容器 |
| `yyyy-MM-dd` | 文本 `2026-11-13` |
| `MM月dd日 H:mm EEE` | 文本 `11月13日 12:33 周五` |
| pattern 置空 | 系统时钟重新挂回，自建 label 移除，日志提示一次 |
| 时区设为 `Not/AZone` | 日志 `unsupported zone`，系统时钟挂回，不显示 "Invalid DateTime" |
| 时区改回空 | 自动重新接管，文本恢复 `12:33` |
| 关闭时钟格式化 | 系统时钟挂回，自建 label 销毁 |
| 启用/关闭神灯特效 | `_shouldAnimateActor` / `completed_minimize` / `completed_unminimize` 均正确 patch 与还原 |

全程无 `JS ERROR` / `Gjs-CRITICAL`（`Gjs-CRITICAL` 只在故意触发未知时区时按设计出现一条）。

## 7. 首选项里的「格式串」帮助（对齐用户诉求：不知道怎么配）

`Clock & Effects` 页在 Pattern 输入框之外补了三层帮助，避免用户凭记忆猜 Luxon token：

1. **Preset 下拉**（`Adw.ComboRow`）：6 个常用形状 —— `HH:mm`、`HH:mm:ss`、
   `EEE, MMM d  H:mm`、`MM月dd日 H:mm EEE`、`yyyy-MM-dd HH:mm`、
   `yyyy年MM月dd日 EEEE HH:mm`；末尾固定一项 `Custom`。
   - 选中预设 → 写入 `date-menu-format-pattern`；`Custom` 只在当前 pattern 与任一预设都不匹配时显示，
     选中它不写任何值（保留手输内容）。
   - `refreshPreview()` 每次设置变化都会把下拉重新对齐到当前 pattern，手输时不覆盖输入框。
2. **Pattern tokens 可折叠对照表**（`Adw.ExpanderRow` + `Adw.ActionRow`）：12 行，
   token 写法、中文含义、真实示例（`y / yyyy` → 2026，`MMM / MMMM` → `11月 / 十一月`，
   `EEE / EEEE` → `周五 / 星期五`，`h / hh / a` → `9 下午`，`'text'` 原样文本，`\n` 换行）。
   Pattern 输入框另有 `tooltip_text` 给一个可直接抄的例子 `例如：MM月dd日 H:mm EEE`。
3. **完整 token 参考**：表末一行 subtitle 直接显示 Luxon 官方 token 文档 URL，
   点击走 `Gio.AppInfo.launch_default_for_uri` 用默认浏览器打开；打开失败只 `console.warn`，不影响窗口。

新增文案 23 条（Preset / Custom / 6 个预设名 / token 含义 11 条 / Pattern tokens / Full token reference /
`For example: %s`），已补进 zh_CN po（647 条），`tools/po2mo.py` 重新生成 mo 并校验 msgid 严格递增。

## 8. Single Features 页改成 master-detail（2026-11-13，第二轮）

原页面是一列竖排 `Adw.ExpanderRow`，8 个功能展开后越滚越长，时钟的 token 表挤在里面几乎不可用。
按用户决定改为「左功能列表 + 右设置面板」，共 10 项：电池、状态区间距、手势、可移动驱动器、
全屏空工作区、自动移窗、剪贴板、指示器分组、时钟格式化、神灯特效。原先 4 个独立页
（`Clock & Effects`、`Clipboard`、`Indicator Group`）全部并入后删除，只剩 `Single Features` 一个入口。

结构（`prefs.js` → `buildExtensionsPage`）：

- `Adw.PreferencesPage`（name 仍为 `extensions`，标题仍为 `Single Features`）→ `_widenPage(page)`
  把 `Adw.Clamp` 放宽到 4096，否则两栏会被压进 600px。
- `Adw.PreferencesGroup` → 横向 `Gtk.Box`（`.openbar-feature-box`，`height_request: 560`）。
- 左栏 `Gtk.ScrolledWindow`（260px 固定、横向 NEVER）包 `Gtk.ListBox`（`navigation-sidebar`），
  每行只有 16px 图标 + 标题 + 启用时的 `object-select-symbolic` 灰色对勾。功能说明只放右栏头部一份，
  左栏不再重复副标题（行高从约 62px 收紧到约 40px，10 行约 430px，不需要内部滚动）。
- 右栏 `Gtk.Stack`（`hhomogeneous/vhomogeneous: false`，无过渡），每个功能一页，页内独立
  `Gtk.ScrolledWindow`（横向 NEVER），顶部是 `_makeFeatureHeader`（28px 图标 + `title-4` 名称 +
  说明 + 启用开关），下面是 `Adw.PreferencesGroup` 承载原有设置行。
- 剪贴板与指示器分组复用原模块：`buildClipboardPrefsPage()` 与 `LilypadPrefsContent.build()`
  内部只有 `page.add(section)`，传入适配对象 `{ add: widget => panel.append(widget) }` 即可挂到面板上，
  `clipboardPrefs.js` / `lilypadPrefs.js` 未改动。指示器分组的「禁用时卡片置灰」由
  `_lilyController.setSensitive()` + `changed::lilypad-enabled` 保持，连接在 window `unrealize` 时断开。
- 开关统一走 `_makeFeatureHeader`：`CONFLICTING_EXTENSIONS` 里有的键继续走 `_bindConflictingFeature`
  （异步冲突检查 + `_askTakeOver`），其余走普通 `_settings.bind`，与改造前等价。
- 左栏对勾每条连接一次 `changed::<key>`，id 收集到 `featureStatusIds`，在 `window` 的 `unrealize`
  统一断开（时钟面板的预览信号是另一组 `previewIds`，互不影响）。

实测确认（沙箱，`gjs` 探针）：

| 检查 | 结果 |
|---|---|
| `new Adw.PreferencesPage()` 后立刻能否找到 `Adw.Clamp` | 能找到，`_widenPage` 调用时机正确 |
| 左栏 `measure()`（含 2 行长副标题） | min = natural = 250，长文案不会撑宽侧栏 |
| 沙箱内启动 prefs 进程 | 页面构建成功，无 `JS ERROR` / `TypeError` |
| 真机 prefs 进程 + journal | 无新增错误，仅既有 `Gio.DesktopAppInfo` 弃用警告与 `Wallhub` 壁纸扫描告警 |

`height_request: 560` 的作用：`vexpand` 在 `Adw.PreferencesGroup` 里拿不到额外高度，
而 `vhomogeneous: true` 会对齐到最长子页（时钟页）导致卡片超高，所以用显式最小高度保证
切换功能时卡片不跳动；小屏下由页面级滚动兜底。

## 9. 指示器分组拖放后设置面板显示错位（2026-11-13，修复）

现象（用户报告）：把托盘图标从「Top bar order」拖进「Collapsible group」，顶栏立即生效，
但设置面板里该图标仍留在「Top bar order」的最前面；关闭重开首选项后正常。

根因两处，都在 `lilypadPrefs.js`：

1. `_rebuildCards()` 只对**当前模型数组里**的行调用 `expander.remove()`。跨卡片移动后，
   被移动的行已不在原卡片的 `rows` 里，但仍是原 `Adw.ExpanderRow` 的子控件，于是
   `add_row()` 触发 `adw_expander_row_add_row: assertion 'gtk_widget_get_parent (child) == NULL'`
   失败，行永久留在旧卡片；接下来重建旧卡片时把剩余行 remove 后重新 append，被卡住的那行
   自然排到了最前面 —— 与用户看到的现象一致。`_store()` 写 GSettings 用的是模型数组，
   所以顶栏状态是对的，重开首选项从设置重建又恢复正常。
   顺带解释了 journal 里的 `gtk_box_remove: assertion 'GTK_IS_BOX (box)' failed`：
   对未挂载的 placeholder 调 `remove()`。
2. `_move()` 同卡片向下重排时，`at` 是在 `splice` **之后**用已缩短的数组算出来的，
   却又多减了 1（`if (sourceKey === key && from < at) at -= 1`），属于重复修正：
   把首行拖到末行下方会落到中间位置。

修法：

- 新增 `_ownerExpander(row)`：沿 `get_parent()` 找到真正持有该行的 `Adw.ExpanderRow`。
- `_rebuildCards()` 改为两段：先把**所有卡片**模型行 + placeholder 从各自的真实宿主
  detach（无父则跳过），再按模型顺序统一 attach。这样跨卡片移动后不会残留，也不再对
 未挂载控件调 `remove()`。
- 删除 `_move()` 里那次多余的 `at -= 1`。

沙箱探针（`/tmp/opencode/lily-probe.js`，直接驱动 `_move()`，比较 model / 实际控件顺序 /
GSettings 三者的用例）：跨卡片追加、跨卡片插到某行之前、同卡片向下重排、同卡片向上重排、
删除行、重复 rebuild 共 7 组全部一致，`FAILURES=0`，且不再出现 `gtk_box_remove` /
`adw_expander_row_add_row` 断言。

## 10. 已知未覆盖

- 未在 45–49 上实测（本机只有 50.1）；私有 API 检查失败时会显式报错而非崩溃。
- 未做 `remove-messages-indicator`（源扩展的功能子集）。
- 未做 SimpleDateFormat / Swatch 两个 formatter。
- 首选项窗口里的 `Gio.DesktopAppInfo` 弃用警告与 `Wallhub prefs: could not scan wallpapers`
  是既有问题（`prefs.js` 壁纸规则页），与本次改动无关，未处理。
