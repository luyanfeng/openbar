// lilypad.js
//
// Collapsible top bar indicator group: collect chosen indicators into one
// button, and reorder the rest of the right box.
//
// Ported from Lilypad (lilypad@shendrew.github.io) under GPL-3.0-or-later;
// this file therefore stays GPL-3.0-or-later, unlike the rest of Open Gnome
// Box which is GPL-2.0-or-later.
//
// The panel entry point Panel.Panel.prototype.addToStatusArea is patched while
// the feature is on: every indicator any extension registers afterwards must
// be picked up and placed. disable() restores the original method, which is
// what keeps the rest of the shell working.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Panel from 'resource:///org/gnome/shell/ui/panel.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { PACKAGE_VERSION } from 'resource:///org/gnome/shell/misc/config.js';

const HIDE_NEVER = 0;
const HIDE_ALWAYS = 2;

// Indicator role names come from panel statusArea keys, which may be raw ids
// ("lilypad@shendrew.github.io") or appindicator bus names. Reduce them to a
// stable short name for the order settings.
function getRoleName(role) {
    let roleName = role;
    // appindicator: appindicator-:1.102@/org/ayatana/NotificationItem/dropbox_client_677911
    roleName = roleName.split('/');
    roleName = roleName[roleName.length - 1];
    // extension uuid: foo@bar
    roleName = roleName.split('@')[0];
    // drop stray digits/mixed case from indicator ids
    const keyWords = roleName.match(/((\d)*[A-Z]+(\d)*)+/gi) ?? [];
    return keyWords.join('_');
}

class ContainerService extends GObject.Object {
    static {
        GObject.registerClass({}, this);
    }

    _init(args) {
        super._init();
        this._settings = args.settings ?? null;
    }

    setIconVisibilityListeners(listener) {
        this._iconVisibilityListener = listener;
    }

    _setIconsVisibility(show, destroy = false) {
        for (const actor of this.getGroupedActors()) {
            if (show)
                actor.container.show();
            else
                actor.container.hide();
            this._iconVisibilityListener(actor, show, destroy);
        }
    }

    getGroupedActors() {
        const groupOrder = this._settings.get_strv('lily-group-order');
        const orderActors = [];
        for (const role of this.getOrder()) {
            if (groupOrder.includes(getRoleName(role)))
                orderActors.push(Main.panel.statusArea[role]);
        }
        return orderActors;
    }

    switchIcons(showIcons) {
        this._setIconsVisibility(showIcons);
        this._settings.set_boolean('lily-show-icons', showIcons);
    }

    toggleIcons() {
        const showIcons = this._settings.get_boolean('lily-show-icons') ? 0 : 1;
        this.switchIcons(showIcons);
        return showIcons === 1;
    }

    // Rebuild the right box: every known indicator container is removed and
    // re-inserted in the configured order, with the grouped block inserted at
    // the position of the group button itself.
    arrange() {
        const rightBoxOrder = this._settings.get_strv('lily-rightbox-order');
        const groupOrder = this._settings.get_strv('lily-group-order');
        const showIcons = this._settings.get_boolean('lily-show-icons');
        const roleOrder = this.getOrder();

        // A cleared order collapses the group.
        if (rightBoxOrder.length === 0)
            this._setIconsVisibility(false);

        for (const role of roleOrder) {
            const roleName = getRoleName(role);
            if (!rightBoxOrder.includes(roleName) && !groupOrder.includes(roleName))
                rightBoxOrder.push(roleName);

            const container = Main.panel.statusArea[role].container;
            const boxContainer = container.get_parent();
            if (boxContainer)
                boxContainer.remove_child(container);
        }

        const addGroupedIcons = offset => {
            let numIcons = 0;
            for (const targetRole of groupOrder) {
                for (const groupedRole of roleOrder) {
                    if (targetRole !== getRoleName(groupedRole))
                        continue;
                    const container = Main.panel.statusArea[groupedRole].container;
                    Main.panel._rightBox.insert_child_at_index(container, numIcons + offset);
                    if (showIcons)
                        container.show();
                    else
                        container.hide();
                    numIcons++;
                }
            }
            return numIcons;
        };

        let index = 0;
        for (const settingsRole of rightBoxOrder) {
            for (const role of roleOrder) {
                const roleName = getRoleName(role);
                if (settingsRole !== roleName)
                    continue;

                if (roleName === 'lilypad') {
                    index += addGroupedIcons(index);
                } else if (groupOrder.includes(roleName)) {
                    // Already placed by addGroupedIcons; inserting it again while
                    // it is still parented fails the Clutter parent assertion.
                    continue;
                }

                const container = Main.panel.statusArea[role].container;
                Main.panel._rightBox.insert_child_at_index(container, index);
                index++;
            }
        }

        this._settings.set_strv('lily-rightbox-order', rightBoxOrder);
    }

    // Current order of indicator containers in the right box, as role names.
    getOrder() {
        const ignoredOrder = this._settings.get_strv('lily-ignored-order');
        const groupOrder = this._settings.get_strv('lily-group-order');

        const containerName = new Map();
        for (const role in Main.panel.statusArea) {
            const indicator = Main.panel.statusArea[role];
            if (!indicator || !indicator.container)
                continue;
            containerName.set(indicator.container, role);
        }

        const roleOrder = [];
        const children = Main.panel._rightBox.get_children();
        for (const container of children) {
            if (!container || !container.get_first_child())
                continue;
            const actor = container.get_first_child();

            // Skip containers left behind without cleanup.
            const role = containerName.get(container);
            if (!actor || !role)
                continue;
            const actorName = getRoleName(role);

            if (actorName !== 'lilypad' && !groupOrder.includes(actorName) && !actor.visible)
                continue;
            if (actorName === 'quickSettings' || ignoredOrder.includes(actorName))
                continue;

            roleOrder.push(role);
        }

        return roleOrder;
    }

    destroy() {
        this._setIconsVisibility(true, true);
    }
}

export class LilypadManager {
    constructor(ext) {
        this.ext = ext;
        this._settings = ext._settings;

        this._enabled = false;
        this._indicator = null;
        this._containerService = null;
        this._openIcon = null;
        this._closedIcon = null;
        this._signalIds = [];
        this._timerId = 0;
        this._maxCollapseRetries = 5;

        // GNOME 50 moved panel button click handling to a gesture.
        const [majorVer] = PACKAGE_VERSION.split('.').map(x => parseInt(x));
        this._useLegacyButtonSignals = majorVer < 50;
    }

    enable() {
        if (this._enabled)
            return;
        this._enabled = true;

        this._containerService = new ContainerService({ settings: this._settings });
        this._containerService.setIconVisibilityListeners(
            this._onIconVisibilityChange.bind(this));

        this._loadIcons();

        this._indicator = new PanelMenu.Button(0.5, _('Lilypad'), false);
        this._initIndicator();

        this._patchAddToStatusArea();

        this._signalIds.push(this._settings.connect('changed::lily-reorder',
            () => this._rearrange()));
        this._signalIds.push(this._settings.connect('changed::lily-hide-indicator',
            () => this._updateIndicatorVisibility()));
        this._signalIds.push(this._settings.connect('changed::lily-icon-style',
            () => this._onIconStyleChanged()));

        Main.panel.addToStatusArea('lilypad', this._indicator);
        this._rearrange();
    }

    disable() {
        this._restoreAddToStatusArea();

        this._signalIds.forEach(({ object, id }) => {
            try { object.disconnect(id); } catch (e) {}
        });
        this._signalIds = [];

        if (this._timerId) {
            clearTimeout(this._timerId);
            this._timerId = 0;
        }

        try { this._containerService?.destroy(); } catch (e) {}
        this._containerService = null;

        try { this._indicator?.destroy(); } catch (e) {}
        this._indicator = null;

        try { this._openIcon?.destroy(); } catch (e) {}
        this._openIcon = null;
        try { this._closedIcon?.destroy(); } catch (e) {}
        this._closedIcon = null;

        this._enabled = false;
    }

    // ---- panel entry point patch -------------------------------------------

    // Every indicator registered while the feature is on has to be placed by
    // our arrange(); wrapping addToStatusArea catches them all, including
    // indicators that other extensions add later.
    _patchAddToStatusArea() {
        if (Panel.Panel.prototype._openbarOriginalAddToStatusArea)
            return;

        Panel.Panel.prototype._openbarOriginalAddToStatusArea =
            Panel.Panel.prototype.addToStatusArea;

        const rearrange = () => {
            // The destroy handler below fires when the group button itself is
            // destroyed in disable(), after the service is already gone.
            if (!this._containerService || !this._enabled)
                return;
            this._containerService.arrange();
            this._updateIndicatorVisibility();
        };

        Panel.Panel.prototype.addToStatusArea = function (role, indicator, position, box) {
            this._openbarOriginalAddToStatusArea(role, indicator, position, box);
            const destroyId = indicator.connect('destroy', emitter => {
                rearrange();
                emitter.disconnect(destroyId);
            });
            rearrange();
        };

        this._rearrange = rearrange;
    }

    _restoreAddToStatusArea() {
        if (!Panel.Panel.prototype._openbarOriginalAddToStatusArea)
            return;
        Panel.Panel.prototype.addToStatusArea =
            Panel.Panel.prototype._openbarOriginalAddToStatusArea;
        Panel.Panel.prototype._openbarOriginalAddToStatusArea = null;
        this._rearrange = null;
    }

    _rearrange() {}

    // ---- indicator ---------------------------------------------------------

    _loadIcons() {
        const suffix = this._settings.get_int('lily-icon-style') === 1 ? '_arrow' : '';
        const base = `${this.ext.path}/media/lilypad`;
        this._closedIcon = new StIcon(`${base}/closed_icon${suffix}.svg`);
        this._openIcon = new StIcon(`${base}/open_icon${suffix}.svg`);
    }

    _onIconStyleChanged() {
        const isOpen = this._settings.get_boolean('lily-show-icons');

        this._closedIcon?.destroy();
        this._openIcon?.destroy();
        this._loadIcons();
        this._setIcon(isOpen);
    }

    _initIndicator() {
        this._setIcon(this._settings.get_boolean('lily-show-icons'));

        const settingsItem = new PopupMenu.PopupMenuItem(_('Settings'));
        settingsItem.connect('activate', () => this.ext.openPreferences());
        this._indicator.menu.addMenuItem(settingsItem);

        this._indicator.track_hover = true;

        const onClick = event => {
            switch (event.get_button()) {
            case Clutter.BUTTON_PRIMARY:
                if (!this._updateIndicatorVisibility())
                    break;
                this._toggleIcons();
                this._toggleMenu();
                break;
            case Clutter.BUTTON_MIDDLE:
                this._toggleMenu();
                break;
            }
            return Clutter.EVENT_PROPAGATE;
        };

        if (!this._useLegacyButtonSignals && this._indicator._clickGesture) {
            this._indicator._clickGesture.connect('recognize', onClick);
        } else {
            this._indicator.connect('button-press-event', (_actor, event) => onClick(event));
            this._indicator.connect('touch-event', (_actor, event) => {
                if (event.type() !== Clutter.EventType.TOUCH_BEGIN)
                    return Clutter.EVENT_PROPAGATE;
                if (!this._updateIndicatorVisibility())
                    return Clutter.EVENT_PROPAGATE;
                this._toggleIcons();
                this._toggleMenu();
                return Clutter.EVENT_PROPAGATE;
            });
        }
    }

    _toggleMenu() {
        this._indicator.menu.toggle();
    }

    _toggleIcons() {
        if (this._settings.get_strv('lily-group-order').length === 0) {
            this._setIcon(false);
            return false;
        }

        const isOpen = this._containerService.toggleIcons();
        this._setIcon(isOpen);
        if (isOpen)
            this._startAutoCollapseTimer();
        return isOpen;
    }

    _setIcon(isOpen) {
        if (this._indicator.get_children().length)
            this._indicator.remove_all_children();
        this._indicator.add_child(isOpen ? this._openIcon : this._closedIcon);
    }

    _onIconVisibilityChange(actor, show) {
        actor.track_hover = show;
        for (const menu of Main.panel.menuManager._menus) {
            if (menu.sourceActor === actor)
                menu.actor.track_hover = show;
        }
    }

    _updateIndicatorVisibility() {
        const hide = this._settings.get_int('lily-hide-indicator');

        if (hide === HIDE_NEVER) {
            this._indicator.show();
            return true;
        }
        if (hide === HIDE_ALWAYS) {
            this._containerService.switchIcons(false);
            this._setIcon(false);
            this._indicator.hide();
            return true;
        }

        // Hide when there is nothing grouped.
        if (this._containerService.getGroupedActors().length > 0) {
            this._indicator.show();
            return true;
        }
        this._containerService.switchIcons(false);
        this._setIcon(false);
        this._indicator.hide();
        return false;
    }

    // ---- auto collapse -----------------------------------------------------

    _startAutoCollapseTimer(retries = 0) {
        const autoCollapse = this._settings.get_boolean('lily-auto-collapse');
        const showIcons = this._settings.get_boolean('lily-show-icons');
        if (!showIcons || !autoCollapse)
            return;

        clearTimeout(this._timerId);
        const delay = this._settings.get_int('lily-auto-collapse-millisecond') /
            this._maxCollapseRetries;

        this._timerId = setTimeout(() => {
            this._timerId = 0;
            if (!this._enabled)
                return;

            const detectActors = [this._indicator, ...this._containerService
                .getGroupedActors()
                .filter(actor => actor?.container?.visible)];

            // Only collapse when no grouped menu is open and nothing is hovered.
            let collapse = true;
            for (const menu of Main.panel.menuManager._menus) {
                for (const actor of detectActors) {
                    if ((menu.isOpen === true && menu.sourceActor === actor) || actor.hover) {
                        collapse = false;
                        break;
                    }
                }
                if (!collapse)
                    break;
            }

            if (collapse) {
                if (retries >= this._maxCollapseRetries) {
                    this._containerService.switchIcons(false);
                    this._setIcon(false);
                }
                this._startAutoCollapseTimer(retries + 1);
            } else {
                this._startAutoCollapseTimer(0);
            }
        }, delay);
    }
}

function StIcon(path) {
    return new St.Icon({
        gicon: Gio.icon_new_for_string(path),
        style_class: 'system-status-icon',
        icon_size: 16,
    });
}
