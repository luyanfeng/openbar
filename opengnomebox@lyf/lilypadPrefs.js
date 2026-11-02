// lilypadPrefs.js
//
// Preferences content for the collapsible top bar indicator group.
//
// The three indicator lists are collapsible cards (Adw.ExpanderRow), matching
// the pattern used by the clipboard page, and rows can be dragged between the
// cards. Card contents are rebuilt from JS arrays after every change because
// Adw.ExpanderRow can only append rows (add_row), not insert at a position.
//
// The drag-and-drop list handling is ported from Lilypad
// (lilypad@shendrew.github.io) under GPL-3.0-or-later.
//
// GPL-3.0-or-later for this file; the rest of Open Gnome Box is GPL-2.0-or-later.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

const ORDER_KEYS = ['lily-group-order', 'lily-rightbox-order', 'lily-ignored-order'];

// The group button itself lives in the top bar order card and cannot be
// dragged into the group or ignore cards.
const ANCHOR_ROW_TITLE = 'lilypad';

export class LilypadPrefsContent {
    constructor(settings, gettext) {
        this._settings = settings;
        this._ = gettext;
        // key -> { expander, rows: [Adw.ActionRow] }
        this._cards = new Map();
    }

    // Build the cards into `page` and return a controller whose
    // setSensitive(on) greys the cards out while grouping is disabled.
    build(page) {
        // All cards live in one PreferencesGroup: Adw.PreferencesPage.add()
        // only accepts groups, and a single section keeps the cards reading as
        // one feature.
        const section = new Adw.PreferencesGroup();
        page.add(section);

        const makeCard = (title, subtitle) => {
            const card = new Adw.ExpanderRow({ title, subtitle: subtitle ?? '' });
            card.set_enable_expansion(true);
            section.add(card);
            return card;
        };

        const cardGroup = makeCard(
            this._('Collapsible group'),
            this._('Indicators collected into the collapsible button.'), false);
        const cardTopbar = makeCard(
            this._('Top bar order'),
            this._('Indicators placed directly on the top bar, in this order.'), false);
        const cardIgnored = makeCard(
            this._('Ignored by grouping'),
            this._('Indicators that manage their own placement.'), false);

        this._registerCard('lily-group-order', cardGroup);
        this._registerCard('lily-rightbox-order', cardTopbar);
        this._registerCard('lily-ignored-order', cardIgnored);

        for (const key of ORDER_KEYS)
            this._loadCard(key);

        const cardDisplay = makeCard(
            this._('Display'),
            this._('How the collapsible group button behaves.'), true);

        this._addDropdown(cardDisplay, 'lily-hide-indicator', this._('Hide group button'),
            this._('When to hide the collapsible group button'),
            ['Never', 'When empty', 'Always']);
        this._addDropdown(cardDisplay, 'lily-icon-style', this._('Icon style'),
            this._('Choose the indicator icon style'),
            ['Default', 'Arrow']);

        const collapseSwitch = new Adw.SwitchRow({
            title: this._('Enable auto collapse'),
            subtitle: this._('Close the group automatically after the delay without interaction.'),
        });
        this._settings.bind('lily-auto-collapse', collapseSwitch, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        cardDisplay.add_row(collapseSwitch);

        // int keys cannot bind to SpinRow.value (double): the binding fails
        // silently, so write the value explicitly.
        const spin = new Adw.SpinRow({
            title: this._('Auto collapse delay (ms)'),
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 10000, step_increment: 100, page_increment: 500,
                value: this._settings.get_int('lily-auto-collapse-millisecond'),
            }),
        });
        spin.connect('notify::value', () => {
            const v = Math.round(spin.value);
            if (this._settings.get_int('lily-auto-collapse-millisecond') !== v)
                this._settings.set_int('lily-auto-collapse-millisecond', v);
        });
        cardDisplay.add_row(spin);

        const cards = [cardGroup, cardTopbar, cardIgnored, cardDisplay];
        const sync = on => {
            for (const card of cards)
                card.sensitive = on;
        };
        sync(this._settings.get_boolean('lilypad-enabled'));

        return { setSensitive: sync };
    }

    // ---- card bookkeeping --------------------------------------------------

    _registerCard(key, expander) {
        this._cards.set(key, { expander, rows: [] });

        const dropTarget = Gtk.DropTarget.new(Adw.ActionRow.$gtype, Gdk.DragAction.MOVE);
        expander.add_controller(dropTarget);
        dropTarget.connect('drop', (target, value, x, y) =>
            this._onDropOnCard(key, value));
    }

    _loadCard(key) {
        for (const name of this._settings.get_strv(key))
            this._appendRow(key, name);
    }

    _appendRow(key, name) {
        const card = this._cards.get(key);
        if (!card)
            return null;

        const row = new Adw.ActionRow({ title: name ?? '', selectable: false });

        row.add_prefix(new Gtk.Image({
            icon_name: 'list-drag-handle-symbolic',
            css_classes: ['dim-label'],
        }));

        const deleteButton = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            css_classes: ['flat'],
            valign: Gtk.Align.CENTER,
            tooltip_text: this._('Remove from this list'),
            focusable: false,
        });
        deleteButton.connect('clicked', () => {
            this._removeFromCard(key, row);
            this._rebuildCards();
            this._store();
            this._emitReorder();
        });
        row.add_suffix(deleteButton);

        // Drag the row itself; drop targets on every card and row accept it.
        const dragSource = new Gtk.DragSource({ actions: Gdk.DragAction.MOVE });
        row.add_controller(dragSource);

        let dragX = 0;
        let dragY = 0;
        dragSource.connect('prepare', (_source, x, y) => {
            dragX = x;
            dragY = y;
            const value = new GObject.Value();
            value.init(Adw.ActionRow.$gtype);
            value.set_object(row);
            return Gdk.ContentProvider.new_for_value(value);
        });

        dragSource.connect('drag-begin', (_source, drag) => {
            const dragWidget = new Adw.ActionRow({ title: row.title });
            dragWidget.add_prefix(new Gtk.Image({
                icon_name: 'list-drag-handle-symbolic',
                css_classes: ['dim-label'],
            }));
            const icon = Gtk.DragIcon.get_for_drag(drag);
            icon.child = dragWidget;
            drag.set_hotspot(dragX ?? 0, dragY ?? 0);
        });

        for (const motion of [new Gtk.DropControllerMotion()]) {
            row.add_controller(motion);
            motion.connect('enter', () => card.expander.drag_highlight_row(row));
            motion.connect('leave', () => card.expander.drag_unhighlight_row());
        }

        const dropTarget = Gtk.DropTarget.new(Adw.ActionRow.$gtype, Gdk.DragAction.MOVE);
        row.add_controller(dropTarget);
        dropTarget.connect('drop', (target, value, x, y) =>
            this._onDropOnRow(key, value, row, y));

        card.expander.add_row(row);
        card.rows.push(row);
        return row;
    }

    _removeFromCard(key, row) {
        const card = this._cards.get(key);
        const idx = card.rows.indexOf(row);
        if (idx >= 0)
            card.rows.splice(idx, 1);
        card.expander.remove(row);
    }

    _rebuildCards() {
        for (const [key, card] of this._cards) {
            for (const row of [...card.rows])
                card.expander.remove(row);
            for (const row of card.rows)
                card.expander.add_row(row);
        }
    }

    _store() {
        for (const [key, card] of this._cards)
            this._settings.set_strv(key, card.rows.map(r => r.title));
    }

    _emitReorder() {
        // The preferences process cannot reach the shell object; flipping this
        // key is how a rearrange is requested, and the extension listens for it.
        const state = this._settings.get_boolean('lily-reorder');
        this._settings.set_boolean('lily-reorder', !state);
    }

    // ---- drops -------------------------------------------------------------

    _onDropOnCard(key, value) {
        if (!(value instanceof Adw.ActionRow))
            return false;
        return this._move(value, key, null);
    }

    _onDropOnRow(targetKey, value, targetRow, y) {
        if (!(value instanceof Adw.ActionRow) || value === targetRow)
            return false;
        return this._move(value, targetKey, targetRow, y);
    }

    // Move `row` into the card `key`, optionally relative to `beforeRow`.
    // Positional inserts are not possible in an ExpanderRow, so the affected
    // cards are rebuilt from the row arrays after the move.
    _move(row, key, beforeRow = null, y = 0) {
        if (row.title === ANCHOR_ROW_TITLE && key !== 'lily-rightbox-order')
            return false;

        const source = [...this._cards.entries()]
            .find(([k, card]) => card.rows.includes(row));
        if (!source)
            return false;
        const [sourceKey, sourceCard] = source;
        if (sourceKey === key && beforeRow === null)
            return false;

        const from = sourceCard.rows.indexOf(row);
        sourceCard.rows.splice(from, 1);

        const targetCard = this._cards.get(key);
        if (beforeRow) {
            let at = targetCard.rows.indexOf(beforeRow);
            if (at < 0)
                at = targetCard.rows.length;
            else {
                const bounds = beforeRow.get_allocation();
                if (y > bounds.height / 2)
                    at += 1;
                if (sourceKey === key && from < at)
                    at -= 1;
            }
            targetCard.rows.splice(at, 0, row);
        } else {
            targetCard.rows.push(row);
        }

        this._rebuildCards();
        this._store();
        this._emitReorder();
        return true;
    }

    // ---- dropdown rows -----------------------------------------------------

    _addDropdown(card, keyname, title, subtitle, strings) {
        const row = new Adw.ActionRow({ title, subtitle: subtitle ?? '' });
        const dropdown = new Gtk.DropDown({
            model: new Gtk.StringList({ strings }),
            valign: Gtk.Align.CENTER,
        });

        // 'selected' is guint while the key is int: bind would silently fail.
        dropdown.selected = this._settings.get_int(keyname);
        dropdown.connect('notify::selected', () => {
            const v = dropdown.selected;
            if (this._settings.get_int(keyname) !== v)
                this._settings.set_int(keyname, v);
        });

        row.add_suffix(dropdown);
        card.add_row(row);
    }
}
