// integrations.js
//
// Self-contained re-implementations of five small GNOME Shell extensions, so
// they can be configured from Open Bar's preference window instead of needing
// five separate extensions installed:
//
//   - Autohide Battery        (autohide-battery@sitnik.ru)
//   - Auto Move Windows       (auto-move-windows@gnome-shell-extensions...)
//   - Removable Drive Menu    (drive-menu@gnome-shell-extensions...)
//   - Status Area Horizontal Spacing (status-area-horizontal-spacing@...)
//   - Swap Finger Gestures 3-4 (swap-finger-gestures-3-4@...)
//
// Each integration has its own enable()/disable() and is toggled by a boolean
// key in Open Bar's schema, so they can be switched on independently. The
// originals must be disabled: two implementations of the same hook conflict.
//
// GPL-2.0-or-later, same as the rest of Open Bar.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import UPower from 'gi://UPowerGlib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as ShellMountOperation from 'resource:///org/gnome/shell/ui/shellMountOperation.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as StyleSheets from './stylesheets.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { InjectionManager } from 'resource:///org/gnome/shell/extensions/extension.js';

// ---------------------------------------------------------------------------
// 1. Autohide Battery
//
// Hides the power indicator in the quick settings system item when the battery
// is charging/full (or always) and above a threshold.
// ---------------------------------------------------------------------------
export class BatteryAutohide {
    constructor(ext) {
        this.ext = ext;
        this._settings = ext._settings;
        this._enabled = false;
        this._signalIds = [];
        this._batteryProxy = null;
        this._batterySignalId = 0;
        this._timerId = 0;
    }

    enable() {
        if (this._enabled)
            return;
        this._enabled = true;

        this._signalIds.push(this._settings.connect('changed::battery-autohide', () => this._sync()));
        this._signalIds.push(this._settings.connect('changed::battery-hide-on', () => this._update()));
        this._signalIds.push(this._settings.connect('changed::battery-hide-always', () => this._update()));

        this._watchBattery();
        this._update();
        // Poll once a second, like the original: the power proxy does not emit
        // for every percentage change on all hardware.
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            if (!this._enabled || this.ext.disabling) {
                this._timerId = 0;
                return GLib.SOURCE_REMOVE;
            }
            this._update();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        this._enabled = false;
        this._signalIds.forEach(id => {
            try { this._settings.disconnect(id); } catch (e) {}
        });
        this._signalIds = [];

        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
        if (this._batteryProxy && this._batterySignalId) {
            try { this._batteryProxy.disconnect(this._batterySignalId); } catch (e) {}
        }
        this._batterySignalId = 0;

        this._show();
    }

    _sync() {
        if (this._settings.get_boolean('battery-autohide'))
            this.enable();
        else
            this.disable();
    }

    // The power toggle lives under the quick settings system item.
    _systemItem() {
        try {
            return Main.panel.statusArea.quickSettings?._system ?? null;
        } catch (e) {
            return null;
        }
    }

    _watchBattery() {
        try {
            const system = this._systemItem();
            const toggle = system?._systemItem?._powerToggle;
            if (!toggle || !toggle._proxy)
                return;
            this._batteryProxy = toggle._proxy;
            this._batterySignalId = this._batteryProxy.connect('g-properties-changed', () => {
                if (!this.ext.disabling)
                    this._update();
            });
        } catch (e) {
            console.warn('Open Bar: battery watch failed: ' + e.message);
        }
    }

    _hide() {
        try { this._systemItem()?.hide(); } catch (e) {}
    }

    _show() {
        try { this._systemItem()?.show(); } catch (e) {}
    }

    _update() {
        if (!this._enabled)
            return;
        try {
            const proxy = this._batteryProxy;
            const system = this._systemItem();
            if (!system || !proxy) {
                // No battery hardware or the item is not ready: nothing to hide.
                return;
            }

            const hideOn = this._settings.get_int('battery-hide-on');
            const hideAlways = this._settings.get_boolean('battery-hide-always');

            const state = proxy.State;
            const isPendingCharge = state === UPower.DeviceState.PENDING_CHARGE;
            const isFullyCharged = state === UPower.DeviceState.FULLY_CHARGED;
            const isDischarging = state === UPower.DeviceState.DISCHARGING;

            if (proxy.Type !== UPower.DeviceKind.BATTERY) {
                this._show();
            } else if ((hideAlways || !isDischarging) && proxy.Percentage >= hideOn) {
                this._hide();
            } else if (isFullyCharged || isPendingCharge) {
                this._hide();
            } else {
                this._show();
            }
        } catch (e) {
            console.warn('Open Bar: battery update failed: ' + e.message);
        }
    }
}

// ---------------------------------------------------------------------------
// 2. Status Area Horizontal Spacing
//
// Overrides -natural-hpadding on every panel-button in the status area.
// ---------------------------------------------------------------------------
export class StatusAreaSpacing {
    constructor(ext) {
        this.ext = ext;
        this._settings = ext._settings;
        this._enabled = false;
        this._signalIds = [];
    }

    enable() {
        if (this._enabled)
            return;
        this._enabled = true;
        // The spacing is applied through OpenBar's generated stylesheet
        // (#panel.openbar .panel-button), so changing it must regenerate and
        // reload the sheet. An inline style would be overridden on reload and
        // needs an extension restart to show up.
        this._signalIds.push(this._settings.connect('changed::status-spacing', () => {
            this._reloadStyles();
        }));
        this._signalIds.push(this._settings.connect('changed::status-spacing-enabled', () => {
            this._reloadStyles();
        }));
    }

    _reloadStyles() {
        try {
            const ext = this.ext;
            if (ext && typeof StyleSheets !== 'undefined' && StyleSheets.reloadStyle)
                StyleSheets.reloadStyle(ext, ext);
        } catch (e) {
            console.warn('Open Bar: could not reload stylesheet for spacing: ' + e.message);
        }
    }

    disable() {
        this._enabled = false;
        this._signalIds.forEach(id => {
            try { this._settings.disconnect(id); } catch (e) {}
        });
        this._signalIds = [];
    }

}

// ---------------------------------------------------------------------------
// 3. Auto Move Windows
//
// Moves a configured application's new windows to a workspace. Reads the same
// "app-id:workspace" string list format the original uses.
// ---------------------------------------------------------------------------
export class AutoMoveWindows {
    constructor(ext) {
        this.ext = ext;
        this._settings = ext._settings;
        this._enabled = false;
        this._signalIds = [];
        this._appSystem = null;
        this._configs = new Map();
        this._appData = new Map();
        this._prevCheckWorkspaces = null;
    }

    enable() {
        if (this._enabled)
            return;
        this._enabled = true;

        this._appSystem = Shell.AppSystem.get_default();
        this._reloadConfigs();

        this._appSystem.connectObject('installed-changed', () => this._updateAppData(), this);
        this._signalIds.push(this._settings.connect('changed::auto-move-list', () => this._reloadConfigs()));

        // Keep empty workspaces alive at the end so the configured numbers
        // remain valid, mirroring the original extension.
        try {
            this._prevCheckWorkspaces = Main.wm._workspaceTracker._checkWorkspaces;
            const prev = this._prevCheckWorkspaces;
            Main.wm._workspaceTracker._checkWorkspaces = function () {
                const keepAlive = [];
                let foundNonEmpty = false;
                for (let i = this._workspaces.length - 1; i >= 0; i--) {
                    if (!foundNonEmpty) {
                        foundNonEmpty = this._workspaces[i].list_windows()
                            .some(w => !w.is_on_all_workspaces());
                    } else if (!this._workspaces[i]._keepAliveId) {
                        keepAlive.push(this._workspaces[i]);
                    }
                }
                keepAlive.forEach(ws => (ws._keepAliveId = 1));
                prev.call(this);
                keepAlive.forEach(ws => delete ws._keepAliveId);
                return false;
            };
        } catch (e) {
            console.warn('Open Bar: auto-move workspace hook failed: ' + e.message);
        }
    }

    disable() {
        this._enabled = false;
        this._signalIds.forEach(id => {
            try { this._settings.disconnect(id); } catch (e) {}
        });
        this._signalIds = [];

        try {
            if (this._prevCheckWorkspaces && Main.wm?._workspaceTracker)
                Main.wm._workspaceTracker._checkWorkspaces = this._prevCheckWorkspaces;
        } catch (e) {}
        this._prevCheckWorkspaces = null;

        try {
            this._appSystem?.disconnectObject(this);
        } catch (e) {}
        for (const app of this._appData.keys()) {
            try { app.disconnectObject(this); } catch (e) {}
        }
        this._appData.clear();
        this._configs.clear();
    }

    _sync() {
        if (this._settings.get_boolean('auto-move-windows'))
            this.enable();
        else
            this.disable();
    }

    _reloadConfigs() {
        if (!this._enabled)
            return;
        this._configs.clear();
        for (const entry of this._settings.get_strv('auto-move-list')) {
            const [appId, num] = entry.split(':');
            const workspace = parseInt(num, 10);
            if (!appId || !Number.isFinite(workspace))
                continue;
            this._configs.set(appId, workspace - 1);
        }
        this._updateAppData();
    }

    _updateAppData() {
        if (!this._enabled || !this._appSystem)
            return;
        try {
            const ids = [...this._configs.keys()];

            for (const [app] of this._appData) {
                if (!ids.includes(app.id)) {
                    try { app.disconnectObject(this); } catch (e) {}
                    this._appData.delete(app);
                }
            }

            for (const id of ids) {
                const app = this._appSystem.lookup_app(id);
                if (!app || this._appData.has(app))
                    continue;
                app.connectObject('windows-changed', () => this._appWindowsChanged(app), this);
                this._appData.set(app, { windows: app.get_windows() });
            }
        } catch (e) {
            console.warn('Open Bar: auto-move update failed: ' + e.message);
        }
    }

    _moveWindow(win, workspaceNum) {
        try {
            if (win.skip_taskbar || win.is_on_all_workspaces())
                return;
            const manager = global.workspace_manager;
            for (let i = manager.n_workspaces; i <= workspaceNum; i++) {
                win.change_workspace_by_index(i - 1, false);
                manager.append_new_workspace(false, 0);
            }
            win.change_workspace_by_index(workspaceNum, false);
        } catch (e) {
            console.warn('Open Bar: could not move window: ' + e.message);
        }
    }

    _appWindowsChanged(app) {
        try {
            const data = this._appData.get(app);
            if (!data || this.ext.disabling)
                return;
            const windows = app.get_windows();
            // Keep windows that are only transitioning between workspaces.
            windows.push(...data.windows.filter(w =>
                !windows.includes(w) && w.get_compositor_private() !== null));

            const workspaceNum = this._configs.get(app.id);
            if (workspaceNum === undefined) {
                data.windows = windows;
                return;
            }
            windows
                .filter(w => !data.windows.includes(w))
                .forEach(w => this._moveWindow(w, workspaceNum));
            data.windows = windows;
        } catch (e) {
            console.warn('Open Bar: auto-move window handling failed: ' + e.message);
        }
    }
}

// ---------------------------------------------------------------------------
// 4. Swap Finger Gestures (3 to 4)
//
// Makes a four-finger touchpad swipe drive the three-finger workspace gesture.
// ---------------------------------------------------------------------------
export class SwapFingerGestures {
    constructor(ext) {
        this.ext = ext;
        this._settings = ext._settings;
        this._enabled = false;
        this._signalIds = [];
        this._trackers = [];
    }

    enable() {
        if (this._enabled)
            return;
        this._enabled = true;
        try {
            this._trackers = [
                Main.overview?._swipeTracker?._touchpadGesture,
                Main.wm?._workspaceAnimation?._swipeTracker?._touchpadGesture,
                Main.overview?._overview?._controls?._workspacesDisplay?._swipeTracker?._touchpadGesture,
            ].filter(g => g && typeof g._handleEvent === 'function');

            for (const gesture of this._trackers) {
                gesture._openbarNewHandleEvent = (actor, event) => {
                    event._get_touchpad_gesture_finger_count =
                        event.get_touchpad_gesture_finger_count;
                    event.get_touchpad_gesture_finger_count = () =>
                        event._get_touchpad_gesture_finger_count() === 4 ? 3 : 0;
                    return gesture._handleEvent(actor, event);
                };
                try {
                    global.stage.disconnectObject(gesture);
                } catch (e) {}
                global.stage.connectObject(
                    'captured-event::touchpad',
                    gesture._openbarNewHandleEvent.bind(gesture),
                    gesture);
            }
        } catch (e) {
            console.warn('Open Bar: finger gesture swap failed: ' + e.message);
        }
    }

    disable() {
        this._enabled = false;
        this._signalIds.forEach(id => {
            try { this._settings.disconnect(id); } catch (e) {}
        });
        this._signalIds = [];

        for (const gesture of this._trackers) {
            try {
                global.stage.disconnectObject(gesture);
                if (gesture._handleEvent)
                    global.stage.connectObject(
                        'captured-event::touchpad',
                        gesture._handleEvent.bind(gesture),
                        gesture);
            } catch (e) {
                console.warn('Open Bar: finger gesture restore failed: ' + e.message);
            }
            delete gesture._openbarNewHandleEvent;
        }
        this._trackers = [];
    }

    _sync() {
        if (this._settings.get_boolean('swap-finger-gestures'))
            this.enable();
        else
            this.disable();
    }
}

// ---------------------------------------------------------------------------
// 5. Removable Drive Menu
//
// A status area button listing removable mounts, with unmount support.
// ---------------------------------------------------------------------------
const DriveMenuItem = GObject.registerClass(
class DriveMenuItem extends PopupMenu.PopupBaseMenuItem {
    _init(mount) {
        super._init({ style_class: 'drive-menu-item' });
        this.mount = mount;

        this.label = new St.Label({
            text: mount.get_name(),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this.label);
        this.label_actor = this.label;

        const ejectIcon = new St.Icon({
            icon_name: 'media-eject-symbolic',
            style_class: 'popup-menu-icon',
        });
        const ejectButton = new St.Button({
            child: ejectIcon,
            style_class: 'button',
            accessible_name: _('Eject'),
        });
        ejectButton.connect('clicked', () => this._eject());
        this.add_child(ejectButton);
    }

    _eject() {
        try {
            const mountOp = new ShellMountOperation.ShellMountOperation(this.mount).mountOp;
            const args = [Gio.MountUnmountFlags.NONE, mountOp, null];
            if (this.mount.can_eject())
                this.mount.eject_with_operation(...args, (m, res) => this._finish(m, res, true));
            else
                this.mount.unmount_with_operation(...args, (m, res) => this._finish(m, res, false));
        } catch (e) {
            console.warn('Open Bar: eject failed: ' + e.message);
        }
    }

    _finish(mount, result, isEject) {
        try {
            if (isEject)
                mount.eject_with_operation_finish(result);
            else
                mount.unmount_with_operation_finish(result);
        } catch (e) {
            console.warn('Open Bar: eject/unmount failed: ' + e.message);
        }
    }

    activate() {
        try {
            this.mount.get_root().open(null);
        } catch (e) {
            console.warn('Open Bar: could not open mount: ' + e.message);
        }
    }
});

export class DriveMenu {
    constructor(ext) {
        this.ext = ext;
        this._settings = ext._settings;
        this._enabled = false;
        this._signalIds = [];
        this._indicator = null;
        this._sections = [];
        this._monitor = null;
        this._updateId = 0;
    }

    enable() {
        if (this._enabled)
            return;
        this._enabled = true;
        try {
            this._indicator = new PanelMenu.Button(0.0, 'openbar-drive-menu', false);
            this._indicator.add_child(new St.Icon({
                icon_name: 'drive-harddisk-symbolic',
                style_class: 'system-status-icon',
            }));
            Main.panel.addToStatusArea('openbar-drive-menu', this._indicator, 0, 'right');

            this._monitor = Gio.VolumeMonitor.get();
            if (this._monitor) {
                this._signalIds.push(this._monitor.connect('mount-added', () => this._queueUpdate()));
                this._signalIds.push(this._monitor.connect('mount-removed', () => this._queueUpdate()));
            }
            this._refresh();
        } catch (e) {
            console.warn('Open Bar: drive menu failed to start: ' + e.message);
        }
    }

    disable() {
        this._enabled = false;
        this._signalIds.forEach(id => {
            try {
                if (this._monitor) this._monitor.disconnect(id);
            } catch (e) {}
        });
        this._signalIds = [];
        if (this._updateId) {
            GLib.source_remove(this._updateId);
            this._updateId = 0;
        }
        try {
            this._indicator?.destroy();
        } catch (e) {}
        this._indicator = null;
        this._sections = [];
        this._monitor = null;
    }

    _sync() {
        if (this._settings.get_boolean('drive-menu-enabled'))
            this.enable();
        else
            this.disable();
    }

    _queueUpdate() {
        if (this._updateId || !this._enabled)
            return;
        this._updateId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            this._updateId = 0;
            if (this._enabled && !this.ext.disabling)
                this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    _removableMounts() {
        try {
            return Gio.VolumeMonitor.get().get_mounts().filter(m => {
                try {
                    if (!m.can_eject() && !m.can_unmount())
                        return false;
                    if (m.is_shadowed())
                        return false;
                    // Network mounts are not "removable drives".
                    const volume = m.get_volume();
                    if (volume && volume.get_identifier('class') === 'network')
                        return false;
                    return true;
                } catch (e) {
                    return false;
                }
            });
        } catch (e) {
            return [];
        }
    }

    _refresh() {
        if (!this._indicator)
            return;
        try {
            const menu = this._indicator.menu;
            menu.removeAll();
            this._sections = [];

            const mounts = this._removableMounts();
            this._indicator.visible = mounts.length > 0;

            for (const mount of mounts) {
                const item = new DriveMenuItem(mount);
                menu.addMenuItem(item);
                this._sections.push(item);
            }
            if (mounts.length === 0)
                menu.addMenuItem(new PopupMenu.PopupMenuItem(_('No removable drives'), { reactive: false }));
        } catch (e) {
            console.warn('Open Bar: drive menu refresh failed: ' + e.message);
        }
    }
}

// ---------------------------------------------------------------------------
// Dedicated-workspace guard
//
// Keeps a set of "dedicated" (fullscreen-owned) workspaces and makes them behave
// like macOS fullscreen Spaces from the user's point of view:
//
//   - Keyboard/menu moves skip them instead of being refused, so Super+Shift+→
//     from W1 lands on W3 when W2 is dedicated.
//   - Dragging a window onto one in the overview is rejected, and the thumbnail
//     is dimmed so the block is visible rather than mysterious.
//
// Everything is expressed by patching Meta.Window's workspace methods through
// the shell's own InjectionManager, which stores the originals so disable()
// restores them cleanly.
// ---------------------------------------------------------------------------
export class DedicatedWorkspaceGuard {
    constructor() {
        this._dedicated = new Set();
        // Marks our own moves so the guards let them through.
        this._internalMoves = 0;
        this._injectionManager = null;
        this._winCreatedId = 0;
        this._globalWindowIds = [];
        this._owners = new Map();
        this._thumbnailsChangedId = 0;
        this._enabled = false;
        // Transient message shown when a move is refused.
        this._toastActor = null;
        this._toastTimeoutId = 0;
    }

    enable() {
        if (this._enabled)
            return;
        this._enabled = true;
        this._install();
        this._refreshThumbnails();
    }

    disable() {
        this._enabled = false;
        this._dedicated.clear();
        this._clearThumbnails();
        try {
            this._injectionManager?.clear();
        } catch (e) {
            console.warn('Open Bar: could not restore workspace methods: ' + e.message);
        }
        this._unwatchWindows();
        this._injectionManager = null;
        this._owners = new Map();
        try {
            if (this._thumbnailsChangedId)
                global.workspace_manager.disconnect(this._thumbnailsChangedId);
        } catch (e) {}
        this._thumbnailsChangedId = 0;
    }

    // ---- dedicated set -----------------------------------------------------

    add(workspace) {
        if (!workspace)
            return;
        this._dedicated.add(workspace);
        this._refreshThumbnails();
    }

    remove(workspace) {
        if (!workspace)
            return;
        this._dedicated.delete(workspace);
        this._refreshThumbnails();
    }

    isDedicated(workspace) {
        return !!workspace && this._dedicated.has(workspace);
    }

    // Run `fn` with the guards bypassed, for our own placement/restore moves.
    runInternal(fn) {
        this._internalMoves++;
        try {
            return fn();
        } finally {
            this._internalMoves--;
        }
    }

    // ---- patching ----------------------------------------------------------

    _install() {
        // Meta.Window.prototype comes from GObject introspection (assigning to it
        // is not reliable) and ES module exports like
        // Main.moveWindowToMonitorAndWorkspace are read-only bindings.
        //
        // 'workspace-changed' is a signal on Meta.Window (not on Meta.Display -
        // MetaDisplay has no such signal). Every window receives it whenever it
        // is moved, whatever the origin: keyboard, overview drag, or another
        // extension. We therefore connect per window, via window-created plus a
        // pass over the windows that already exist.
        try {
            this._globalWindowIds = [];
            this._winCreatedId = global.display.connect('window-created',
                (display, win) => this._watchWindow(win));

            for (const actor of global.get_window_actors()) {
                const win = actor.get_meta_window();
                if (win)
                    this._watchWindow(win);
            }
        } catch (e) {
            console.warn('Open Bar: could not watch window moves: ' + e.message);
        }
    }

    // Attach the per-window move listener exactly once.
    _watchWindow(win) {
        try {
            if (!win || win._openbarWorkspaceWatched)
                return;
            win._openbarWorkspaceWatched = true;
            // Remember where the window was, so the handler can tell which way
            // it was travelling. 'workspace-changed' carries no direction.
            try {
                win._openbarLastWs = win.get_workspace();
            } catch (e) {
                win._openbarLastWs = null;
            }
            const id = win.connect('workspace-changed', () => {
                if (!this._enabled)
                    return;
                let now = null;
                try {
                    now = win.get_workspace();
                } catch (e) {
                    return;
                }
                const prev = win._openbarLastWs ?? null;
                win._openbarLastWs = now;
                if (this._internalMoves > 0)
                    return;
                this._evict(win, prev, now);
            });
            this._globalWindowIds.push({ win, id });
        } catch (e) {
            // Not every Meta.Window exposes the signal; ignore those.
        }
    }

    _unwatchWindows() {
        for (const { win, id } of (this._globalWindowIds ?? [])) {
            try { win.disconnect(id); } catch (e) {}
            try { delete win._openbarWorkspaceWatched; } catch (e) {}
        }
        this._globalWindowIds = [];
        try {
            if (this._winCreatedId)
                global.display.disconnect(this._winCreatedId);
        } catch (e) {}
        this._winCreatedId = 0;
    }

    // A window landed on a dedicated workspace it does not own: send it on to
    // the next acceptable workspace in the direction it was travelling, so a
    // keyboard move behaves as a skip rather than a bounce-back.
    _evict(win, prevWs, nowWs) {
        try {
            if (!win || win.window_type !== Meta.WindowType.NORMAL)
                return;
            if (win.is_always_on_all_workspaces())
                return;

            const manager = global.workspace_manager;
            const now = nowWs ?? win.get_workspace();
            const prev = prevWs ?? null;

            // Case 1: the owner left its own dedicated workspace while still
            // fullscreen. macOS treats a fullscreen Space and its window as one
            // unit, so there is nothing to "move out" - put it back.
            const prevDedicated = prev && this.isDedicated(prev);
            if (prevDedicated && this._ownerOf(prev) === win &&
                now && !this.isDedicated(now) && win.fullscreen) {
                this._internalMoves++;
                try {
                    win.change_workspace(prev);
                    win._openbarLastWs = prev;
                } finally {
                    this._internalMoves--;
                }
                this.showMessage(
                    _('A fullscreen window cannot be moved to another workspace. ' +
                      'Leave fullscreen first.'));
                return;
            }

            // Case 2: an intruder landed on a dedicated workspace. Skip past it
            // in the direction it was travelling, so a keyboard move reads as a
            // skip rather than a bounce-back.
            if (!this.isDedicated(now))
                return;
            if (this._ownerOf(now) === win)
                return;

            const n = manager.get_n_workspaces();
            const here = now.index();

            // Direction of travel: +1 moving right/forward, -1 left/backward.
            let step = 1;
            let prevIndex = -1;
            try {
                prevIndex = prevWs ? prevWs.index() : -1;
            } catch (e) {
                prevIndex = -1;
            }
            if (prevIndex >= 0 && prevIndex !== here)
                step = here > prevIndex ? 1 : -1;

            // Walk on in the same direction; if we run out of workspaces fall
            // back to the opposite side.
            const candidates = [];
            for (let i = here + step; i >= 0 && i < n; i += step)
                candidates.push(i);
            for (let i = here - step; i >= 0 && i < n; i -= step)
                candidates.push(i);

            let target = null;
            for (const i of candidates) {
                const cand = manager.get_workspace_by_index(i);
                if (cand && !this.isDedicated(cand)) {
                    target = cand;
                    break;
                }
            }
            if (!target)
                return;

            this._internalMoves++;
            try {
                win.change_workspace(target);
                win._openbarLastWs = target;
            } finally {
                this._internalMoves--;
            }
        } catch (e) {
            console.warn('Open Bar: could not evict window: ' + e.message);
        }
    }

    // Record which window owns a dedicated workspace.
    setOwner(workspace, win) {
        if (!workspace)
            return;
        if (!this._owners)
            this._owners = new Map();
        this._owners.set(workspace, win ?? null);
    }

    _ownerOf(workspace) {
        return this._owners ? (this._owners.get(workspace) ?? null) : null;
    }

    // Drag & drop rejection: patch the thumbnail box once we can reach it, so a
    // drop onto a dedicated workspace is refused outright.
    // Reject drops onto a dedicated workspace.
    //
    // ThumbnailsBox.acceptDrop decides which thumbnail receives the drop via
    // its own _dropWorkspace index, then delegates to that thumbnail's
    // acceptDropInternal. Patching the box's acceptDrop is therefore the right
    // seam: WorkspaceThumbnail.acceptDropInternal has no idea which workspace
    // owns the box-level drop target.
    installDropGuard() {
        try {
            for (const thumb of this._allThumbnails())
                this._patchThumbnailDnD(thumb);

            // Thumbnails are rebuilt when workspaces change; re-patch then.
            try {
                if (!this._thumbnailsRebuiltId) {
                    this._thumbnailsRebuiltId = global.workspace_manager.connect(
                        'notify::n-workspaces', () => {
                            this._refreshThumbnails();
                            for (const t of this._allThumbnails())
                                this._patchThumbnailDnD(t);
                        });
                }
            } catch (e) {}
        } catch (e) {
            console.warn('Open Bar: could not install drop guard: ' + e.message);
        }
    }

    // Patch one WorkspaceThumbnail so dragging a foreign window over a
    // dedicated workspace is visibly refused: red outline plus a hint, and the
    // drop itself is rejected.
    _patchThumbnailDnD(thumb) {
        if (!thumb || thumb._openbarDnDPatched)
            return;
        if (typeof thumb.handleDragOverInternal !== 'function')
            return;

        const originalOver = thumb.handleDragOverInternal;
        thumb.handleDragOverInternal = (source, actor, time) => {
            try {
                const isForeign = source?.metaWindow &&
                    this._ownerOf(thumb.metaWorkspace) !== source.metaWindow;
                if (this.isDedicated(thumb.metaWorkspace) && isForeign) {
                    thumb.set_style('opacity: 0.35; border: 2px solid rgba(224,27,36,0.9);');
                    return DND.DragMotionResult.CONTINUE;   // not a valid drop
                }
            } catch (e) {}
            return originalOver.call(thumb, source, actor, time);
        };

        const originalDrop = thumb.acceptDropInternal;
        if (typeof originalDrop === 'function') {
            thumb.acceptDropInternal = (source, actor, time) => {
                try {
                    const isForeign = source?.metaWindow &&
                        this._ownerOf(thumb.metaWorkspace) !== source.metaWindow;
                    if (this.isDedicated(thumb.metaWorkspace) && isForeign) {
                        this.showMessage(
                            _('This workspace belongs to a fullscreen window and cannot ' +
                              'receive other windows.'));
                        return false;
                    }
                } catch (e) {}
                return originalDrop.call(thumb, source, actor, time);
            };
        }

        thumb._openbarDnDPatched = true;
    }

    // ---- transient message -------------------------------------------------

    // Short, self-dismissing hint near the bottom of the screen. Used when an
    // action is refused so the block is explained rather than mysterious.
    showMessage(text) {
        try {
            this._hideMessage();
            const label = new St.Label({
                text,
                style_class: 'openbar-space-hint',
                style: 'background-color: rgba(0,0,0,0.75); color: #fff; ' +
                    'padding: 10px 20px; border-radius: 8px; font-size: 13px;',
                x_align: Clutter.ActorAlign.CENTER,
                text_align: Clutter.ActorAlign.CENTER,
            });
            const bin = new St.Bin({
                child: label,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.END,
                x_expand: true,
                y_expand: true,
                reactive: false,
            });
            bin.set_position(0, 0);
            bin.set_size(global.stage.width, global.stage.height);
            bin.translation_y = -90;
            Main.uiGroup.add_child(bin);
            this._toastActor = bin;
            this._toastTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2200, () => {
                this._toastTimeoutId = 0;
                this._hideMessage();
                return GLib.SOURCE_REMOVE;
            });
        } catch (e) {
            console.warn('Open Bar: could not show hint: ' + e.message);
        }
    }

    _hideMessage() {
        if (this._toastTimeoutId) {
            try { GLib.source_remove(this._toastTimeoutId); } catch (e) {}
            this._toastTimeoutId = 0;
        }
        try {
            this._toastActor?.destroy();
        } catch (e) {}
        this._toastActor = null;
    }

    // ---- overview thumbnails ----------------------------------------------


    // Walk the workspaces views and dim dedicated thumbnails. The thumbnail
    // exposes `metaWorkspace`, so matching does not rely on private fields.
    _refreshThumbnails() {
        try {
            for (const thumb of this._allThumbnails()) {
                if (!thumb || !thumb.metaWorkspace)
                    continue;
                const dedicated = this.isDedicated(thumb.metaWorkspace);
                // Mark for the drag-over handler and for identification.
                thumb._openbarDedicated = dedicated;
                try {
                    if (dedicated)
                        thumb.set_style('opacity: 0.35;');
                    else
                        thumb.set_style(null);
                } catch (e) {}
            }
        } catch (e) {
            // Purely cosmetic: never let it break anything.
        }
    }

    _allThumbnails() {
        const out = [];
        try {
            const views = this._workspaceViews();
            for (const view of views) {
                const box = view?._thumbnails;
                for (const thumb of (box?._thumbnails ?? []))
                    out.push(thumb);
            }
        } catch (e) {}
        return out;
    }

    // The overview keeps one view per monitor; both spellings exist in the
    // shell source, so try both.
    _workspaceViews() {
        const display = Main.overview?._overview?._controls?._workspacesDisplay;
        return display?._workspacesViews ?? (display?._workspacesView ? [display._workspacesView] : []);
    }

    _clearThumbnails() {
        for (const thumb of this._allThumbnails()) {
            try {
                thumb.set_style(null);
                thumb._openbarDedicated = false;
            } catch (e) {}
        }
    }

    // Re-dim after the thumbnail strip is rebuilt.
    watchThumbnails() {
        try {
            if (this._thumbnailsChangedId)
                return;
            this._thumbnailsChangedId = global.workspace_manager.connect(
                'notify::n-workspaces', () => this._refreshThumbnails());
        } catch (e) {}
    }
}


// ---------------------------------------------------------------------------
// 6. Fullscreen to Empty Workspace
//
// When a window becomes maximized/fullscreen, reorder workspaces so that window
// sits on a workspace that is empty for its monitor; restore on unmaximize,
// minimize or destroy. Ported from fullscreen-to-empty-workspace2@corgijan.dev.
// ---------------------------------------------------------------------------
export class FullscreenEmptyWorkspace {
    constructor(ext) {
        this.ext = ext;
        this._settings = ext._settings;
        this._enabled = false;
        this._signalIds = [];
        this._handles = [];
        this._mutterSettings = null;

        // winId -> { originWs, originIndex, dedicatedWs, created }
        this._state = new Map();
        // Pending size-change verdict per window, applied on 'size-changed'.
        this._sizeChange = new Map();

        // Re-entrancy guard. change_workspace() emits further size-change /
        // map signals, so every workspace mutation runs under this lock or it
        // would loop (fullscreen -> move -> event -> move -> ...).
        // The lock is released on a short timer rather than immediately in
        // finally, because the follow-up signals may be delivered on a later
        // main-loop iteration; releasing synchronously would let them re-enter.
        this._busy = false;
        this._busyTimeoutId = 0;

        // Guards dedicated workspaces against manual/foreign window moves.
        // Enabled only when the corresponding setting is on.
        this._guard = new DedicatedWorkspaceGuard();
        this._guardEnabled = false;
    }

    // Take the guard and auto-release after a short delay. The delay matters:
    // change_workspace() / activate() cause follow-up signals that may arrive on
    // a later main-loop iteration, so releasing synchronously would let them
    // re-enter and move the window again.
    _lock() {
        this._busy = true;
        if (this._busyTimeoutId) {
            try { GLib.source_remove(this._busyTimeoutId); } catch (e) {}
            this._busyTimeoutId = 0;
        }
        this._busyTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            this._busyTimeoutId = 0;
            this._busy = false;
            return GLib.SOURCE_REMOVE;
        });
    }

    enable() {
        if (this._enabled)
            return;
        this._enabled = true;

        try {
            this._mutterSettings = new Gio.Settings({ schema_id: 'org.gnome.mutter' });
        } catch (e) {
            this._mutterSettings = null;
        }

        const wm = global.window_manager;
        const connect = (sig, fn) => {
            try {
                this._handles.push(wm.connect(sig, (_, ...args) => {
                    if (this.ext.disabling || !this._enabled)
                        return;
                    try {
                        fn(...args);
                    } catch (e) {
                        console.warn(`Open Bar: fullscreen-workspace ${sig} failed: ${e.message}`);
                    }
                }));
            } catch (e) {
                console.warn(`Open Bar: could not connect ${sig}: ${e.message}`);
            }
        };

        connect('map', act => this._onMap(act));
        connect('unminimize', act => this._onMap(act));
        connect('size-change', (act, change, rectOld) => this._onSizeChange(act, change, rectOld));
        connect('size-changed', act => this._onSizeChanged(act));
        connect('minimize', act => this._onRestore(act));
        // destroy: window is going away, only drop state, never touch workspaces.
        connect('destroy', act => this._onDestroy(act));

        // Dedicated-workspace guard is a separate, opt-in behaviour.
        this._signalIds.push(this._settings.connect('changed::fullscreen-guard-workspaces',
            () => this._syncGuard()));
        this._syncGuard();
    }

    _syncGuard() {
        let wanted = false;
        try {
            wanted = this._settings.get_boolean('fullscreen-guard-workspaces');
        } catch (e) {
            wanted = false;
        }
        if (wanted === this._guardEnabled)
            return;
        this._guardEnabled = wanted;
        try {
            if (wanted) {
                this._guard.enable();
                this._guard.watchThumbnails();
                this._guard.installDropGuard();
                // Re-register workspaces we already own.
                for (const st of this._state.values()) {
                    if (st?.dedicatedWs)
                        this._guard.add(st.dedicatedWs);
                }
            } else {
                this._guard.disable();
            }
        } catch (e) {
            console.warn('Open Bar: could not toggle workspace guard: ' + e.message);
        }
    }

    disable() {
        this._enabled = false;
        this._signalIds.forEach(id => {
            try { this._settings.disconnect(id); } catch (e) {}
        });
        this._signalIds = [];

        try {
            this._handles.forEach(h => {
                try { global.window_manager.disconnect(h); } catch (e) {}
            });
        } catch (e) {}
        this._handles = [];
        this._state.clear();
        this._sizeChange.clear();
        this._mutterSettings = null;
        try {
            this._guard.disable();
            this._guardEnabled = false;
        } catch (e) {}
        if (this._busyTimeoutId) {
            try { GLib.source_remove(this._busyTimeoutId); } catch (e) {}
            this._busyTimeoutId = 0;
        }
        this._busy = false;
    }

    _sync() {
        if (this._settings.get_boolean('fullscreen-new-workspace'))
            this.enable();
        else
            this.disable();
    }

    _maximizedToo() {
        try {
            return this._settings.get_boolean('fullscreen-maximized-too');
        } catch (e) {
            return true;
        }
    }

    _primaryOnly() {
        try {
            return this._mutterSettings?.get_boolean('workspaces-only-on-primary') ?? true;
        } catch (e) {
            return true;
        }
    }

    _isNormal(win) {
        return !!win && win.window_type === Meta.WindowType.NORMAL &&
            !win.is_always_on_all_workspaces();
    }

    // ---- guards -----------------------------------------------------------

    // True when `ws` holds only `win` (ignoring always-on-all-workspaces ones).
    _isAloneOn(ws, win) {
        try {
            return ws.list_windows()
                .filter(w => w !== win && !w.is_always_on_all_workspaces())
                .length === 0;
        } catch (e) {
            return false;
        }
    }

    _shouldPlace(win) {
        if (!this._isNormal(win))
            return false;
        return this._maximizedToo() ? win.is_maximized() : win.fullscreen;
    }

    // ---- workspace helpers -------------------------------------------------


    // ---- event handlers ----------------------------------------------------

    _onMap(act) {
        const win = act?.meta_window;
        if (!this._shouldPlace(win))
            return;
        this._place(win);
    }

    _onSizeChange(act, change, rectOld) {
        const win = act?.meta_window;
        if (!this._isNormal(win))
            return;
        const id = win.get_id();
        const too = this._maximizedToo();

        if ((too && change === Meta.SizeChange.MAXIMIZE && win.is_maximized()) ||
            change === Meta.SizeChange.FULLSCREEN) {
            this._sizeChange.set(id, 'place');
            return;
        }

        let wasFullyMaximized = false;
        try {
            wasFullyMaximized = win.get_work_area_for_monitor(win.get_monitor()).equal(rectOld);
        } catch (e) {
            wasFullyMaximized = false;
        }
        if ((too && change === Meta.SizeChange.UNMAXIMIZE && wasFullyMaximized) ||
            (change === Meta.SizeChange.UNFULLSCREEN && (too ? !win.is_maximized() : true))) {
            this._sizeChange.set(id, 'back');
        }
    }

    _onSizeChanged(act) {
        const win = act?.meta_window;
        if (!win)
            return;
        const id = win.get_id();
        const verdict = this._sizeChange.get(id);
        if (!verdict)
            return;
        this._sizeChange.delete(id);
        if (verdict === 'place') {
            if (this._shouldPlace(win))
                this._place(win);
        } else {
            this._restore(act);
        }
    }

    _onRestore(act) {
        this._restore(act);
    }

    // Window is being destroyed: drop bookkeeping only. Never move windows or
    // workspaces here (the MetaWindow is already going away).
    _onDestroy(act) {
        try {
            const win = act?.meta_window;
            if (!win)
                return;
            const id = win.get_id();
            const st = this._state.get(id);
            if (!st)
                return;
            this._state.delete(id);
            this._sizeChange.delete(id);
            // Bring the user back to where the window came from, without
            // touching the workspace list.
            const manager = global.workspace_manager;
            if (st.originIndex >= 0 && st.originIndex < manager.get_n_workspaces()) {
                const ws = manager.get_workspace_by_index(st.originIndex);
                if (ws && ws.index() !== manager.get_active_workspace_index())
                    ws.activate(global.get_current_time());
            }
        } catch (e) {
            console.warn('Open Bar: fullscreen-workspace destroy cleanup failed: ' + e.message);
        }
    }

    // ---- placement ---------------------------------------------------------

    _place(win) {
        if (this._busy)
            return;

        try {
            const id = win.get_id();
            const existing = this._state.get(id);
            // Already isolated: nothing to do. This is the main idempotency
            // guard that stops repeated size-change events from re-moving.
            if (existing && this._isAloneOn(win.get_workspace(), win))
                return;

            const monitor = win.get_monitor();
            const manager = win.get_display().get_workspace_manager();
            const current = manager.get_active_workspace_index();

            if (this._primaryOnly() && monitor !== win.get_display().get_primary_monitor())
                return;

            // If there are no other windows there is nothing to escape from.
            if (this._isAloneOn(win.get_workspace(), win))
                return;

            this._lock();
            const originWs = win.get_workspace();
            if (!originWs)
                return;

            const originIndex = originWs.index();
            let dedicatedWs = null;
            let created = false;

            // macOS model: every fullscreen window gets its own Space. Always
            // create a fresh workspace beside the current one instead of reusing
            // an empty one, so two fullscreen windows never share a workspace.
            // Note: AutoMove hooks _checkWorkspaces and keeps trailing
            // workspaces alive, but that only matters when REMOVING a workspace
            // (handled in _restore), so creation is not gated on it.
            try {
                const before = manager.get_n_workspaces();
                manager.append_new_workspace(false, global.get_current_time());
                if (manager.get_n_workspaces() > before) {
                    const appended = manager.get_workspace_by_index(before);
                    const desired = Math.min(current + 1, manager.get_n_workspaces() - 1);
                    if (appended && appended.index() !== desired)
                        manager.reorder_workspace(appended, desired);
                    dedicatedWs = manager.get_workspace_by_index(desired);
                    created = true;
                }
            } catch (e) {
                console.warn('Open Bar: could not create a workspace: ' + e.message);
            }
            if (!dedicatedWs)
                return;

            this._state.set(id, { originWs, originIndex, dedicatedWs, created });
            // Register before moving so the guard already knows this workspace
            // is off-limits; the move itself runs with the guard bypassed.
            if (this._guardEnabled) {
                this._guard.add(dedicatedWs);
                this._guard.setOwner(dedicatedWs, win);
                this._guard.installDropGuard();
            }
            this._guard.runInternal(() => win.change_workspace(dedicatedWs));

            try {
                const now = win.get_workspace();
                if (now && now.index() !== manager.get_active_workspace_index())
                    now.activate(global.get_current_time());
            } catch (e) {
                console.warn('Open Bar: could not switch to the window workspace: ' + e.message);
            }
        } catch (e) {
            console.warn('Open Bar: could not place window on a dedicated workspace: ' + e.message);
        } finally {
            // The guard is released by its own timer; nothing to do here.
        }
    }

    // ---- restore -----------------------------------------------------------

    _restore(act) {
        if (this._busy)
            return;

        try {
            const win = act?.meta_window;
            if (!win)
                return;
            const id = win.get_id();
            const st = this._state.get(id);
            // No record means we never moved it - ignore completely. This keeps
            // us from reacting to events caused by other extensions.
            if (!st)
                return;

            // Drop the record first so a re-entrant event finds nothing to do.
            this._state.delete(id);
            this._sizeChange.delete(id);

            if (!this._isNormal(win))
                return;

            this._lock();

            const manager = win.get_display().get_workspace_manager();
            const dedicatedWs = st.dedicatedWs;

            // Move the window back to its origin workspace.
            let target = null;
            try {
                if (st.originWs && st.originWs.index() >= 0)
                    target = st.originWs;
            } catch (e) {
                target = null;
            }
            if (!target && Number.isInteger(st.originIndex) &&
                st.originIndex >= 0 && st.originIndex < manager.get_n_workspaces())
                target = manager.get_workspace_by_index(st.originIndex);

            if (!target) {
                return;
            }

            if (win.get_workspace()?.index() !== target.index())
                this._guard.runInternal(() => win.change_workspace(target));

            // Switch the view back BEFORE removing anything: mutter treats the
            // active workspace as non-empty and would refuse to remove it, and
            // removing the workspace the user is looking at is not something we
            // want to attempt either.
            try {
                if (target.index() >= 0 &&
                    target.index() !== manager.get_active_workspace_index())
                    target.activate(global.get_current_time());
            } catch (e) {}

            // The workspace is no longer off-limits once the owner has left.
            if (this._guardEnabled && dedicatedWs) {
                this._guard.setOwner(dedicatedWs, null);
                this._guard.remove(dedicatedWs);
            }

            // Remove the workspace we created for this window. Do not rely on
            // mutter's automatic cleanup: it only reliably removes trailing
            // empty workspaces and skips the active one, so a workspace in the
            // middle would linger after the window left.
            if (st.created && dedicatedWs && manager.get_n_workspaces() > 2) {
                try {
                    const stillAlone = this._isAloneOn(dedicatedWs, win);
                    const notActive = dedicatedWs.index() !== manager.get_active_workspace_index();
                    if (stillAlone && notActive && dedicatedWs.index() >= 0)
                        manager.remove_workspace(dedicatedWs, global.get_current_time());
                } catch (e) {
                    // Leaving an empty workspace is harmless; never let cleanup
                    // break the restore.
                    console.warn('Open Bar: could not remove dedicated workspace: ' + e.message);
                }
            }
        } catch (e) {
            console.warn('Open Bar: could not restore window workspace: ' + e.message);
        } finally {
            // The guard is released by its own timer; nothing to do here.
        }
    }
}


export class IntegrationsManager {
    constructor(ext) {
        this.ext = ext;
        this._settings = ext._settings;
        this._enabled = false;
        this._signalIds = [];
        this.integrations = {
            battery: new BatteryAutohide(ext),
            spacing: new StatusAreaSpacing(ext),
            automove: new AutoMoveWindows(ext),
            gestures: new SwapFingerGestures(ext),
            drives: new DriveMenu(ext),
            fullscreen: new FullscreenEmptyWorkspace(ext),
        };
    }

    enable() {
        if (this._enabled)
            return;
        this._enabled = true;

        const map = {
            'battery-autohide': ['battery', 'battery-autohide'],
            'status-spacing-enabled': ['spacing', 'status-spacing-enabled'],
            'auto-move-windows': ['automove', 'auto-move-windows'],
            'swap-finger-gestures': ['gestures', 'swap-finger-gestures'],
            'drive-menu-enabled': ['drives', 'drive-menu-enabled'],
            'fullscreen-new-workspace': ['fullscreen', 'fullscreen-new-workspace'],
        };

        for (const [key, [name, settingKey]] of Object.entries(map)) {
            this._signalIds.push(this._settings.connect(`changed::${key}`, () => {
                if (this.ext.disabling)
                    return;
                const on = this._settings.get_boolean(settingKey);
                try {
                    if (on)
                        this.integrations[name].enable();
                    else
                        this.integrations[name].disable();
                } catch (e) {
                    console.warn(`Open Bar: integration ${name} toggle failed: ${e.message}`);
                }
            }));
            if (this._settings.get_boolean(settingKey)) {
                try {
                    this.integrations[name].enable();
                } catch (e) {
                    console.warn(`Open Bar: integration ${name} start failed: ${e.message}`);
                }
            }
        }
    }

    disable() {
        this._enabled = false;
        this._signalIds.forEach(id => {
            try { this._settings.disconnect(id); } catch (e) {}
        });
        this._signalIds = [];

        for (const [name, integration] of Object.entries(this.integrations)) {
            try {
                integration.disable();
            } catch (e) {
                console.warn(`Open Bar: integration ${name} stop failed: ${e.message}`);
            }
        }
    }
}
