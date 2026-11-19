// unite.js
//
// Maximized-window controls and window title in the top bar, ported from Unite
// (unite@hardpixel.eu). Only the two core pieces are kept: a button group for
// minimize/maximize/close of the focused window, and an AppMenu label showing
// that window's title. Panel spacing and the legacy tray are deliberately not
// ported — Open Gnome Box already has status-spacing and the lilypad group.
//
// Window actions call Meta.Window methods directly and window state is read on
// demand, so no window-manager prototype is patched. Buttons use the shell's
// built-in window-*-symbolic icons, which follow the active theme automatically,
// so no external stylesheet is loaded and disable() only has to drop signals
// and destroy the two panel buttons.
//
// Portions adapted from Unite under GPL-2.0-or-later.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import { AppMenu } from 'resource:///org/gnome/shell/ui/appMenu.js';

const SHOW_ALWAYS = 'always';
const SHOW_MAXIMIZED = 'maximized';
const SHOW_TILED = 'tiled';
const SHOW_BOTH = 'both';

const ALL_ACTIONS = ['minimize', 'maximize', 'close'];
const ACTION_ICONS = {
    minimize: 'window-minimize-symbolic',
    maximize: 'window-maximize-symbolic',
    restore: 'window-restore-symbolic',
    close: 'window-close-symbolic',
};

const BUTTON_STYLE = 'width: 22px; height: 22px; border-radius: 4px;';
const BUTTON_HOVER_STYLE = BUTTON_STYLE +
    'background-color: rgba(200, 200, 200, 0.28);';

// Button group: a PanelMenu.Button holding a row of St.Buttons, each showing a
// symbolic window icon. The icons inherit panel foreground color, so they work
// on both light and dark top bars without any stylesheet of their own.
const UniteWindowControls = GObject.registerClass(
class UniteWindowControls extends PanelMenu.Button {
    _init() {
        super._init(0.0, null, true);
        this._controls = new St.BoxLayout({
            style_class: 'window-controls-box',
            style: 'spacing: 2px;',
        });
        this.add_child(this._controls);
        this.add_style_class_name('window-controls');
        this.remove_style_class_name('panel-button');
        this._buttons = new Map();
    }

    addButtons(actions) {
        this._controls.destroy_all_children();
        this._buttons.clear();
        for (const action of actions) {
            if (!ALL_ACTIONS.includes(action))
                continue;
            const button = new St.Button({
                track_hover: true,
                reactive: true,
                can_focus: true,
                style: BUTTON_STYLE,
            });
            const icon = new St.Icon({
                icon_name: action === 'maximize'
                    ? ACTION_ICONS.maximize : ACTION_ICONS[action],
                icon_size: 16,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
                y_expand: true,
            });
            button.set_child(icon);
            button.connect('clicked', () => this._onButtonClicked(action));
            button.connect('notify::hover', () => {
                button.style = button.hover ? BUTTON_HOVER_STYLE : BUTTON_STYLE;
            });
            this._controls.add_child(button);
            this._buttons.set(action, button);
        }
    }

    setMaximized(maximized) {
        const button = this._buttons.get('maximize');
        if (!button)
            return;
        const name = maximized ? ACTION_ICONS.restore : ACTION_ICONS.maximize;
        const icon = button.get_child();
        if (icon && icon.icon_name !== name)
            icon.icon_name = name;
    }

    _onButtonClicked(action) {
        const win = global.display.focus_window;
        if (!win)
            return;
        switch (action) {
        case 'minimize':
            if (win.minimized)
                win.unminimize();
            else
                win.minimize();
            break;
        case 'maximize':
            if (win.get_maximized() === Meta.MaximizeFlags.BOTH)
                win.unmaximize(Meta.MaximizeFlags.BOTH);
            else
                win.maximize(Meta.MaximizeFlags.BOTH);
            break;
        case 'close':
            win.delete(global.get_current_time());
            break;
        default:
            break;
        }
    }

    setVisible(visible) {
        // PanelMenu.Button wraps its actor in a container; set visibility on
        // the container, otherwise the button still occupies panel space.
        this.container.visible = visible;
    }
});

// AppMenu label: app icon + window title, backed by the shell's real AppMenu.
// Adapted from Unite's AppmenuLabel, minus the spinner and tooltip.
const UniteAppMenuLabel = GObject.registerClass(
class UniteAppMenuLabel extends PanelMenu.Button {
    _init() {
        super._init(0.0, null, true);
        this.add_style_class_name('app-menu-label');

        const bin = new St.Bin({ name: 'appMenu' });
        this.add_child(bin);
        this._box = new St.BoxLayout({ style_class: 'panel-status-menu-box' });
        bin.set_child(this._box);

        this._iconBox = new St.Bin({
            style_class: 'app-menu-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._icon = new St.Icon({ icon_size: 16 });
        this._icon.set_fallback_gicon(null);
        this._iconBox.set_child(this._icon);
        this._box.add_child(this._iconBox);

        this._label = new St.Label({
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'app-menu-label-text',
        });
        this._box.add_child(this._label);

        const menu = new AppMenu(this);
        this.setMenu(menu);
        this._menuManager = Main.panel.menuManager;
        this._menuManager.addMenu(menu);

        this._app = null;
        this.reactive = false;
    }

    setApp(app) {
        if (this._app === app)
            return;
        this._app = app;
        if (app)
            this._icon.set_gicon(app.get_icon());
        else
            this._icon.set_gicon(null);
        this.menu.setApp(app);
    }

    setTitle(text) {
        if (this._label.get_text() !== text)
            this._label.set_text(text);
    }

    setReactive(reactive) {
        this.reactive = reactive;
    }

    setVisible(visible) {
        if (this.container.visible !== visible) {
            this.container.visible = visible;
            this.set_hover(false);
        }
    }

    setMaxWidth(width) {
        this._label.set_style(width > 0 ? `max-width: ${width}px;` : '');
    }

    _onDestroy() {
        if (this.menu) {
            this._menuManager.removeMenu(this.menu);
            this._menuManager = null;
            this.menu.setApp(null);
            this.setMenu(null);
        }
        super._onDestroy();
    }
});

export class UniteEnhancements {
    constructor(ext) {
        this.ext = ext;
        this._settings = ext._settings;
        this._enabled = false;
        this._signalIds = [];
        this._windowSignalIds = new Map();
        this._settingsIds = [];
        this._controls = null;
        this._label = null;
        this._currentOrder = null;
    }

    enable() {
        if (this._enabled)
            return;
        if (!Main.panel || !global.display) {
            console.error('Open Gnome Box: Unite enhancements cannot run: no panel or display.');
            return;
        }

        this._enabled = true;
        this._controls = new UniteWindowControls();
        this._label = new UniteAppMenuLabel();
        this._currentOrder = null;
        this._rebuildButtons();

        // addToStatusArea throws on a duplicate role. disable() destroys both
        // buttons, which clears their statusArea slots before a re-enable.
        Main.panel.addToStatusArea('openbarUniteControls', this._controls, -1,
            this._positionBox());
        Main.panel.addToStatusArea('openbarUniteTitle', this._label, 1, 'left');

        this._signalIds.push(global.display.connect(
            'notify::focus-window', () => this._sync()));
        this._signalIds.push(global.display.connect(
            'window-created', (_display, win) => this._trackWindow(win)));
        this._signalIds.push(global.display.connect(
            'window-entered-monitor', () => this._sync()));

        for (const actor of global.get_window_actors())
            this._trackWindow(actor.meta_window);
        this._sync();

        for (const key of [
            'unite-buttons-enabled', 'unite-title-enabled',
            'unite-buttons-position', 'unite-buttons-order', 'unite-show-mode',
        ]) {
            this._settingsIds.push(this._settings.connect(`changed::${key}`,
                () => this._onSettingChanged(key)));
        }
    }

    disable() {
        if (!this._enabled)
            return;
        this._enabled = false;

        for (const id of this._signalIds) {
            try { global.display.disconnect(id); } catch (e) {}
        }
        this._signalIds = [];
        for (const id of this._settingsIds) {
            try { this._settings.disconnect(id); } catch (e) {}
        }
        this._settingsIds = [];
        for (const [win, ids] of this._windowSignalIds) {
            for (const id of ids) {
                try { win.disconnect(id); } catch (e) {}
            }
        }
        this._windowSignalIds.clear();

        // Destroying the panel buttons triggers _onDestroy (label removes its
        // AppMenu) and frees their statusArea roles.
        if (this._controls) {
            this._controls.destroy();
            this._controls = null;
        }
        if (this._label) {
            this._label.destroy();
            this._label = null;
        }
        this._currentOrder = null;
    }

    // --- window tracking -------------------------------------------------

    _trackWindow(win) {
        if (!win || this._windowSignalIds.has(win))
            return;
        const ids = [
            win.connect('size-changed', () => this._sync()),
            win.connect('notify::title', () => this._sync()),
            win.connect('unmanaged', () => this._forgetWindow(win)),
        ];
        this._windowSignalIds.set(win, ids);
    }

    _forgetWindow(win) {
        const ids = this._windowSignalIds.get(win);
        if (!ids)
            return;
        for (const id of ids) {
            try { win.disconnect(id); } catch (e) {}
        }
        this._windowSignalIds.delete(win);
    }

    _sync() {
        if (!this._enabled || !this._controls || !this._label)
            return;

        const overview = Main.overview.visibleTarget;
        const win = global.display.focus_window;
        const eligible = !!win && this._matchesShowMode(win) && !overview;

        const buttonsOn = eligible && this._settings.get_boolean('unite-buttons-enabled');
        this._controls.setVisible(buttonsOn);
        if (buttonsOn)
            this._controls.setMaximized(win.get_maximized() === Meta.MaximizeFlags.BOTH);

        const titleOn = eligible && this._settings.get_boolean('unite-title-enabled');
        this._label.setVisible(titleOn);
        this._label.setReactive(titleOn);
        if (titleOn) {
            this._label.setApp(Shell.WindowTracker.get_default()?.focus_app ?? null);
            this._label.setTitle(win.get_title() ?? '');
        }
    }

    _matchesShowMode(win) {
        const mode = this._settings.get_string('unite-show-mode');
        const maximized = win.get_maximized();
        const both = maximized === Meta.MaximizeFlags.BOTH;
        const any = maximized !== Meta.MaximizeFlags.NONE;
        switch (mode) {
        case SHOW_ALWAYS:
            return true;
        case SHOW_MAXIMIZED:
            return both;
        case SHOW_TILED:
            return any && !both;
        case SHOW_BOTH:
            return any;
        default:
            return both;
        }
    }

    _parseOrder() {
        const raw = this._settings.get_string('unite-buttons-order');
        return raw.split(',')
            .map(value => value.trim())
            .filter(value => ALL_ACTIONS.includes(value));
    }

    _rebuildButtons() {
        if (!this._controls)
            return;
        const order = this._parseOrder();
        const key = order.join(',');
        if (key !== this._currentOrder) {
            this._currentOrder = key;
            this._controls.addButtons(order);
        }
    }

    // --- settings --------------------------------------------------------

    _positionBox() {
        return this._settings.get_string('unite-buttons-position') === 'left'
            ? 'left' : 'right';
    }

    _onSettingChanged(key) {
        if (!this._enabled)
            return;
        if (key === 'unite-buttons-position')
            this._repositionControls();
        else if (key === 'unite-buttons-order')
            this._rebuildButtons();
        this._sync();
    }

    _repositionControls() {
        if (!this._controls)
            return;
        const target = this._positionBox() === 'left'
            ? Main.panel._leftBox : Main.panel._rightBox;
        const container = this._controls.container;
        if (!container || container.get_parent() === target)
            return;
        if (container.get_parent())
            container.get_parent().remove_child(container);
        target.add_child(container);
    }
}
