// lilypadPrefs.js
//
// Preferences pages for the collapsible top bar group: drag-and-drop ordering
// of panel indicators plus the display behaviour switches.
//
// Ported from Lilypad (lilypad@shendrew.github.io) under GPL-3.0-or-later.
// The two pages keep their GtkBuilder templates (ui/order.ui, ui/display.ui).

import Adw from 'gi://Adw';
import GObject from 'gi://GObject';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import GLib from 'gi://GLib';

import { gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const OrderPage = GObject.registerClass({
    GTypeName: 'OrderUI',
    Template: GLib.uri_resolve_relative(import.meta.url, './ui/order.ui', null),
    InternalChildren: [
        'rightbox-order',
        'lilypad-order',
        'ignored-order',
        'clear-button',
    ],
}, class OrderPage extends Adw.PreferencesPage {
    _init(params = {}) {
        this._settings = params.settings;
        const { settings, ...rest } = params;
        super._init(rest);

        this._rightBoxList = this._rightbox_order;
        this._groupList = this._lilypad_order;
        this._ignoredList = this._ignored_order;

        this._initDragMenu('lily-rightbox-order', this._rightBoxList);
        this._initDragMenu('lily-group-order', this._groupList);
        this._initDragMenu('lily-ignored-order', this._ignoredList);
        this._initClearButton('lily-rightbox-order', 'lily-group-order', 'lily-ignored-order');
    }

    // Based on the Workbench drag-and-drop sample, GPL-3.0, as upstream did.
    _addRow(dragBox, rowName, index) {
        const row = new Adw.ActionRow({ title: rowName, selectable: false });
        const dropController = new Gtk.DropControllerMotion();
        row.add_controller(dropController);

        if (rowName) {
            row.add_prefix(new Gtk.Image({
                icon_name: 'list-drag-handle-symbolic',
                css_classes: ['dim-label'],
            }));

            const deleteButton = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                css_classes: ['flat'],
                valign: Gtk.Align.CENTER,
                tooltip_text: _('Delete'),
                focusable: false,
            });
            deleteButton.connect('clicked', () => {
                dragBox.remove(row);
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

        dropController.connect('enter', () => dragBox.drag_highlight_row(row));
        dropController.connect('leave', () => dragBox.drag_unhighlight_row());
        dragBox.insert(row, index);
    }

    _initDragMenu(keyname, listbox) {
        const order = this._settings.get_strv(keyname);
        const boxTarget = Gtk.DropTarget.new(Gtk.ListBoxRow, Gdk.DragAction.MOVE);
        listbox.add_controller(boxTarget);

        for (const name of order)
            this._addRow(listbox, name, -1);
        if (!order.length)
            this._addRow(listbox, null, -1);

        boxTarget.connect('drop', (target, value, x, y) =>
            this._onTargetDropped(value, y, listbox));
    }

    _removeRow(oldRow, listbox) {
        for (const row of listbox) {
            if (row === oldRow) {
                listbox.remove(oldRow);
                return;
            }
        }
    }

    _storeOrder(listbox, keyname) {
        const order = [];
        for (const row of listbox) {
            if (row.title === '')
                listbox.remove(row);
            else
                order.push(row.title);
        }

        if (!order.length)
            this._addRow(listbox, null, -1);

        this._settings.set_strv(keyname, order);
    }

    _storeAllOrders() {
        this._storeOrder(this._rightBoxList, 'lily-rightbox-order');
        this._storeOrder(this._groupList, 'lily-group-order');
        this._storeOrder(this._ignoredList, 'lily-ignored-order');
    }

    _onTargetDropped(value, y, listbox) {
        const targetRow = listbox.get_row_at_y(y);
        const targetIndex = targetRow ? targetRow.get_index() : -1;

        this._groupList.drag_unhighlight_row();
        this._rightBoxList.drag_unhighlight_row();
        this._ignoredList.drag_unhighlight_row();

        if (!value || !targetRow)
            return false;

        // The group button itself stays in the right box list.
        if (value.title === 'lilypad' && listbox !== this._rightBoxList)
            return false;

        this._removeRow(value, this._rightBoxList);
        this._removeRow(value, this._groupList);
        this._removeRow(value, this._ignoredList);

        listbox.insert(value, targetIndex);
        this._storeAllOrders();
        this._emitReorder();
        return true;
    }

    _initClearButton(...keynames) {
        this._clear_button.connect('clicked', () => {
            const parentWindow = this.get_ancestor(Gtk.Window);

            const dialog = new Adw.MessageDialog({
                transient_for: parentWindow,
                modal: true,
                heading: _('Clear all orders?'),
                body: _('Indicators return to their natural order. This cannot be undone.'),
            });
            dialog.add_response('cancel', _('Cancel'));
            dialog.add_response('clear', _('Clear'));
            dialog.set_response_appearance('clear', Adw.ResponseAppearance.DESTRUCTIVE);
            dialog.set_default_response('cancel');
            dialog.set_close_response('cancel');
            dialog.connect('response', (dlg, response) => {
                if (response !== 'clear')
                    return;
                for (const keyname of keynames)
                    this._settings.reset(keyname);
                this._emitReorder();
                if (parentWindow)
                    parentWindow.close();
            });
            dialog.present();
        });
    }

    // The preferences process cannot reach the shell object, so flipping this
    // key is how a reorder is requested; the extension listens for it.
    _emitReorder() {
        const state = this._settings.get_boolean('lily-reorder');
        this._settings.set_boolean('lily-reorder', !state);
    }
});

const DisplayPage = GObject.registerClass({
    GTypeName: 'DisplayUI',
    Template: GLib.uri_resolve_relative(import.meta.url, './ui/display.ui', null),
    InternalChildren: [
        'hide-indicator-dropdown',
        'icon-style-dropdown',
        'auto-collapse-millisecond-spin-button',
        'auto-collapse-switch',
    ],
}, class DisplayPage extends Adw.PreferencesPage {
    _init(params = {}) {
        this._settings = params.settings;
        const { settings, ...rest } = params;
        super._init(rest);

        this._initDropdown('lily-hide-indicator', this._hide_indicator_dropdown,
            ['Never', 'When empty', 'Always']);
        this._initDropdown('lily-icon-style', this._icon_style_dropdown,
            ['Default', 'Arrow']);

        // int keys cannot bind to SpinButton.value (double): the binding fails
        // silently, so write the value explicitly.
        const spin = this._auto_collapse_millisecond_spin_button;
        spin.set_range(0, 10000);
        spin.set_increments(100, 500);
        spin.set_value(this._settings.get_int('lily-auto-collapse-millisecond'));
        spin.connect('value-changed', () => {
            const v = Math.round(spin.value);
            if (this._settings.get_int('lily-auto-collapse-millisecond') !== v)
                this._settings.set_int('lily-auto-collapse-millisecond', v);
        });

        this._settings.bind('lily-auto-collapse', this._auto_collapse_switch,
            'active', Gio.SettingsBindFlags.DEFAULT);
    }

    _initDropdown(keyname, dropdown, strings) {
        dropdown.set_model(new Gtk.StringList({ strings }));
        // 'selected' is guint while the key is int: bind would silently fail.
        dropdown.selected = this._settings.get_int(keyname);
        dropdown.connect('notify::selected', () => {
            const v = dropdown.selected;
            if (this._settings.get_int(keyname) !== v)
                this._settings.set_int(keyname, v);
        });
    }
});

export class LilypadPrefsPage {
    constructor({ window, settings }) {
        this._window = window;
        this._settings = settings;
    }

    build() {
        const orderPage = new OrderPage({
            title: _('Order'),
            icon_name: 'view-sort-ascending-symbolic',
            settings: this._settings,
        });
        this._window.add(orderPage);

        const displayPage = new DisplayPage({
            title: _('Display'),
            icon_name: 'display-symbolic',
            settings: this._settings,
        });
        this._window.add(displayPage);
        return [orderPage, displayPage];
    }
}
