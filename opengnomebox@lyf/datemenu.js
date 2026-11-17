// datemenu.js
//
// Date menu clock formatting, ported from Date Menu Formatter
// (date-menu-formatter@marcinjakubowski.github.com).
//
// The shell's own clock label (DateMenuButton._clockDisplay) is removed from the
// button and replaced by a label whose text comes from a Luxon pattern. When the
// feature is turned off the original label is put back, so nothing about the
// shell's clock is left modified.
//
// GPL-2.0-or-later, same as the rest of Open Gnome Box.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    FONT_WEIGHT_OPTIONS,
    TEXT_ALIGN_OPTIONS,
    formatPattern,
} from './dateformat.js';

const PREFIX = 'date-menu-format-';

// Same refresh levels as the source extension: 0 is once a minute, 1..15 are
// that many updates per second, split over two priorities like the original.
function updateLevel(level) {
    if (level === 0)
        return { priority: GLib.PRIORITY_DEFAULT_IDLE, timeout: 60 * 1000 };
    if (level >= 1 && level <= 7)
        return { priority: GLib.PRIORITY_DEFAULT, timeout: Math.round(1000 / level) };
    if (level >= 8 && level <= 15)
        return { priority: GLib.PRIORITY_HIGH, timeout: Math.round(1000 / level) };
    return { priority: GLib.PRIORITY_DEFAULT, timeout: 1000 };
}

function pick(value, allowed, fallback) {
    return allowed.includes(value) ? value : fallback;
}

export class DateMenuFormatter {
    constructor(ext) {
        this.ext = ext;
        this._settings = ext._settings;
        this._enabled = false;
        this._settingsId = 0;
        this._timerId = 0;
        this._displays = new Map();
        this._lastError = '';
    }

    enable() {
        if (this._enabled)
            return;

        const dateMenu = Main.panel.statusArea?.dateMenu;
        const container = dateMenu?.get_children?.()[0];
        const clock = dateMenu?._clockDisplay;
        if (!container || !clock) {
            // The whole feature depends on this private structure. Say so
            // instead of leaving a half-applied clock behind.
            console.error('Open Gnome Box: date menu clock formatter cannot run: ' +
                'DateMenuButton._clockDisplay or its container is missing in this ' +
                `GNOME Shell version (${Main.sessionMode?.currentMode ?? 'unknown'} session).`);
            return;
        }

        this._enabled = true;
        this._settingsId = this._settings.connect('changed', (_settings, key) => {
            if (!this._enabled || !key.startsWith(PREFIX) || key === `${PREFIX}enabled`)
                return;
            this._apply();
            this._restartTimer();
        });

        this._apply();
        this._restartTimer();
    }

    disable() {
        if (!this._enabled)
            return;
        this._enabled = false;

        if (this._settingsId) {
            this._settings.disconnect(this._settingsId);
            this._settingsId = 0;
        }
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }

        const { affected, unaffected } = this._getPanels();
        for (const panel of affected)
            this._applyOn(panel, false);
        for (const panel of unaffected)
            this._applyOn(panel, false);
        this._displays.forEach(display => display.destroy());
        this._displays.clear();
        this._lastError = '';
    }

    // Dash to Panel keeps its own panel objects. Without it there is one panel.
    // "Apply to all panels" mirrors the source extension's switch.
    _getPanels() {
        const mainPanel = Main.panel;
        const dtp = global.dashToPanel;
        if (!dtp || !Array.isArray(dtp.panels) || dtp.panels.length === 0)
            return { affected: [mainPanel], unaffected: [] };

        if (this._settings.get_boolean(`${PREFIX}all-panels`))
            return { affected: dtp.panels.slice(), unaffected: [] };

        // The primary Dash to Panel panel shares Main.panel's dateMenu; only the
        // remaining panels need the original clock back.
        const mainDateMenu = mainPanel.statusArea?.dateMenu;
        return {
            affected: [mainPanel],
            unaffected: dtp.panels.filter(panel => panel.statusArea?.dateMenu !== mainDateMenu),
        };
    }

    _displayFor(dateMenu) {
        let display = this._displays.get(dateMenu);
        if (!display) {
            display = new St.Label({
                style_class: 'clock',
                text: '...',
                y_align: Clutter.ActorAlign.CENTER,
            });
            display.clutter_text.y_align = Clutter.ActorAlign.CENTER;
            this._displays.set(dateMenu, display);
        }
        return display;
    }

    _applyOn(panel, active) {
        const dateMenu = panel.statusArea?.dateMenu;
        if (!dateMenu)
            return;
        const container = dateMenu.get_children()[0];
        const clock = dateMenu._clockDisplay;
        if (!container || !clock)
            return;

        if (active) {
            const display = this._displayFor(dateMenu);
            if (display.get_parent() !== container) {
                if (display.get_parent())
                    display.get_parent().remove_child(display);
                container.insert_child_at_index(display, 1);
            }
            if (clock.get_parent() === container)
                container.remove_child(clock);
        } else {
            if (clock.get_parent() !== container)
                container.insert_child_at_index(clock, 1);
            const display = this._displays.get(dateMenu);
            if (display?.get_parent())
                display.get_parent().remove_child(display);
        }
    }

    _apply() {
        // An empty pattern means "nothing to render": keep the shell clock
        // attached so it keeps updating, instead of showing frozen text.
        const active = this._settings.get_string(`${PREFIX}pattern`).trim().length > 0;
        const { affected, unaffected } = this._getPanels();
        if (active) {
            for (const panel of affected)
                this._applyOn(panel, true);
            for (const panel of unaffected)
                this._applyOn(panel, false);
        } else {
            for (const panel of [...affected, ...unaffected])
                this._applyOn(panel, false);
        }
        this._applyStyle();
        this._update();
    }

    _applyStyle() {
        const fontSize = this._settings.get_int(`${PREFIX}font-size`);
        const weight = pick(this._settings.get_string(`${PREFIX}font-weight`),
            FONT_WEIGHT_OPTIONS, 'initial');
        const align = pick(this._settings.get_string(`${PREFIX}align`),
            TEXT_ALIGN_OPTIONS, 'center');

        const clutterAlign = align === 'left' ? Clutter.ActorAlign.START
            : align === 'right' ? Clutter.ActorAlign.END
            : Clutter.ActorAlign.CENTER;

        const style = `font-size: ${fontSize}pt; font-weight: ${weight}; text-align: ${align};`;
        this._displays.forEach(display => {
            display.set_style(style);
            display.clutter_text.x_align = clutterAlign;
        });
    }

    _restartTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
        if (!this._enabled)
            return;

        const level = this._settings.get_int(`${PREFIX}update-level`);
        const { priority, timeout } = updateLevel(level);
        this._timerId = GLib.timeout_add(priority, timeout, () => this._update());
    }

    _update() {
        if (!this._enabled)
            return GLib.SOURCE_REMOVE;

        const pattern = this._settings.get_string(`${PREFIX}pattern`);
        if (pattern.trim().length === 0) {
            // Nothing to render; _apply() already put the shell clock back.
            if (this._lastError !== 'empty-pattern') {
                console.warn('Open Gnome Box: date menu pattern is empty; ' +
                    'showing the shell clock until a pattern is set.');
                this._lastError = 'empty-pattern';
            }
            return GLib.SOURCE_CONTINUE;
        }

        let text;
        try {
            text = formatPattern(pattern, new Date(), {
                locale: this._settings.get_string(`${PREFIX}locale`),
                timezone: this._settings.get_string(`${PREFIX}timezone`),
                calendar: this._settings.get_string(`${PREFIX}calendar`),
            });
            this._lastError = '';
        } catch (e) {
            // A broken pattern must be visible, not silently replaced every
            // second: log once per distinct message and hand the panel back to
            // the shell clock, which stays correct and keeps ticking.
            if (this._lastError !== e.message) {
                console.error(`Open Gnome Box: date menu pattern "${pattern}" failed: ${e.message}`);
                this._lastError = e.message;
            }
            const { affected, unaffected } = this._getPanels();
            for (const panel of [...affected, ...unaffected])
                this._applyOn(panel, false);
            return GLib.SOURCE_CONTINUE;
        }

        this._displays.forEach(display => {
            if (display.text !== text)
                display.text = text;
        });
        return GLib.SOURCE_CONTINUE;
    }
}
