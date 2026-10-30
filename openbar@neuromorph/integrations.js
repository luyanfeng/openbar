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
import * as StyleSheets from './stylesheets.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

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
        this._maximized = new Map();   // window id -> 'reorder'
        this._sizeChange = new Map();  // window id -> 'place' | 'back'
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

        connect('unminimize', act => this._onMap(act));
        connect('size-changed', act => this._onSizeChanged(act));
        connect('minimize', act => this._restore(act));
        connect('map', act => this._onMap(act));
        connect('destroy', act => this._restore(act));
        connect('size-change', (act, change, rectOld) => this._onSizeChange(act, change, rectOld));

        this._signalIds.push(this._settings.connect('changed::fullscreen-maximized-too', () => {
            // Nothing to recompute; the flag is read on demand.
        }));
    }

    disable() {
        this._enabled = false;
        this._signalIds.forEach(id => {
            try { this._settings.disconnect(id); } catch (e) {}
        });
        this._signalIds = [];

        try {
            const wm = global.window_manager;
            this._handles.forEach(h => {
                try { wm.disconnect(h); } catch (e) {}
            });
        } catch (e) {}
        this._handles = [];
        this._maximized.clear();
        this._sizeChange.clear();
        this._mutterSettings = null;
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

    _isNormal(win) {
        return win && win.window_type === Meta.WindowType.NORMAL &&
            !win.is_always_on_all_workspaces();
    }

    _shouldPlace(win) {
        if (!this._isNormal(win))
            return false;
        return this._maximizedToo() ? win.is_maximized() : win.fullscreen;
    }

    // Nearest workspace with no windows on this monitor. Prefers the closest
    // index to `fromIndex` so the window does not jump further than necessary.
    _firstFree(manager, monitor, fromIndex = 0) {
        const n = manager.get_n_workspaces();
        const free = [];
        for (let i = 0; i < n; i++) {
            const count = manager.get_workspace_by_index(i).list_windows()
                .filter(w => !w.is_always_on_all_workspaces() && w.get_monitor() === monitor).length;
            if (count < 1)
                free.push(i);
        }
        if (free.length === 0)
            return -1;
        free.sort((a, b) => Math.abs(a - fromIndex) - Math.abs(b - fromIndex));
        return free[0];
    }

    // Last occupied workspace before/after the current one, or -1.
    _lastOccupied(manager, current, monitor) {
        for (let i = current - 1; i >= 0; i--) {
            const count = manager.get_workspace_by_index(i).list_windows()
                .filter(w => !w.is_always_on_all_workspaces() && w.get_monitor() === monitor).length;
            if (count > 0)
                return i;
        }
        const n = manager.get_n_workspaces();
        for (let i = current + 1; i < n; i++) {
            const count = manager.get_workspace_by_index(i).list_windows()
                .filter(w => !w.is_always_on_all_workspaces() && w.get_monitor() === monitor).length;
            if (count > 0)
                return i;
        }
        return -1;
    }

    _primaryOnly() {
        try {
            return this._mutterSettings?.get_boolean('workspaces-only-on-primary') ?? true;
        } catch (e) {
            return true;
        }
    }

    _place(win) {
        try {
            const monitor = win.get_monitor();
            const others = win.get_workspace().list_windows()
                .filter(w => w !== win && !w.is_always_on_all_workspaces() && w.get_monitor() === monitor);
            if (others.length < 1)
                return;

            const manager = win.get_display().get_workspace_manager();
            const current = manager.get_active_workspace_index();
            const primaryOnly = this._primaryOnly();
            let free = this._firstFree(manager, monitor, current);

            // With dynamic workspaces there may be no empty workspace yet: the
            // last one is only created on demand. Create one instead of giving
            // up, so a window on a full workspace still gets its own space.
            if (free === -1) {
                try {
                    const newIndex = manager.get_n_workspaces();
                    manager.append_new_workspace(false, global.get_current_time());
                    if (manager.get_n_workspaces() > newIndex)
                        free = newIndex;
                } catch (e) {
                    console.warn('Open Bar: could not create workspace: ' + e.message);
                }
            }

            const primary = win.get_display().get_primary_monitor();

            if (primaryOnly) {
                if (monitor !== primary)
                    return;
                if (free === -1)
                    return;
                // Record the origin before touching anything.
                const originRecord = this._rememberOrigin(win);
                // Move the window itself onto the empty workspace. Reordering
                // earlier only moved the whole workspace around and left the
                // window on its origin workspace, which is why the feature
                // appeared to do nothing.
                const targetWs = manager.get_workspace_by_index(free);
                if (!targetWs)
                    return;
                win.change_workspace(targetWs);
                this._maximized.set(win.get_id(), originRecord);
                console.log(`Open Bar[place]: originIdx=${originRecord?.index} ` +
                    `current=${current} free=${free} ` +
                    `winNowIdx=${win.get_workspace()?.index()}`);
                // Follow the window so the user sees the fullscreen window.
                try {
                    const winWs = win.get_workspace();
                    if (winWs && winWs.index() !== manager.get_active_workspace_index())
                        winWs.activate(global.get_current_time());
                } catch (e) {
                    console.warn('Open Bar: could not switch to the window workspace: ' + e.message);
                }
            } else {
                if (free === -1)
                    return;
                const originRecord2 = this._rememberOrigin(win);
                // Move the window itself to the empty workspace, same as the
                // primary-only path.
                const targetWs = manager.get_workspace_by_index(free);
                if (!targetWs) {
                    this._maximized.set(win.get_id(), originRecord2);
                    return;
                }
                win.change_workspace(targetWs);
                this._maximized.set(win.get_id(), originRecord2);
            }
        } catch (e) {
            console.warn('Open Bar: could not place window on empty workspace: ' + e.message);
        }
    }

    // Record where the window lived so _restore can put it back precisely.
    // Storing the index as well as the object matters: with dynamic workspaces
    // the object can be merged away, but the index always resolves.
    _rememberOrigin(win) {
        try {
            const ws = win.get_workspace();
            if (!ws)
                return null;
            return { ws, index: ws.index() };
        } catch (e) {
            return null;
        }
    }

    _restore(act) {
        try {
            const win = act?.meta_window;
            if (!win || !this._isNormal(win))
                return;
            const id = win.get_id();
            if (!this._maximized.has(id))
                return;
            const record = this._maximized.get(id);
            this._maximized.delete(id);

            const manager = win.get_display().get_workspace_manager();

            // Move the window back to the workspace it came from. _place() no
            // longer reorders workspaces, so both the object and its index stay
            // stable; the index is only a fallback if the object was merged away
            // by dynamic-workspace management.
            const originWs = record?.ws;
            const originIndex = record?.index;
            if (originWs || Number.isInteger(originIndex)) {
                let target = null;
                try {
                    if (originWs && originWs.index() >= 0)
                        target = originWs;
                } catch (e) {
                    target = null;
                }
                if (!target && Number.isInteger(originIndex) &&
                    originIndex >= 0 && originIndex < manager.get_n_workspaces())
                    target = manager.get_workspace_by_index(originIndex);

                if (target) {
                    try {
                        if (win.get_workspace()?.index() !== target.index())
                            win.change_workspace(target);
                    } catch (e) {
                        console.warn('Open Bar: could not move window back: ' + e.message);
                    }
                    console.log(`Open Bar[restore]: originIdx=${originIndex} ` +
                        `targetIdx=${target.index()} winIdx=${win.get_workspace()?.index()}`);
                    try {
                        if (target.index() !== manager.get_active_workspace_index())
                            target.activate(global.get_current_time());
                    } catch (e) {}
                    return;
                }
            }

            // Fallback (no record): merge with the nearest workspace that still
            // has windows on this monitor.
            const current = manager.get_active_workspace_index();
            const monitor = win.get_monitor();
            const others = win.get_workspace().list_windows()
                .filter(w => w !== win && !w.is_always_on_all_workspaces() && w.get_monitor() === monitor);
            if (others.length !== 0)
                return;

            const last = this._lastOccupied(manager, current, monitor);
            if (last === -1)
                return;

            if (this._primaryOnly()) {
                if (monitor !== win.get_display().get_primary_monitor())
                    return;
                const lastList = manager.get_workspace_by_index(last).list_windows()
                    .filter(w => w !== win && !w.is_always_on_all_workspaces() && w.get_monitor() === monitor);
                manager.reorder_workspace(manager.get_workspace_by_index(current), last);
                lastList.forEach(w => w.change_workspace_by_index(last, false));
            } else {
                const currentList = win.get_workspace().list_windows()
                    .filter(w => w !== win && !w.is_always_on_all_workspaces());
                if (currentList.length > 0)
                    return;
                const lastList = manager.get_workspace_by_index(last).list_windows()
                    .filter(w => w !== win && !w.is_always_on_all_workspaces());
                manager.reorder_workspace(manager.get_workspace_by_index(current), last);
                lastList.forEach(w => w.change_workspace_by_index(last, false));
            }
        } catch (e) {
            console.warn('Open Bar: could not restore window workspace: ' + e.message);
        }
    }

    _onMap(act) {
        const win = act?.meta_window;
        const should = this._shouldPlace(win);
        if (should)
            this._place(win);
    }

    _onSizeChange(act, change, rectOld) {
        const win = act?.meta_window;
        if (!this._isNormal(win))
            return;
        const id = win.get_id();
        console.log(`Open Bar[sc]: id=${id} change=${change} max=${win.is_maximized()} ` +
            `fs=${win.fullscreen} tracked=${this._maximized.has(id)}`);
        if ((this._maximizedToo() && change === Meta.SizeChange.MAXIMIZE && win.is_maximized()) ||
            change === Meta.SizeChange.FULLSCREEN) {
            this._sizeChange.set(id, 'place');
            return;
        }
        const rectMax = win.get_work_area_for_monitor(win.get_monitor());
        const wasFullMax = rectMax.equal(rectOld);
        if ((this._maximizedToo() && change === Meta.SizeChange.UNMAXIMIZE && wasFullMax) ||
            (change === Meta.SizeChange.UNFULLSCREEN && (this._maximizedToo() ? !win.is_maximized() : true))) {
            this._sizeChange.set(id, 'back');
            console.log(`Open Bar[sc]: id=${id} -> back`);
        }
    }

    _onSizeChanged(act) {
        const win = act?.meta_window;
        if (!win)
            return;
        const id = win.get_id();
        const pending = this._sizeChange.get(id);
        if (!pending)
            return;
        if (pending === 'place')
            this._place(win);
        else if (pending === 'back')
            this._restore(act);
        this._sizeChange.delete(id);
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
