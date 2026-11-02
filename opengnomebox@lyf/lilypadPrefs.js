// lilypadPrefs.js
//
// Preferences content for the collapsible top bar indicator group.
//
// One page holds everything: the drag-and-drop order lists and the display
// behaviour. Keeping it on a single page matters because Adw.PreferencesWindow
// only appends pages, so dynamically hiding sub-pages would make them jump to
// the bottom of the page list on every toggle. Instead the groups stay put and
// are greyed out while grouping is disabled.
//
// The drag-and-drop list handling is ported from Lilypad
// (lilypad@shendrew.github.io) under GPL-3.0-or-later.
//
// GPL-3.0-or-later for this file; the rest of Open Gnome Box is GPL-2.0-or-later.

import Adw from 'gi://Adw';
import GObject from 'gi://GObject';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

// Keys whose value order is edited through drag-and-drop lists.
const ORDER_KEYS = [
    'lily-group-order',
    'lily-rightbox-order',
    'lily-ignored-order',
];

export class LilypadPrefsContent {
    constructor(settings, gettext) {
        this._settings = settings;
        this._ = gettext;
        this._listBoxes = new Map();
    }

    // Build the content groups into `page` and return a controller whose
    // setSensitive(on) greys the lists and behaviour rows out.
    build(page) {
        // Adw.PreferencesGroup has no subtitle property in this libadwaita, so
        // the explanation goes into description.
        const makeGroup = (title, description) => {
            const group = new Adw.PreferencesGroup({ title, description });
            page.add(group);
            return group;
        };

        const groupLists = makeGroup(
            this._('Order lists'),
            this._('Drag rows between the lists to choose which indicators are ' +
                'collected into the collapsible group and how the rest are ordered.'));

        this._buildDragList(groupLists, 'lily-group-order', this._('Collapsible group'));
        this._buildDragList(groupLists, 'lily-rightbox-order', this._('Top bar order'));
        this._buildDragList(groupLists, 'lily-ignored-order', this._('Ignored by grouping'));

        const groupDisplay = makeGroup(
            this._('Display'),
            this._('How the collapsible group button behaves.'));

        this._addDropdown(groupDisplay, 'lily-hide-indicator', this._('Hide group button'),
            this._('When to hide the collapsible group button'),
            ['Never', 'When empty', 'Always']);
        this._addDropdown(groupDisplay, 'lily-icon-style', this._('Icon style'),
            this._('Choose the indicator icon style'),
            ['Default', 'Arrow']);

        const collapseSwitch = new Adw.SwitchRow({
            title: this._('Enable auto collapse'),
            subtitle: this._('Close the group automatically after the delay without interaction.'),
        });
        this._settings.bind('lily-auto-collapse', collapseSwitch, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        groupDisplay.add(collapseSwitch);

        // int keys cannot bind to SpinButton.value (double): the binding fails
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
        groupDisplay.add(spin);

        const sync = on => {
            groupLists.sensitive = on;
            groupDisplay.sensitive = on;
        };
        sync(this._settings.get_boolean('lilypad-enabled'));

        return { setSensitive: sync };
    }

    // ---- drag-and-drop order lists -----------------------------------------

    _buildDragList(group, keyname, title) {
        const listbox = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
            css_classes: ['boxed-list'],
        });

        const order = this._settings.get_strv(keyname);
        for (const name of order)
            this._addRow(listbox, name);
        if (!order.length)
            this._addRow(listbox, null);

        const dropTarget = Gtk.DropTarget.new(Gtk.ListBoxRow, Gdk.DragAction.MOVE);
        listbox.add_controller(dropTarget);
        dropTarget.connect('drop', (target, value, x, y) =>
            this._onDrop(value, y, listbox));

        const scroll = new Gtk.ScrolledWindow({
            child: listbox,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            height_request: Math.min(260, 44 * (listbox.get_first_child() ? 6 : 2)),
        });
        group.add(scroll);

        const hint = new Gtk.Label({
            label: this._('%s').format(title),
            halign: Gtk.Align.START,
            css_classes: ['caption', 'dim-label'],
        });
        group.add(hint);

        this._listBoxes.set(keyname, listbox);
    }

    _addRow(listbox, name) {
        const row = new Adw.ActionRow({ title: name ?? '', selectable: false });
        const dropMotion = new Gtk.DropControllerMotion();
        row.add_controller(dropMotion);

        if (name) {
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
                listbox.remove(row);
                this._storeAllOrders();
                this._emitReorder();
            });
            row.add_suffix(deleteButton);

            let dragX;
            let dragY;
            const dragSource = new Gtk.DragSource({ actions: Gdk.DragAction.MOVE });
            row.add_controller(dragSource);

            dragSource.connect('prepare', (_source, x, y) => {
                dragX = x;
                dragY = y;
                const value = new GObject.Value();
                value.init(Gtk.ListBoxRow);
                value.set_object(row);
                return Gdk.ContentProvider.new_for_value(value);
            });

            dragSource.connect('drag-begin', (_source, drag) => {
                const dragWidget = new Gtk.ListBox();
                dragWidget.set_size_request(row.get_width(), row.get_height());
                dragWidget.add_css_class('boxed-list');

                const dragRow = new Adw.ActionRow({ title: row.title });
                dragRow.add_prefix(new Gtk.Image({
                    icon_name: 'list-drag-handle-symbolic',
                    css_classes: ['dim-label'],
                }));
                dragWidget.append(dragRow);
                dragWidget.drag_highlight_row(dragRow);

                const icon = Gtk.DragIcon.get_for_drag(drag);
                icon.child = dragWidget;
                drag.set_hotspot(dragX, dragY);
            });
        }

        dropMotion.connect('enter', () => listbox.drag_highlight_row(row));
        dropMotion.connect('leave', () => listbox.drag_unhighlight_row());
        listbox.append(row);
    }

    _onDrop(value, y, targetList) {
        const targetRow = targetList.get_row_at_y(y);
        if (!value || !targetRow)
            return false;

        // The group button itself must stay in the top bar order list.
        if (value.title === 'lilypad' && targetList !== this._listBoxes.get('lily-rightbox-order'))
            return false;

        for (const listbox of this._listBoxes.values()) {
            for (const row of listbox) {
                if (row === value) {
                    listbox.remove(row);
                    break;
                }
            }
        }

        targetList.insert(value, targetRow.get_index());
        this._storeAllOrders();
        this._emitReorder();
        return true;
    }

    _storeAllOrders() {
        for (const [keyname, listbox] of this._listBoxes) {
            const order = [];
            for (const row of listbox) {
                if (row.title === '')
                    listbox.remove(row);
                else
                    order.push(row.title);
            }
            if (!order.length)
                this._addRow(listbox, null);
            this._settings.set_strv(keyname, order);
        }
    }

    // The preferences process cannot reach the shell object; flipping this key
    // is how a rearrange is requested, and the extension listens for it.
    _emitReorder() {
        const state = this._settings.get_boolean('lily-reorder');
        this._settings.set_boolean('lily-reorder', !state);
    }

    // ---- dropdown rows -----------------------------------------------------

    _addDropdown(group, keyname, title, subtitle, strings) {
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
        group.add(row);
    }
}
