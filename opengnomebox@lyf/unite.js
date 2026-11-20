// unite.js
//
// Maximized-window controls and window title in the top bar, ported from Unite
// (unite@hardpixel.eu). Only the two core pieces are kept: a button group for
// minimize/maximize/close of the focused window, and an AppMenu label showing
// that window's title. Panel spacing and the legacy tray are deliberately not
// ported — Open Gnome Box already has status-spacing and the lilypad group.
//
// Window actions call Meta.Window methods directly and window state is read on
// demand, so no window-manager prototype is patched. Button icons are loaded
// from the bundled Unite default theme as GFileIcons (Unite's own "icon scale
// workaround" mode): each action has default/hover/active SVGs for dark and
// light panels. Using absolute-path GFileIcons avoids loading any St stylesheet,
// which is what caused the _st_theme_resolve_url crash when a theme with
// relative url() was repeatedly loaded and unloaded.
//
// Portions adapted from Unite under GPL-2.0-or-later.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import { AppMenu } from 'resource:///org/gnome/shell/ui/appMenu.js';
import * as Utils from './utils.js';

const SHOW_ALWAYS = 'always';
const SHOW_MAXIMIZED = 'maximized';
const SHOW_TILED = 'tiled';
const SHOW_BOTH = 'both';

const ALL_ACTIONS = ['minimize', 'maximize', 'close'];

const BUTTON_STYLE = 'width: 22px; height: 22px; border-radius: 4px;';
const HSP_DARK_THRESHOLD = 127.6;

// Button group: a PanelMenu.Button holding a row of St.Buttons. Each button
// shows one of three SVG states from the current theme variant (dark/light),
// switched on hover and press like Unite's workaround mode.
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
        this._icons = null;
        this._dark = true;
    }

    // icons: { minimize: {default,hover,active}, ... } for one variant.
    setIcons(icons, dark) {
        this._icons = icons;
        this._dark = dark;
        for (const [action, entry] of this._buttons)
            entry.icon.set_gicon(icons[action]?.default ?? null);
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
                icon_size: 16,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
                y_expand: true,
            });
            if (this._icons?.[action])
                icon.set_gicon(this._icons[action].default);
            button.set_child(icon);
            button.connect('clicked', () => this._onButtonClicked(action));
            button.connect('notify::hover', () => this._updateIconState(action));
            button.connect('notify::pressed', () => this._updateIconState(action));
            this._controls.add_child(button);
            this._buttons.set(action, { button, icon });
        }
    }

    _updateIconState(action) {
        const entry = this._buttons.get(action);
        const states = this._icons?.[action];
        if (!entry || !states)
            return;
        const state = entry.button.pressed ? 'active'
            : entry.button.hover ? 'hover' : 'default';
        entry.icon.set_gicon(states[state] ?? states.default);
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
            if (win.maximized_horizontally && win.maximized_vertically)
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
        this._path = ext.path;
        this._settings = ext._settings;
        this._enabled = false;
        this._signalIds = [];
        this._overviewIds = [];
        this._windowSignalIds = new Map();
        this._settingsIds = [];
        this._panelStyleId = 0;
        this._controls = null;
        this._label = null;
        this._currentOrder = null;
        this._themeIcons = new Map();
    }

    enable() {
        if (this._enabled)
            return;
        if (!Main.panel || !global.display) {
            console.error('Open Gnome Box: Unite enhancements cannot run: no panel or display.');
            return;
        }

        this._enabled = true;
        this._loadThemeIcons();
        this._controls = new UniteWindowControls();
        this._label = new UniteAppMenuLabel();
        this._currentOrder = null;
        this._rebuildButtons();
        this._applyPanelStyle();

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

        // Leaving the overview does not necessarily fire focus-window; resync
        // on both transitions so the title and buttons come back reliably.
        this._overviewIds.push(Main.overview.connect('showing', () => this._sync()));
        this._overviewIds.push(Main.overview.connect('hiding', () => this._sync()));

        this._panelStyleId = Main.panel.connect('style-changed',
            () => this._applyPanelStyle());

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
        for (const id of this._overviewIds) {
            try { Main.overview.disconnect(id); } catch (e) {}
        }
        this._overviewIds = [];
        if (this._panelStyleId) {
            try { Main.panel.disconnect(this._panelStyleId); } catch (e) {}
            this._panelStyleId = 0;
        }
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
        this._themeIcons.clear();

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

    // --- icons -----------------------------------------------------------

    _loadThemeIcons() {
        const base = GLib.build_filenamev([
            this._path, 'media', 'unite-themes', 'default',
        ]);
        this._themeIcons.clear();
        for (const variant of ['dark', 'light']) {
            const dir = GLib.build_filenamev([base, variant]);
            const states = {};
            for (const action of ALL_ACTIONS) {
                states[action] = {};
                for (const state of ['default', 'hover', 'active']) {
                    const suffix = state === 'default' ? '' : `-${state}`;
                    const path = GLib.build_filenamev([dir, `${action}${suffix}.svg`]);
                    states[action][state] = Gio.icon_new_for_string(path);
                }
            }
            this._themeIcons.set(variant, states);
        }
    }

    _applyPanelStyle() {
        if (!this._controls)
            return;
        const color = Main.panel.get_theme_node().get_background_color();
        const hsp = Utils.getHSP(color.red, color.green, color.blue);
        const dark = hsp < HSP_DARK_THRESHOLD;
        this._controls.setIcons(this._themeIcons.get(dark ? 'dark' : 'light'), dark);
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
        const both = win.maximized_horizontally && win.maximized_vertically;
        const any = win.maximized_horizontally || win.maximized_vertically;
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
            this._controls.setIcons(
                this._themeIcons.get(this._controls._dark ? 'dark' : 'light'),
                this._controls._dark);
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
