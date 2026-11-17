# 全屏顶栏 / dock 滑出淡出动画（2026-11-17）

用户需求：全屏应用在别的工区，从工作区 1 切到 2 时顶栏和 dock 是**瞬间消失**的，
希望隐藏时带一个动画。确认方案：**滑出 + 淡出**，顶栏与 dock 都做，时长默认 200ms 可调。

## 1. 谁在隐藏（定位结论）

GNOME Shell 把 chrome 可见性绑在 monitor 的 fullscreen 状态上，只有一行硬切，没有任何过渡
（`/usr/lib/gnome-shell/libshell-18.so` 里 `gresource extract` 出的 `ui/layout.js`）：

```js
_updateActorVisibility(actorData) {
    if (!actorData.trackFullscreen)
        return;

    const monitor = this.findMonitorForActor(actorData.actor);
    actorData.actor.visible = !(global.window_group.visible &&
                                monitor &&
                                monitor.inFullscreen);
}
```

触发链：`display.in-fullscreen-changed` → `_updateFullscreen()` → `_updateVisibility()`
→ 对每个 `_trackedActors` 调 `_updateActorVisibility`。`_updateVisibility()` 另外还从
`showOverview` / `hideOverview` / `_sessionUpdated` / `init` 走（概览、锁屏同样会调用）。

受影响的 actor（沙箱探针实测）：

| actor | 说明 |
| --- | --- |
| `Main.layoutManager.panelBox` | **才是顶栏**（`St_BoxLayout`，`affectsStruts: true`，子节点才是 `Panel`），`Main.panel` 不是 trackFullscreen actor |
| `ubuntu-dock@ubuntu.com` 自身 | `docking.js:446-448` 以 `trackFullscreen: true, affectsStruts: true` 注册进 chrome，走同一条方法 |

dock 自己的 `_animateOut` 只动 `this._slider` 的 `slide-x`，`dock-fixed=true` 分支里全屏隐藏
根本不到它手上，所以同样是瞬隐。

## 2. 实现

新增 `FullscreenChromeFade`（`opengnomebox@lyf/integrations.js`，`FullscreenEmptyWorkspace`
之后、`IntegrationsManager` 之前），由 `chrome-fade-enabled` 开关驱动：

- hook `Main.layoutManager._updateActorVisibility`：**保留 shell 原判定**
  （`!(global.window_group.visible && monitor && monitor.inFullscreen)`），只把
  `visible = false` 换成「滑向最近屏幕边缘 + 淡出到 0 → 再 `visible=false`」，显示时反向。
- 一个 hook 同时覆盖顶栏和 dock，**不读不写 ubuntu-dock 的任何文件或设置**。
- `disable()`：own property 身份校验后 `delete`（原方法在原型上），再把 `_trackedActors`
  全部交给原方法重新套用真实可见性，避免留下半动画状态。
- dock 是否参与由 `chrome-fade-dock` 控制；关掉时对已介入的 actor 立即收尾并恢复 shell 判定
  （`_resync`）。
- 滑动方向：全宽 actor（顶栏）沿垂直轴、全高 actor（侧边 dock）沿水平轴，位移量 = 自身尺寸；
  其余按最近屏幕边缘。未分配（尺寸为 NaN）时退化为纯淡出。
- 动画期间 `reactive = false`，结束后恢复原值。注意：父级 `reactive=false` 不拦子控件，
  淡出的 200ms 内顶栏按钮理论上仍可点；时长很短，未额外处理。
- 日志沿用 `###FADE` 前缀（enable / out / in / done / disable），便于真机排查。

设置（`schemas/…gschema.xml`，magic lamp 块之后）：

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `chrome-fade-enabled` | b | false | 总开关 |
| `chrome-fade-duration` | i | 200（60–600） | 动画时长，与 dock 的 `animation-time` 一致 |
| `chrome-fade-dock` | b | true | 同时作用于 dock |

首选项：Single Features 第 11 项（左栏末尾）「全屏动画」，图标 `video-display-symbolic`；
左侧时长 SpinRow（`int` 键 × double 值，用 `notify::value` 手工写回）、dock SwitchRow。
zh_CN 补 4 条新 msgid（总数 648 → 652），`tools/po2mo.py` 重生成 mo。

## 3. 验证（沙箱实测）

用 `--automation-script` 在 `dbus-run-session` + `GSETTINGS_BACKEND=keyfile` 沙箱里跑真客户端
（`/tmp/opencode/fswin.js`，GTK4 小窗），`win.make_fullscreen()` 触发真实 fullscreen 链路：

| 用例 | 结果 |
| --- | --- |
| hook 生效 | own property，且 ≠ 原型方法 |
| 隐藏 | 200ms 内 opacity 255→7，translation-y 0→-51（顶栏高 53），随后 `visible=false`、opacity 复位 255 |
| 显示 | opacity 0→255，translation-y -53→0，结束 `visible=true`、位移归零 |
| 禁用 | own property 消失、方法回到原型、顶栏可见性正确 |
| dock 分支（60×900 合成 actor，假 fullscreen） | offset `x=-60`；dock 选项关掉后立即收尾，opacity/位移复位，之后不再有动画 |
| prefs UI | 真实 `prefs.js` 构建成功，feature 栈 11 页，末页「Fullscreen Animation」，无异常 |
| 状态清理 | 结束时 `_states.size === 0`；无 JS ERROR / Gjs-CRITICAL |

沙箱里没有 ubuntu-dock / blur-my-shell / unite，所以 dock 用合成 actor 走同一份代码验证。

## 4. 已知风险 / 未覆盖

- **需要重新登录才生效**：`integrations.js` 属 shell 侧 ESM，`disable/enable` 不清模块缓存，
  部署后必须重新登录（或重启会话）才会加载新代码；首选项侧改动重开窗口即可。
- 概览进出、锁屏切换走同一个方法，因此也会带这个淡入淡出（shell 原本在这些场景同样会切换可见性）。
- `blur-my-shell`（重挂面板背景）、`unite`（改 panel）与淡出的配合只能真机确认；
  若出现「背景不跟着淡」需要额外处理背景 actor。
- dock 隐藏/显示各被延迟一个动画时长；动画期间 `visible` 仍为 true，其它扩展若据此判断状态会有偏差。
- 沙箱 `--headless` 无法复现真实合成器与多扩展共存，最终观感需真机确认。
