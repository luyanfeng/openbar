// clipboard.js
//
// Built-in clipboard history manager: a panel indicator with a menu listing
// recent clipboard entries, pinning, search, tags, image support and optional
// keybindings.
//
// GPL-2.0-or-later, same as the rest of Open Gnome Box.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as AnimationUtils from 'resource:///org/gnome/shell/misc/animationUtils.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { Registry, ClipboardEntry } from './clipboardRegistry.js';

const CLIPBOARD_TYPE = St.ClipboardType.CLIPBOARD;
const INDICATOR_ICON = 'edit-paste-symbolic';

// Mimetypes probed in order when reading the clipboard. Text wins over images
// because most applications put both on the clipboard for text content.
const CLIPBOARD_MIMETYPES = [
    'text/plain;charset=utf-8',
    'UTF8_STRING',
    'text/plain',
    'STRING',
    'image/gif',
    'image/png',
    'image/jpg',
    'image/jpeg',
    'image/webp',
    'image/svg+xml',
    'text/html',
];

// Delay before the delayed selection applies (keyboard cycling keeps the item
// selected briefly so repeated presses move faster).
const DELAYED_SELECTION_TIMEOUT = 750;

export class ClipboardManager {
    constructor(ext) {
        this.ext = ext;
        this._settings = ext._settings;

        this._enabled = false;
        this._destroyed = false;

        this._indicator = null;
        this._items = [];
        this._historySection = null;
        this._favoritesSection = null;
        this._historyScrollView = null;
        this._favoritesScrollView = null;
        this._scrollViewHistorySection = null;
        this._scrollViewFavoritesSection = null;
        this._favoritesSeparator = null;
        this._historySeparator = null;
        this._entryItem = null;
        this._searchEntry = null;
        this._privateModeItem = null;
        this._clearItem = null;
        this._settingsItem = null;
        this._emptyState = null;
        this._timerLabel = null;
        this._resetTimerButton = null;
        this._icon = null;
        this._buttonText = null;
        this._buttonImagePreview = null;
        this._downArrow = null;
        this._hbox = null;

        this._registry = null;
        this._keyboard = null;
        this._dialogManager = null;
        this._notifSource = null;

        this._signalIds = [];
        this._shortcutNames = [];
        this._settingsChangedId = 0;
        this._selectionOwnerChangedId = 0;
        this._selection = null;

        this._intervalSettingChangedId = 0;
        this._intervalToggleChangedId = 0;
        this._historyClearTimeoutId = 0;
        this._timerIntervalId = 0;

        this._imagePreviewTimeout = 0;
        this._setFocusOnOpenTimeout = 0;
        this._pastingKeypressTimeout = 0;
        this._pastingResetTimeout = 0;
        this._blinkAnimationTimeout = 0;
        this._delayedSelectionTimeoutId = 0;
        this._imagePreviewOverlay = null;

        this._focusItemOnOpen = null;
        this._preventIndicatorUpdate = false;
        this._refreshInProgress = false;
        this._privateMode = false;
        this._cursorActor = null;

        // Mirrors of the settings, refreshed by _fetchSettings().
        this._settingsValues = {};
    }

    // ---- lifecycle ---------------------------------------------------------

    enable() {
        if (this._enabled)
            return;
        this._enabled = true;
        this._destroyed = false;

        this._registry = new Registry({
            settings: this._settings,
            uuid: this.ext.uuid,
        });

        try {
            this._keyboard = new VirtualKeyboard();
        } catch (e) {
            console.warn('Open Gnome Box: clipboard virtual keyboard unavailable: ' + e.message);
            this._keyboard = null;
        }
        this._dialogManager = new DialogManager();

        this._cursorActor = new Clutter.Actor({ opacity: 0, width: 1, height: 1 });
        Main.uiGroup.add_child(this._cursorActor);

        this._fetchSettings();

        this._buildIndicator();

        if (this._settingsValues['clear-on-boot'])
            this._registry.clearCacheFolder();

        this._buildMenu()
            .then(() => {
                if (this._destroyed)
                    return;
                this._updateTopbarLayout();
                this._setupSelectionTracking();
                this._setupHistoryIntervalClearing();
            })
            .catch(e => {
                console.warn('Open Gnome Box: could not build the clipboard menu: ' + e.message);
            });
    }

    disable() {
        this._destroyed = true;
        this._enabled = false;

        this._disconnectSettings();
        this._clearTimerSources();
        this._closeImagePreview();

        try {
            this._dialogManager?.destroy();
        } catch (e) {}
        this._dialogManager = null;

        if (this._selectionOwnerChangedId && this._selection) {
            try {
                this._selection.disconnect(this._selectionOwnerChangedId);
            } catch (e) {}
        }
        this._selectionOwnerChangedId = 0;
        this._selection = null;

        try {
            this._keyboard?.destroy();
        } catch (e) {}
        this._keyboard = null;

        if (this._cursorActor) {
            this._cursorActor.destroy();
            this._cursorActor = null;
        }

        try {
            this._notifSource?.destroy();
        } catch (e) {}
        this._notifSource = null;

        for (const item of this._items) {
            try {
                item.destroy();
            } catch (e) {}
        }
        this._items = [];

        try {
            this._indicator?.destroy();
        } catch (e) {}
        this._indicator = null;

        this._historySection = null;
        this._favoritesSection = null;
        this._historyScrollView = null;
        this._favoritesScrollView = null;
        this._scrollViewHistorySection = null;
        this._scrollViewFavoritesSection = null;
        this._searchEntry = null;
        this._entryItem = null;
        this._privateModeItem = null;
        this._clearItem = null;
        this._settingsItem = null;
        this._emptyState = null;
        this._timerLabel = null;
        this._resetTimerButton = null;
        this._registry = null;
    }

    // ---- settings ----------------------------------------------------------

    _fetchSettings() {
        const s = this._settings;
        const b = k => s.get_boolean(k);
        const i = k => s.get_int(k);
        const strv = k => s.get_strv(k);

        this._settingsValues = {
            'history-size': i('history-size'),
            'preview-size': i('preview-size'),
            'cache-size': i('cache-size'),
            'cache-only-favorites': b('cache-only-favorites'),
            'enable-deletion': b('enable-deletion'),
            'move-item-first': b('move-item-first'),
            'notify-on-copy': b('notify-on-copy'),
            'notify-on-cycle': b('notify-on-cycle'),
            'notify-on-clear': b('notify-on-clear'),
            'confirm-clear': b('confirm-clear'),
            'confirm-pinned-delete': b('confirm-pinned-delete'),
            'enable-keybindings': b('enable-keybindings'),
            'topbar-preview-size': i('topbar-preview-size'),
            'display-mode': i('display-mode'),
            'disable-down-arrow': b('disable-down-arrow'),
            'blink-icon-on-copy': b('blink-icon-on-copy'),
            'strip-text': b('strip-text'),
            'keep-selected-on-clear': b('keep-selected-on-clear'),
            'paste-button': b('paste-button'),
            'pinned-on-bottom': b('pinned-on-bottom'),
            'cache-images': b('cache-images'),
            'excluded-apps': strv('excluded-apps'),
            'clear-history-on-interval': b('clear-history-on-interval'),
            'clear-history-interval': i('clear-history-interval'),
            'next-history-clear': i('next-history-clear'),
            'case-sensitive-search': b('case-sensitive-search'),
            'regex-search': b('regex-search'),
            'open-at-cursor': b('open-at-cursor'),
            'show-search-bar': b('show-search-bar'),
            'show-private-mode': b('show-private-mode'),
            'show-settings-button': b('show-settings-button'),
            'show-clear-history-button': b('show-clear-history-button'),
            'show-delete-button': b('show-delete-button'),
            'show-tag-button': b('show-tag-button'),
            'show-pin-button': b('show-pin-button'),
            'show-edit-button': b('show-edit-button'),
            'show-preview-button': b('show-preview-button'),
            'paste-on-select': b('paste-on-select'),
            'clear-on-boot': b('clear-on-boot'),
        };
    }

    _onSettingsChanged() {
        if (this._destroyed)
            return;
        try {
            this._fetchSettings();

            // A hidden private-mode switch cannot stay active.
            if (!this._settingsValues['show-private-mode'] && this._privateMode && this._privateModeItem) {
                this._privateModeItem.setToggleState(false);
                this._onPrivateModeSwitch();
            }

            this._removeOldestEntries();

            for (const item of this._allItems()) {
                this._setEntryLabel(item);
                item.pasteBtn.visible = this._settingsValues['paste-button'];
                item.deleteBtn.visible = this._settingsValues['show-delete-button'];
                item.tagBtn.visible = this._settingsValues['show-tag-button'];
                item.pinBtn.visible = this._settingsValues['show-pin-button'];
                if (item.editBtn)
                    item.editBtn.visible = this._settingsValues['show-edit-button'];
                if (item.previewBtn)
                    item.previewBtn.visible = this._settingsValues['show-preview-button'];
            }

            this._updateTopbarLayout();
            this._showElements();
        } catch (e) {
            console.warn('Open Gnome Box: clipboard settings update failed: ' + e.message);
        }
    }

    _connectSettings() {
        this._settingsChangedId = this._settings.connect('changed', () => this._onSettingsChanged());
        this._signalIds.push(this._settingsChangedId);
    }

    _disconnectSettings() {
        for (const id of this._signalIds) {
            try {
                this._settings.disconnect(id);
            } catch (e) {}
        }
        this._signalIds = [];
        this._settingsChangedId = 0;
    }

    // ---- indicator ---------------------------------------------------------

    _buildIndicator() {
        this._indicator = new PanelMenu.Button(0.0, 'openbar-clipboard', false);

        this._hbox = new St.BoxLayout({ style_class: 'panel-status-menu-box clipboard-indicator-hbox' });
        this._icon = new St.Icon({
            icon_name: INDICATOR_ICON,
            style_class: 'system-status-icon clipboard-indicator-icon',
        });
        this._buttonText = new St.Label({ text: '', y_align: Clutter.ActorAlign.CENTER });
        this._buttonImagePreview = new St.Bin({ style_class: 'clipboard-indicator-topbar-preview' });

        this._hbox.add_child(this._icon);
        this._hbox.add_child(this._buttonText);
        this._hbox.add_child(this._buttonImagePreview);
        this._downArrow = PopupMenu.arrowIcon(St.Side.BOTTOM);
        this._hbox.add_child(this._downArrow);

        this._indicator.add_child(this._hbox);
        Main.panel.addToStatusArea('openbar-clipboard', this._indicator, 1, 'right');

        this._indicator.menu.connect('open-state-changed', (menu, isOpen) => {
            if (!isOpen)
                menu.sourceActor = this._indicator;
        });
    }

    _updateTopbarLayout() {
        const mode = this._settingsValues['display-mode'];
        if (!this._indicator)
            return;

        // 0 = icon only, 1 = clipboard content, 2 = both, 3 = neither.
        this._icon.visible = mode === 0 || mode === 2;
        this._buttonText.visible = mode === 1 || mode === 2;
        this._buttonImagePreview.visible = mode === 1 || mode === 2;

        if (mode === 3)
            this._indicator.hide();
        else
            this._indicator.show();

        this._downArrow.visible = !this._settingsValues['disable-down-arrow'];
    }

    _updateIndicatorContent(entry) {
        const mode = this._settingsValues['display-mode'];
        if (this._preventIndicatorUpdate || (mode !== 1 && mode !== 2))
            return;
        if (!this._buttonText || !this._buttonImagePreview)
            return;

        if (!entry || this._privateMode) {
            this._buttonImagePreview.destroy_all_children();
            this._buttonText.set_text('...');
            return;
        }

        if (entry.isText()) {
            this._buttonText.set_text(this._truncate(entry.getStringValue(),
                this._settingsValues['topbar-preview-size']));
            this._buttonImagePreview.destroy_all_children();
        } else if (entry.isImage()) {
            this._buttonText.set_text('');
            this._buttonImagePreview.destroy_all_children();
            this._registry.getEntryAsImage(entry).then(img => {
                if (!img || this._destroyed)
                    return;
                img.add_style_class_name('clipboard-indicator-img-preview');
                img.y_align = Clutter.ActorAlign.CENTER;
                // The icon only renders correctly once the main loop has run.
                this._imagePreviewTimeout = setTimeout(() => {
                    this._imagePreviewTimeout = 0;
                    if (this._buttonImagePreview)
                        this._buttonImagePreview.set_child(img);
                }, 0);
            }).catch(e => {
                console.warn('Open Gnome Box: clipboard topbar preview failed: ' + e.message);
            });
        }
    }

    _blinkIcon() {
        if (!this._settingsValues['blink-icon-on-copy'] || !this._icon)
            return;

        this._indicator.set_style('background-color: rgba(255, 255, 255, 0.9);');
        this._icon.set_style('color: rgba(0, 0, 0, 0.9);');

        this._blinkAnimationTimeout = setTimeout(() => {
            this._blinkAnimationTimeout = 0;
            if (this._destroyed)
                return;
            this._indicator?.set_style(null);
            this._icon?.set_style(null);
        }, 200);
    }

    // ---- menu --------------------------------------------------------------

    async _buildMenu() {
        const history = await this._registry.read();
        if (this._destroyed)
            return;

        const lastIdx = history.length - 1;

        // Search entry, inside a non-reactive item so the menu keeps focus.
        this._entryItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        this._entryItem.add_style_class_name('clipboard-indicator-search');
        this._searchEntry = new St.Entry({
            name: 'searchEntry',
            style_class: 'search-entry',
            can_focus: true,
            hint_text: _('Type here to search...'),
            track_hover: true,
            x_expand: true,
            y_expand: true,
            primary_icon: new St.Icon({ icon_name: 'edit-find-symbolic' }),
        });
        this._searchEntry.get_clutter_text().connect('text-changed', () => this._onSearchTextChanged());
        this._entryItem.add_child(this._searchEntry);

        this._indicator.menu.connect('open-state-changed', (menu, open) => {
            this._setFocusOnOpenTimeout = setTimeout(() => {
                this._setFocusOnOpenTimeout = 0;
                if (!open || this._destroyed)
                    return;

                if (this._focusItemOnOpen) {
                    const item = this._focusItemOnOpen;
                    this._focusItemOnOpen = null;
                    global.stage.set_key_focus(item.actor);
                } else if (this._settingsValues['show-search-bar'] && this._items.length > 0) {
                    this._searchEntry.set_text('');
                    global.stage.set_key_focus(this._searchEntry);
                } else if (this._items.length > 0) {
                    const current = this._getCurrentlySelectedItem();
                    if (current)
                        global.stage.set_key_focus(current.actor);
                } else if (this._settingsValues['show-private-mode'] && this._privateModeItem) {
                    global.stage.set_key_focus(this._privateModeItem.actor);
                }
            }, 50);
        });

        // Pinned and history lists, each in its own scroll view.
        this._favoritesSection = new PopupMenu.PopupMenuSection();
        this._scrollViewFavoritesSection = new PopupMenu.PopupMenuSection();
        this._favoritesScrollView = new St.ScrollView({
            style_class: 'ci-history-menu-section',
            overlay_scrollbars: true,
        });
        this._favoritesScrollView.add_child(this._favoritesSection.actor);
        this._scrollViewFavoritesSection.actor.add_child(this._favoritesScrollView);
        this._favoritesSeparator = new PopupMenu.PopupSeparatorMenuItem();

        this._historySection = new PopupMenu.PopupMenuSection();
        this._scrollViewHistorySection = new PopupMenu.PopupMenuSection();
        this._historyScrollView = new St.ScrollView({
            style_class: 'ci-main-menu-section ci-history-menu-section',
            overlay_scrollbars: true,
        });
        this._historyScrollView.add_child(this._historySection.actor);
        this._scrollViewHistorySection.actor.add_child(this._historyScrollView);
        this._historySeparator = new PopupMenu.PopupSeparatorMenuItem();

        if (this._settingsValues['pinned-on-bottom']) {
            this._indicator.menu.addMenuItem(this._scrollViewHistorySection);
            this._indicator.menu.addMenuItem(this._scrollViewFavoritesSection);
        } else {
            this._indicator.menu.addMenuItem(this._scrollViewFavoritesSection);
            this._indicator.menu.addMenuItem(this._scrollViewHistorySection);
        }

        // Private mode.
        this._privateModeItem = new PopupMenu.PopupSwitchMenuItem(_('Private mode'),
            this._privateMode, { reactive: true });
        this._privateModeItem.connect('toggled', () => this._onPrivateModeSwitch());
        this._privateModeItem.insert_child_at_index(new St.Icon({
            icon_name: 'security-medium-symbolic',
            style_class: 'clipboard-menu-icon',
            y_align: Clutter.ActorAlign.CENTER,
        }), 0);
        this._indicator.menu.addMenuItem(this._privateModeItem);

        // Clear history, with the interval countdown next to it.
        this._clearItem = new PopupMenu.PopupMenuItem(_('Clear history'));
        this._clearItem.insert_child_at_index(new St.Icon({
            icon_name: 'user-trash-symbolic',
            style_class: 'clipboard-menu-icon',
            y_align: Clutter.ActorAlign.CENTER,
        }), 0);

        const timerBox = new St.BoxLayout({ x_align: Clutter.ActorAlign.END, x_expand: true });
        this._timerLabel = new St.Label({
            text: '',
            style: 'font-family: monospace;',
            x_align: Clutter.ActorAlign.END,
            x_expand: true,
        });
        this._resetTimerButton = new St.Button({
            style_class: 'ci-action-btn',
            can_focus: true,
            accessible_name: _('Reset Timer'),
            child: new St.Icon({
                icon_name: 'view-refresh-symbolic',
                style_class: 'system-status-icon',
                icon_size: 14,
            }),
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._resetTimerButton.connect('clicked', () => this._scheduleNextHistoryClear());
        timerBox.add_child(this._timerLabel);
        timerBox.add_child(this._resetTimerButton);
        this._clearItem.add_child(timerBox);
        this._clearItem.connect('activate', () => this._removeAll());

        // Settings.
        this._settingsItem = new PopupMenu.PopupMenuItem(_('Settings'));
        this._settingsItem.insert_child_at_index(new St.Icon({
            icon_name: 'preferences-system-symbolic',
            style_class: 'clipboard-menu-icon',
            y_align: Clutter.ActorAlign.CENTER,
        }), 0);
        this._settingsItem.connect('activate', () => {
            this.ext.openPreferences();
            this._indicator.menu.close();
        });

        // Empty state.
        this._emptyState = new St.BoxLayout({
            style_class: 'clipboard-indicator-empty-state',
            vertical: true,
        });
        this._emptyState.add_child(new St.Icon({
            icon_name: INDICATOR_ICON,
            style_class: 'system-status-icon clipboard-indicator-icon',
            x_align: Clutter.ActorAlign.CENTER,
        }));
        this._emptyState.add_child(new St.Label({
            text: _('Clipboard is empty'),
            x_align: Clutter.ActorAlign.CENTER,
        }));

        for (const entry of history)
            this._addEntry(entry);

        if (lastIdx >= 0)
            this._selectMenuItem(this._items[lastIdx], false);

        this._showElements();
        this._connectSettings();
    }

    _showElements() {
        if (this._destroyed || !this._indicator)
            return;
        const box = this._indicator.menu.box;
        const empty = this._items.length === 0;

        if (!empty && box.contains(this._emptyState))
            box.remove_child(this._emptyState);

        // Search bar.
        if (this._settingsValues['show-search-bar'] && !this._privateMode && !empty) {
            if (!box.contains(this._entryItem))
                box.insert_child_at_index(this._entryItem, 0);
        } else if (box.contains(this._entryItem)) {
            box.remove_child(this._entryItem);
        }

        if (this._privateModeItem?.actor)
            this._privateModeItem.actor.visible = this._settingsValues['show-private-mode'];

        // Separator above the pinned section, only when it holds something.
        if (!empty && !this._privateMode && this._favoritesSection._getMenuItems().length > 0) {
            if (!box.contains(this._favoritesSeparator)) {
                box.insert_child_above(this._favoritesSeparator,
                    this._scrollViewFavoritesSection.actor);
            }
        } else if (box.contains(this._favoritesSeparator)) {
            box.remove_child(this._favoritesSeparator);
        }

        const anyFooter = this._settingsValues['show-private-mode'] ||
            this._settingsValues['show-settings-button'] ||
            this._settingsValues['show-clear-history-button'];

        if (!empty && !this._privateMode && anyFooter &&
            this._historySection._getMenuItems().length > 0) {
            if (!box.contains(this._historySeparator)) {
                box.insert_child_above(this._historySeparator,
                    this._scrollViewHistorySection.actor);
            }
        } else if (box.contains(this._historySeparator)) {
            box.remove_child(this._historySeparator);
        }

        if (empty) {
            if (!box.contains(this._emptyState))
                box.insert_child_at_index(this._emptyState, 0);
        }

        // Footer buttons always go last, in a fixed order.
        for (const item of [this._settingsItem, this._clearItem]) {
            if (item?.actor && box.contains(item.actor))
                box.remove_child(item.actor);
        }

        let index = box.get_n_children();
        if (this._settingsValues['show-settings-button'] && this._settingsItem)
            box.insert_child_at_index(this._settingsItem.actor, index++);
        if (!empty && this._settingsValues['show-clear-history-button'] &&
            this._clearItem && !this._privateMode) {
            box.insert_child_at_index(this._clearItem.actor, index++);
        }

        this._updateIntervalTimer();
    }

    // ---- entries -----------------------------------------------------------

    _allItems() {
        if (!this._historySection || !this._favoritesSection)
            return [...this._items];
        return this._historySection._getMenuItems()
            .concat(this._favoritesSection._getMenuItems());
    }

    _truncate(string, length) {
        let shortened = string.replace(/\s+/g, ' ');
        const chars = [...shortened];
        if (chars.length > length)
            shortened = chars.slice(0, length - 1).join('') + '...';
        return shortened;
    }

    _setEntryLabel(item) {
        const { entry } = item;
        if (entry.isText()) {
            item.label.set_text(this._truncate(entry.getStringValue(),
                this._settingsValues['preview-size']));
        } else if (entry.isImage()) {
            this._registry.getEntryAsImage(entry).then(img => {
                if (!img || this._destroyed)
                    return;
                img.add_style_class_name('clipboard-menu-img-preview');
                if (item.previewImage) {
                    item.remove_child(item.previewImage);
                    item.previewImage = null;
                }
                item.previewImage = img;
                item.insert_child_below(img, item.label);
            }).catch(e => {
                console.warn('Open Gnome Box: clipboard entry preview failed: ' + e.message);
            });
        }
    }

    _addEntry(entry, autoSelect, autoSetClip) {
        const item = new PopupMenu.PopupMenuItem('');

        item.menu = this._indicator.menu;
        item.entry = entry;
        item.clipContents = entry.getStringValue();
        item.radioGroup = this._items;

        item.connect('activate', () => {
            if (this._settingsValues['paste-on-select']) {
                this._pasteItem(item);
                this._onMenuItemSelectedAndMenuClose(item, false);
            } else {
                this._onMenuItemSelectedAndMenuClose(item, true);
            }
        });

        item.connect('key-focus-in', () => {
            const view = item.entry.isFavorite() ? this._favoritesScrollView : this._historyScrollView;
            AnimationUtils.ensureActorVisibleInScrollView(view, item);
        });

        item.actor.connect('key-press-event', (actor, event) => {
            switch (event.get_key_symbol()) {
            case Clutter.KEY_Delete:
                if (item.entry.isFavorite() && this._settingsValues['confirm-pinned-delete']) {
                    this._confirmRemovePinnedEntry(item, true);
                } else {
                    this._selectNextMenuItem(item);
                    this._removeEntry(item, 'delete');
                }
                return Clutter.EVENT_STOP;
            case Clutter.KEY_p:
                this._selectNextMenuItem(item);
                this._favoriteToggle(item);
                return Clutter.EVENT_STOP;
            case Clutter.KEY_v:
                this._pasteItem(item);
                return Clutter.EVENT_STOP;
            case Clutter.KEY_h:
                if (entry.isImage()) {
                    this._showImagePreview(entry, () => {
                        this._focusItemOnOpen = item;
                        this._indicator.menu.open();
                    });
                    return Clutter.EVENT_STOP;
                }
                break;
            case Clutter.KEY_e:
                if (entry.isText()) {
                    this._showEditDialog(item, true);
                    return Clutter.EVENT_STOP;
                }
                break;
            case Clutter.KEY_t:
                this._showTagDialog(item, true);
                return Clutter.EVENT_STOP;
            case Clutter.KEY_KP_Enter:
            case Clutter.KEY_Return:
                if (this._settingsValues['paste-on-select']) {
                    this._pasteItem(item);
                    this._onMenuItemSelectedAndMenuClose(item, false);
                } else {
                    this._onMenuItemSelectedAndMenuClose(item, true);
                }
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._setEntryLabel(item);
        this._items.push(item);

        if (entry.getTag()) {
            item.tagLabel = new St.Label({
                text: entry.getTag(),
                style_class: 'ci-tag-label',
                y_align: Clutter.ActorAlign.CENTER,
            });
            item.actor.add_child(item.tagLabel);
        }

        item.actor.add_child(new St.Widget({ x_expand: true }));

        if (entry.isImage()) {
            item.previewBtn = this._makeActionButton('image-x-generic-symbolic',
                _('Preview Image'), this._settingsValues['show-preview-button']);
            item.previewBtn.connect('clicked', () => this._showImagePreview(entry));
            item.actor.add_child(item.previewBtn);
        }

        if (entry.isText()) {
            item.editBtn = this._makeActionButton('document-edit-symbolic',
                _('Edit'), this._settingsValues['show-edit-button']);
            item.editBtn.connect('clicked', () => this._showEditDialog(item));
            item.actor.add_child(item.editBtn);
        }

        item.pinBtn = this._makeActionButton('view-pin-symbolic', _('Pin'),
            this._settingsValues['show-pin-button'], 'ci-pin-btn');
        item.pinBtn.connect('clicked', () => this._favoriteToggle(item));
        item.actor.add_child(item.pinBtn);

        item.pasteBtn = this._makeActionButton('edit-paste-symbolic', _('Paste'),
            this._settingsValues['paste-button']);
        item.pasteBtn.connect('clicked', () => this._pasteItem(item));
        item.actor.add_child(item.pasteBtn);

        item.tagBtn = this._makeActionButton('user-bookmarks-symbolic', _('Tag'),
            this._settingsValues['show-tag-button']);
        item.tagBtn.connect('clicked', () => this._showTagDialog(item));
        item.actor.add_child(item.tagBtn);

        item.deleteBtn = this._makeActionButton('edit-delete-symbolic', _('Delete'),
            this._settingsValues['show-delete-button']);
        item.deleteBtn.connect('clicked', () => {
            if (item.entry.isFavorite() && this._settingsValues['confirm-pinned-delete'])
                this._confirmRemovePinnedEntry(item);
            else
                this._removeEntry(item, 'delete');
        });
        item.actor.add_child(item.deleteBtn);

        if (entry.isFavorite())
            this._favoritesSection.addMenuItem(item, 0);
        else
            this._historySection.addMenuItem(item, 0);

        if (autoSelect === true) {
            this._selectMenuItem(item, autoSetClip);
        } else {
            item.setOrnament(PopupMenu.Ornament.DOT);
            if (item._ornamentIcon)
                item._ornamentIcon.opacity = 0;
        }

        this._showElements();
    }

    _makeActionButton(iconName, accessibleName, visible, extraClass = null) {
        const classes = ['ci-action-btn'];
        if (extraClass)
            classes.push(extraClass);
        return new St.Button({
            style_class: classes.join(' '),
            can_focus: true,
            accessible_name: accessibleName,
            child: new St.Icon({
                icon_name: iconName,
                style_class: 'system-status-icon',
            }),
            visible,
            x_expand: false,
            y_expand: true,
        });
    }

    _favoriteToggle(item) {
        item.entry.favorite = !item.entry.isFavorite();
        this._moveItemFirst(item);
        this._updateCache();
        this._showElements();
    }

    _confirmRemovePinnedEntry(item, selectNext = false) {
        this._dialogManager.open(
            _('Delete pinned item?'),
            _('Are you sure you want to delete this pinned item?'),
            _('This operation cannot be undone.'),
            _('Delete'), _('Cancel'),
            () => {
                if (selectNext)
                    this._selectNextMenuItem(item);
                this._removeEntry(item, 'delete');
            });
    }

    _confirmRemoveAll() {
        this._dialogManager.open(
            _('Clear all?'),
            _('Are you sure you want to delete all clipboard items?'),
            _('This operation cannot be undone.'),
            _('Clear'), _('Cancel'),
            () => this._clearHistory());
    }

    _clearHistory(invokedAutomatically = false) {
        // Pinned entries are never cleared.
        for (const item of this._historySection._getMenuItems()) {
            if (!this._settingsValues['keep-selected-on-clear'] || !item.currentlySelected)
                this._removeEntry(item, 'delete');
        }

        if (this._settingsValues['notify-on-clear']) {
            this._showNotification(invokedAutomatically
                ? _('Clipboard history cleared automatically')
                : _('Clipboard history cleared'));
        }
    }

    _removeAll() {
        if (this._privateMode)
            return;
        if (this._settingsValues['confirm-clear'])
            this._confirmRemoveAll();
        else
            this._clearHistory();
    }

    _removeEntry(item, event) {
        const idx = this._items.indexOf(item);

        if (event === 'delete' && item.currentlySelected)
            this._clearClipboard();

        if (item.entry.isImage())
            this._registry.deleteEntryFile(item.entry);

        item.destroy();
        if (idx >= 0)
            this._items.splice(idx, 1);

        this._updateCache();
        this._showElements();
    }

    _removeOldestEntries() {
        const max = this._settingsValues['history-size'];
        let unpinned = this._items.filter(i => !i.entry.isFavorite());
        const before = unpinned.length;

        while (unpinned.length > max) {
            const oldest = unpinned.shift();
            this._removeEntry(oldest);
            unpinned = this._items.filter(i => !i.entry.isFavorite());
        }

        if (unpinned.length < before)
            this._updateCache();
    }

    _onMenuItemSelected(item, autoSet) {
        for (const other of item.radioGroup) {
            if (other === item && item.clipContents) {
                item.setOrnament(PopupMenu.Ornament.DOT);
                if (item._ornamentIcon)
                    item._ornamentIcon.opacity = 255;
                item.currentlySelected = true;
                if (autoSet !== false)
                    this._updateClipboard(item.entry);
            } else {
                other.setOrnament(PopupMenu.Ornament.DOT);
                if (other._ornamentIcon)
                    other._ornamentIcon.opacity = 0;
                other.currentlySelected = false;
            }
        }
    }

    _selectMenuItem(item, autoSet) {
        this._onMenuItemSelected(item, autoSet);
        this._updateIndicatorContent(item.entry);
    }

    _onMenuItemSelectedAndMenuClose(item, autoSet) {
        this._onMenuItemSelected(item, autoSet);

        if (this._settingsValues['paste-on-select'] && this._settingsValues['move-item-first'] &&
            !item.entry.isFavorite()) {
            this._moveItemFirst(item);
        }

        item.menu.close();
    }

    _moveItemFirst(item) {
        this._removeEntry(item);
        this._addEntry(item.entry, item.currentlySelected, false);
        this._updateCache();
    }

    _getCurrentlySelectedItem() {
        return this._items.find(i => i.currentlySelected) ?? null;
    }

    _findNextMenuItem(current) {
        const idx = this._items.indexOf(current);
        if (this._items.length === 1)
            return null;

        for (let i = idx - 1; i >= 0; i--) {
            if (this._items[i].actor.visible)
                return this._items[i];
        }

        const after = this._items[idx + 1];
        if (after?.actor.visible)
            return after;

        return null;
    }

    _selectNextMenuItem(item) {
        const next = this._findNextMenuItem(item);
        if (next)
            next.actor.grab_key_focus();
        else if (this._privateModeItem?.actor)
            this._privateModeItem.actor.grab_key_focus();
    }

    // ---- cache -------------------------------------------------------------

    _updateCache() {
        const entries = this._items
            .map(i => i.entry)
            .filter(e => !this._settingsValues['cache-only-favorites'] || e.isFavorite());
        this._registry.write(entries);
    }

    _addToCache(entry) {
        const entries = this._items
            .map(i => i.entry)
            .filter(e => !this._settingsValues['cache-only-favorites'] || e.isFavorite())
            .concat([entry]);
        this._registry.write(entries);
    }

    // ---- clipboard ---------------------------------------------------------

    _setupSelectionTracking() {
        this._selection = Shell.Global.get().get_display().get_selection();
        this._selectionOwnerChangedId = this._selection.connect('owner-changed',
            (selection, selectionType) => {
                if (selectionType === Meta.SelectionType.SELECTION_CLIPBOARD)
                    this._refreshIndicator();
            });
    }

    async _refreshIndicator() {
        if (this._privateMode || this._destroyed)
            return;

        const focused = Shell.Global.get().display.focusWindow;
        const wmClass = focused?.get_wm_class();
        if (wmClass && this._settingsValues['excluded-apps'].includes(wmClass))
            return;

        if (this._refreshInProgress)
            return;
        this._refreshInProgress = true;

        try {
            const result = await this._getClipboardContent();
            if (this._destroyed || !result)
                return;

            for (const item of this._items) {
                if (item.entry.equals(result)) {
                    this._selectMenuItem(item, false);
                    if (!item.entry.isFavorite() && this._settingsValues['move-item-first'])
                        this._moveItemFirst(item);
                    return;
                }
            }

            this._addToCache(result);
            this._addEntry(result, true, false);
            this._removeOldestEntries();

            if (this._settingsValues['notify-on-copy']) {
                this._showNotification(_('Copied to clipboard'),
                    notif => notif.addAction(_('Cancel'), () => this._cancelNotification()));
            }
            this._blinkIcon();
        } catch (e) {
            console.warn('Open Gnome Box: clipboard refresh failed: ' + e.message);
        } finally {
            this._refreshInProgress = false;
        }
    }

    async _getClipboardContent() {
        for (let type of CLIPBOARD_MIMETYPES) {
            const result = await new Promise(resolve => {
                this.ext.clipboard.get_content(CLIPBOARD_TYPE, type, (clipboard, bytes) => {
                    if (bytes === null || bytes.get_size() === 0) {
                        resolve(null);
                        return;
                    }

                    // GNOME mangles the mimetype on the second and later copies
                    // (gnome-shell#8233); report UTF8_STRING as its text type.
                    if (type === 'UTF8_STRING')
                        type = 'text/plain;charset=utf-8';

                    const entry = new ClipboardEntry(type, bytes.get_data(), false);
                    if (this._settingsValues['cache-images'] && entry.isImage())
                        this._registry.writeEntryFile(entry);
                    resolve(entry);
                });
            });

            if (result) {
                if (!this._settingsValues['cache-images'] && result.isImage())
                    return null;
                return result;
            }
        }
        return null;
    }

    _updateClipboard(entry) {
        this.ext.clipboard.set_content(CLIPBOARD_TYPE, entry.mimetype(), entry.asBytes());
        this._updateIndicatorContent(entry);
    }

    _clearClipboard() {
        this.ext.clipboard.set_text(CLIPBOARD_TYPE, '');
        this._updateIndicatorContent(null);
    }

    _pasteItem(item) {
        this._indicator.menu.close();
        const previous = this._getCurrentlySelectedItem();
        this._preventIndicatorUpdate = true;
        this._updateClipboard(item.entry);

        this._pastingKeypressTimeout = setTimeout(() => {
            this._pastingKeypressTimeout = 0;
            if (this._destroyed)
                return;
            const keyboard = this._keyboard;
            if (!keyboard)
                return;

            // Terminals paste with Ctrl+Shift+V, everything else with Shift+Insert.
            if (keyboard.purpose === Clutter.InputContentPurpose.TERMINAL) {
                keyboard.press(Clutter.KEY_Control_L);
                keyboard.press(Clutter.KEY_Shift_L);
                keyboard.press(Clutter.KEY_v);
                keyboard.release(Clutter.KEY_v);
                keyboard.release(Clutter.KEY_Shift_L);
                keyboard.release(Clutter.KEY_Control_L);
            } else {
                keyboard.press(Clutter.KEY_Shift_L);
                keyboard.press(Clutter.KEY_Insert);
                keyboard.release(Clutter.KEY_Insert);
                keyboard.release(Clutter.KEY_Shift_L);
            }

            this._pastingResetTimeout = setTimeout(() => {
                this._pastingResetTimeout = 0;
                this._preventIndicatorUpdate = false;
                if (previous?.entry && !this._destroyed)
                    this._updateClipboard(previous.entry);
            }, 50);
        }, 50);
    }

    // ---- search ------------------------------------------------------------

    _onSearchTextChanged() {
        const caseSensitive = this._settingsValues['case-sensitive-search'];
        let needle = this._searchEntry.get_text();
        if (!caseSensitive)
            needle = needle.toLowerCase();

        if (needle === '') {
            for (const item of this._allItems())
                item.actor.visible = true;
            return;
        }

        const regex = this._settingsValues['regex-search'];
        let re = null;
        if (regex) {
            try {
                re = new RegExp(needle, 'm' + (caseSensitive ? '' : 'i'));
            } catch (e) {
                // An incomplete pattern is normal while typing; nothing matches.
                for (const item of this._allItems())
                    item.actor.visible = false;
                return;
            }
        }

        for (const item of this._allItems()) {
            let text = item.clipContents ?? '';
            let tag = item.entry.getTag() ?? '';
            if (!caseSensitive) {
                text = text.toLowerCase();
                tag = tag.toLowerCase();
            }
            item.actor.visible = regex
                ? (re.test(text) || re.test(tag))
                : (text.includes(needle) || tag.includes(needle));
        }
    }

    // ---- private mode ------------------------------------------------------

    _onPrivateModeSwitch() {
        this._privateMode = this._privateModeItem.state;

        // The history is hidden in private mode: the selected item no longer
        // reflects the clipboard.
        this._scrollViewHistorySection.actor.visible = !this._privateMode;
        this._scrollViewFavoritesSection.actor.visible = !this._privateMode;

        if (!this._privateMode) {
            const selected = this._items.filter(i => i.currentlySelected);
            if (selected.length)
                this._selectMenuItem(selected[0]);
            else
                this._clearClipboard();

            this._getClipboardContent().then(entry => {
                if (entry && !this._destroyed)
                    this._updateIndicatorContent(entry);
            }).catch(e => {
                console.warn('Open Gnome Box: could not restore the clipboard content: ' + e.message);
            });

            this._hbox.remove_style_class_name('private-mode');
        } else {
            this._hbox.add_style_class_name('private-mode');
            this._updateIndicatorContent(null);
        }

        this._showElements();
    }

    togglePrivateMode() {
        this._privateModeItem?.toggle();
    }

    // ---- notifications -----------------------------------------------------

    _initNotifSource() {
        if (this._notifSource)
            return;
        this._notifSource = new MessageTray.Source({
            title: 'Open Gnome Box',
            'icon-name': INDICATOR_ICON,
        });
        this._notifSource.connect('destroy', () => {
            this._notifSource = null;
        });
        Main.messageTray.add(this._notifSource);
    }

    _showNotification(message, transformFn) {
        let dndOn = false;
        try {
            const dateMenu = Main.panel.statusArea.dateMenu;
            dndOn = !dateMenu._indicator._settings.get_boolean('show-banners');
        } catch (e) {
            dndOn = false;
        }
        if (this._privateMode || dndOn)
            return;

        this._initNotifSource();

        let notification;
        if (this._notifSource.count === 0) {
            notification = new MessageTray.Notification({
                source: this._notifSource,
                body: message,
                'is-transient': true,
            });
        } else {
            notification = this._notifSource.notifications[0];
            notification.body = message;
            notification.clearActions();
        }

        if (typeof transformFn === 'function')
            transformFn(notification);

        this._notifSource.addNotification(notification);
    }

    _cancelNotification() {
        if (this._items.length >= 2) {
            const previous = this._items[this._items.length - 2];
            this._updateClipboard(previous.entry);
            previous.setOrnament(PopupMenu.Ornament.DOT);
            previous.currentlySelected = true;
        } else {
            this._clearClipboard();
        }
        const last = this._items[this._items.length - 1];
        if (last)
            this._removeEntry(last);
    }

    // ---- interval clearing -------------------------------------------------

    _setupHistoryIntervalClearing() {
        this._fetchSettings();

        for (const id of [this._intervalSettingChangedId, this._intervalToggleChangedId]) {
            if (id) {
                try {
                    this._settings.disconnect(id);
                } catch (e) {}
            }
        }
        this._intervalSettingChangedId = 0;
        this._intervalToggleChangedId = 0;

        if (this._historyClearTimeoutId) {
            clearTimeout(this._historyClearTimeoutId);
            this._historyClearTimeoutId = 0;
        }

        this._intervalSettingChangedId = this._settings.connect(
            'changed::clear-history-interval', () => this._onIntervalSettingsChanged('clear-history-interval'));
        this._intervalToggleChangedId = this._settings.connect(
            'changed::clear-history-on-interval', () => this._onIntervalSettingsChanged('clear-history-on-interval'));

        if (!this._settingsValues['clear-history-on-interval']) {
            this._updateIntervalTimer();
            return;
        }

        const now = Math.ceil(Date.now() / 1000);
        const next = this._settingsValues['next-history-clear'];

        if (next === -1) {
            this._scheduleNextHistoryClear();
        } else if (next < now) {
            this._clearHistory(true);
            this._scheduleNextHistoryClear();
        } else {
            this._startIntervalTimers((next - now) * 1000);
        }
    }

    _onIntervalSettingsChanged(key) {
        this._fetchSettings();
        if (key === 'clear-history-interval') {
            this._scheduleNextHistoryClear();
        } else if (this._settingsValues['clear-history-on-interval']) {
            this._resetHistoryClearTimer();
            this._setupHistoryIntervalClearing();
        } else {
            this._resetHistoryClearTimer();
        }
    }

    _startIntervalTimers(timeoutMs) {
        if (this._historyClearTimeoutId) {
            clearTimeout(this._historyClearTimeoutId);
            this._historyClearTimeoutId = 0;
        }
        if (this._timerIntervalId) {
            clearInterval(this._timerIntervalId);
            this._timerIntervalId = 0;
        }

        this._historyClearTimeoutId = setTimeout(() => {
            this._historyClearTimeoutId = 0;
            if (this._destroyed)
                return;
            this._clearHistory(true);
            this._scheduleNextHistoryClear();
        }, timeoutMs);

        this._timerIntervalId = setInterval(() => {
            if (!this._destroyed)
                this._updateIntervalTimer();
        }, 1000);
    }

    _scheduleNextHistoryClear() {
        this._fetchSettings();

        if (this._timerIntervalId) {
            clearInterval(this._timerIntervalId);
            this._timerIntervalId = 0;
        }
        if (this._historyClearTimeoutId) {
            clearTimeout(this._historyClearTimeoutId);
            this._historyClearTimeoutId = 0;
        }

        if (!this._settingsValues['clear-history-on-interval']) {
            this._resetHistoryClearTimer();
            return;
        }

        const now = Math.ceil(Date.now() / 1000);
        const next = now + this._settingsValues['clear-history-interval'] * 60;
        this._settings.set_int('next-history-clear', next);

        this._updateIntervalTimer();
        this._startIntervalTimers((next - now) * 1000);
    }

    _resetHistoryClearTimer() {
        if (this._historyClearTimeoutId) {
            clearTimeout(this._historyClearTimeoutId);
            this._historyClearTimeoutId = 0;
        }
        if (this._timerIntervalId) {
            clearInterval(this._timerIntervalId);
            this._timerIntervalId = 0;
        }
        this._updateIntervalTimer();
        this._settings.set_int('next-history-clear', -1);
    }

    _updateIntervalTimer() {
        if (!this._timerLabel || !this._resetTimerButton)
            return;

        const on = this._settingsValues['clear-history-on-interval'];
        this._resetTimerButton.visible = on;
        this._timerLabel.visible = on;
        if (!on) {
            this._timerLabel.set_text('');
            return;
        }

        const now = Math.ceil(Date.now() / 1000);
        const left = (this._settingsValues['next-history-clear'] ?? -1) - now;
        if (left <= 0) {
            this._timerLabel.set_text('');
            return;
        }

        const hours = Math.floor(left / 3600);
        const minutes = Math.floor((left % 3600) / 60);
        const seconds = Math.floor(left % 60);

        let text = '';
        if (hours > 0)
            text += `${hours}h `;
        if (minutes > 0)
            text += `${minutes}m `;
        text += `${seconds}s`;
        this._timerLabel.set_text(text);
    }

    _clearTimerSources() {
        for (const id of [this._historyClearTimeoutId, this._timerIntervalId,
            this._imagePreviewTimeout, this._setFocusOnOpenTimeout,
            this._pastingKeypressTimeout, this._pastingResetTimeout,
            this._blinkAnimationTimeout, this._delayedSelectionTimeoutId]) {
            if (id) {
                try {
                    clearTimeout(id);
                } catch (e) {}
                try {
                    clearInterval(id);
                } catch (e) {}
            }
        }
        this._historyClearTimeoutId = 0;
        this._timerIntervalId = 0;
        this._imagePreviewTimeout = 0;
        this._setFocusOnOpenTimeout = 0;
        this._pastingKeypressTimeout = 0;
        this._pastingResetTimeout = 0;
        this._blinkAnimationTimeout = 0;
        this._delayedSelectionTimeoutId = 0;
    }

    // ---- keybindings -------------------------------------------------------

    bindShortcuts() {
        this.unbindShortcuts();
        this._bindShortcut('clear-history', () => this._removeAll());
        this._bindShortcut('prev-entry', () => this._previousEntry());
        this._bindShortcut('next-entry', () => this._nextEntry());
        this._bindShortcut('toggle-menu', () => this._toggleMenu());
        this._bindShortcut('private-mode-binding', () => this.togglePrivateMode());
    }

    unbindShortcuts() {
        for (const name of this._shortcutNames) {
            try {
                Main.wm.removeKeybinding(name);
            } catch (e) {}
        }
        this._shortcutNames = [];
    }

    _bindShortcut(name, cb) {
        Main.wm.addKeybinding(name, this._settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.ALL, cb);
        this._shortcutNames.push(name);
    }

    _previousEntry() {
        if (this._privateMode)
            return;
        this._clearDelayedSelectionTimeout();

        const items = this._allItems();
        for (let i = 0; i < items.length; i++) {
            if (!items[i].currentlySelected)
                continue;
            let prev = i - 1;
            if (prev < 0)
                prev = items.length - 1;
            this._cycleTo(items, prev);
            return;
        }
    }

    _nextEntry() {
        if (this._privateMode)
            return;
        this._clearDelayedSelectionTimeout();

        const items = this._allItems();
        for (let i = 0; i < items.length; i++) {
            if (!items[i].currentlySelected)
                continue;
            let next = i + 1;
            if (next === items.length)
                next = 0;
            this._cycleTo(items, next);
            return;
        }
    }

    _cycleTo(items, index) {
        if (this._settingsValues['notify-on-cycle']) {
            this._showNotification(`${index + 1} / ${items.length}: ` +
                items[index].entry.getStringValue());
        }
        if (this._settingsValues['move-item-first'])
            this._selectEntryWithDelay(items[index]);
        else
            this._selectMenuItem(items[index]);
    }

    _selectEntryWithDelay(item) {
        this._selectMenuItem(item, false);
        this._delayedSelectionTimeoutId = setTimeout(() => {
            this._delayedSelectionTimeoutId = 0;
            if (!this._destroyed)
                this._selectMenuItem(item);
        }, DELAYED_SELECTION_TIMEOUT);
    }

    _clearDelayedSelectionTimeout() {
        if (this._delayedSelectionTimeoutId) {
            clearTimeout(this._delayedSelectionTimeoutId);
            this._delayedSelectionTimeoutId = 0;
        }
    }

    _toggleMenu() {
        if (!this._indicator.menu.isOpen && this._settingsValues['open-at-cursor'] && this._cursorActor) {
            const [x, y] = global.get_pointer();
            this._cursorActor.set_position(x, y);
            this._indicator.menu.sourceActor = this._cursorActor;
        }
        this._indicator.menu.toggle();
    }

    // ---- dialogs -----------------------------------------------------------

    _showImagePreview(entry, onClose = null) {
        this._closeImagePreview();
        this._indicator.menu.close();

        const monitor = Main.layoutManager.currentMonitor;

        const overlay = new St.Widget({
            reactive: true,
            can_focus: true,
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
            style: 'background-color: rgba(0, 0, 0, 0.75);',
        });

        this._imagePreviewOverlay = overlay;
        global.stage.add_child(overlay);
        overlay.grab_key_focus();

        const close = () => {
            this._closeImagePreview();
            if (onClose)
                onClose();
        };

        overlay._openbarClickId = overlay.connect('button-press-event', () => {
            close();
            return Clutter.EVENT_STOP;
        });

        overlay._openbarKeyId = overlay.connect('key-press-event', (_actor, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                close();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        const maxW = Math.floor(monitor.width * 0.5);
        const maxH = Math.floor(monitor.height * 0.4);

        const bin = new St.Bin({
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        bin.add_constraint(new Clutter.AlignConstraint({
            source: overlay,
            align_axis: Clutter.AlignAxis.X_AXIS,
            factor: 0.5,
        }));
        bin.add_constraint(new Clutter.AlignConstraint({
            source: overlay,
            align_axis: Clutter.AlignAxis.Y_AXIS,
            factor: 0.5,
        }));
        overlay.add_child(bin);

        this._registry.getEntryAsTexture(entry).then(actor => {
            if (this._imagePreviewOverlay !== overlay || !actor)
                return;

            let contentId = actor.connect('notify::content', () => {
                const [, natW] = actor.get_preferred_width(-1);
                const [, natH] = actor.get_preferred_height(-1);
                if (natW > 0 && natH > 0) {
                    actor.disconnect(contentId);
                    contentId = 0;
                    const scale = Math.min(1, maxW / natW, maxH / natH);
                    bin.set_size(Math.round(natW * scale), Math.round(natH * scale));
                }
            });

            actor.connect('destroy', () => {
                if (contentId) {
                    actor.disconnect(contentId);
                    contentId = 0;
                }
            });

            bin.set_child(actor);
        }).catch(e => {
            console.warn('Open Gnome Box: clipboard image preview failed: ' + e.message);
        });
    }

    _closeImagePreview() {
        if (!this._imagePreviewOverlay)
            return;
        const overlay = this._imagePreviewOverlay;
        this._imagePreviewOverlay = null;

        if (overlay._openbarClickId)
            overlay.disconnect(overlay._openbarClickId);
        if (overlay._openbarKeyId)
            overlay.disconnect(overlay._openbarKeyId);

        if (overlay.get_parent())
            global.stage.remove_child(overlay);
        overlay.destroy();
    }

    _showTagDialog(item, reopenOnClose = false) {
        const dialog = new ModalDialog.ModalDialog({ destroyOnClose: true });

        const onClose = () => {
            if (reopenOnClose) {
                this._focusItemOnOpen = item;
                this._indicator.menu.open();
            }
        };

        const textEntry = new St.Entry({
            text: item.entry.getTag() || '',
            hint_text: _('Enter tag…'),
            can_focus: true,
            x_expand: true,
            style: 'min-width: 300px;',
        });
        dialog.contentLayout.add_child(textEntry);

        dialog.addButton({
            label: _('Discard'),
            action: () => {
                dialog.close();
                onClose();
            },
            key: Clutter.KEY_Escape,
        });

        dialog.addButton({
            label: _('Save'),
            action: () => {
                item.entry.setTag(textEntry.get_text().trim() || null);
                this._updateTagLabel(item);
                this._updateCache();
                dialog.close();
                onClose();
            },
            default: true,
        });

        dialog.open();
        textEntry.grab_key_focus();
    }

    _updateTagLabel(item) {
        if (item.tagLabel) {
            item.actor.remove_child(item.tagLabel);
            item.tagLabel.destroy();
            item.tagLabel = null;
        }

        const tag = item.entry.getTag();
        if (tag) {
            item.tagLabel = new St.Label({
                text: tag,
                style_class: 'ci-tag-label',
                y_align: Clutter.ActorAlign.CENTER,
            });
            item.actor.insert_child_above(item.tagLabel, item.label);
        }
    }

    _showEditDialog(item, reopenOnClose = false) {
        const dialog = new ModalDialog.ModalDialog({ destroyOnClose: true });

        const onClose = () => {
            if (reopenOnClose) {
                this._focusItemOnOpen = item;
                this._indicator.menu.open();
            }
        };

        const scrollView = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: false,
            style: 'min-width: 400px; min-height: 100px; max-height: 400px;',
        });

        const clutterText = new Clutter.Text({
            text: item.entry.getStringValue(),
            editable: true,
            reactive: true,
            single_line_mode: false,
            activatable: false,
            line_wrap: true,
        });

        const textBox = new St.BoxLayout({
            style_class: 'ci-edit-textbox',
            x_expand: true,
            y_expand: true,
            vertical: true,
        });
        textBox.add_child(clutterText);
        scrollView.add_child(textBox);
        dialog.contentLayout.add_child(scrollView);

        dialog.addButton({
            label: _('Discard'),
            action: () => {
                dialog.close();
                onClose();
            },
            key: Clutter.KEY_Escape,
        });

        dialog.addButton({
            label: _('Save'),
            action: () => {
                const text = clutterText.get_text();
                item.entry.setText(text);
                item.clipContents = text;
                this._setEntryLabel(item);
                this._updateCache();
                if (item.currentlySelected)
                    this._updateClipboard(item.entry);
                dialog.close();
                onClose();
            },
            default: true,
        });

        if (reopenOnClose)
            this._indicator.menu.close();
        dialog.open();
        clutterText.grab_key_focus();
    }
}

// ---------------------------------------------------------------------------
// Virtual keyboard
//
// Sends Shift+Insert (or Ctrl+Shift+V in terminals) after a paste, so "paste on
// select" and the paste button can inject the entry without a real keyboard.
// ---------------------------------------------------------------------------
class VirtualKeyboard {
    constructor() {
        const seat = Clutter.get_default_backend().get_default_seat();
        this._device = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        this._contentPurpose = null;
        Main.inputMethod.connectObject('notify::content-purpose',
            method => (this._contentPurpose = method.content_purpose), this);
    }

    destroy() {
        Main.inputMethod.disconnectObject(this);
        this._device.run_dispose();
        this._device = null;
    }

    _notify(key, state) {
        this._device.notify_keyval(Clutter.get_current_event_time() * 1000, key, state);
    }

    get purpose() {
        return this._contentPurpose;
    }

    press(key) {
        this._notify(key, Clutter.KeyState.PRESSED);
    }

    release(key) {
        this._notify(key, Clutter.KeyState.RELEASED);
    }
}

// ---------------------------------------------------------------------------
// Confirmation dialog
// ---------------------------------------------------------------------------
class DialogManager {
    constructor() {
        this._openDialog = null;
    }

    open(title, message, subMessage, okLabel, cancelLabel, callback) {
        if (this._openDialog)
            return;
        this._openDialog = new ConfirmDialog(title, `${message}\n${subMessage}`,
            okLabel, cancelLabel, callback);
        this._openDialog.onFinish = () => (this._openDialog = null);
        this._openDialog.open();
    }

    destroy() {
        if (this._openDialog)
            this._openDialog.destroy();
        this._openDialog = null;
    }
}

const ConfirmDialog = GObject.registerClass(
class ConfirmDialog extends ModalDialog.ModalDialog {
    _init(title, description, okLabel, cancelLabel, callback) {
        super._init();

        const mainBox = new St.BoxLayout({ vertical: false });
        this.contentLayout.add_child(mainBox);

        const messageBox = new St.BoxLayout({ vertical: true });
        mainBox.add_child(messageBox);

        messageBox.add_child(new St.Label({
            style: 'font-weight: bold',
            x_align: Clutter.ActorAlign.CENTER,
            text: title,
        }));

        messageBox.add_child(new St.Label({
            style: 'padding-top: 12px',
            x_align: Clutter.ActorAlign.CENTER,
            text: description,
        }));

        this.setButtons([
            {
                label: cancelLabel,
                action: () => {
                    this.close();
                    this.onFinish();
                },
                key: Clutter.KEY_Escape,
            },
            {
                label: okLabel,
                action: () => {
                    this.close();
                    this.onFinish();
                    callback();
                },
            },
        ]);
    }
});
