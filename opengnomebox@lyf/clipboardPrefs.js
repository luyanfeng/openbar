import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';

// Filled by buildClipboardPrefsPage(): the gettext function is only known at
// call time, and this module is imported before any translation is bound.
let DISPLAY_MODE_OPTIONS = [];

// Each clipboard section is a collapsible card: the settings list is long
// enough that showing all of it at once is hard to scan.
function makeGroup(title, subtitle, expanded = false) {
    const row = new Adw.ExpanderRow({
        title,
        subtitle: subtitle ?? '',
        expanded,
    });
    row.set_enable_expansion(true);
    return row;
}

// Rows go into either an Adw.PreferencesGroup (add) or an Adw.ExpanderRow
// (add_row); the builders below are shared by both.
function addRow(container, row) {
    if (typeof container.add_row === 'function')
        container.add_row(row);
    else
        container.add(row);
    return row;
}

function addSwitchRow(group, settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({ title });
    if (subtitle)
        row.subtitle = subtitle;
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return addRow(group, row);
}

// Gio.Settings.bind cannot target SpinRow.value: the keys are ints while the
// row property is a double, and the mismatch makes the binding fail silently.
function addIntSpinRow(group, settings, key, title, subtitle, lower, upper, step) {
    const adjustment = new Gtk.Adjustment({
        lower,
        upper,
        step_increment: step,
        value: settings.get_int(key),
    });
    const row = new Adw.SpinRow({ title, adjustment });
    if (subtitle)
        row.subtitle = subtitle;
    row.connect('notify::value', () => {
        const value = Math.round(row.value);
        if (settings.get_int(key) !== value)
            settings.set_int(key, value);
    });
    return addRow(group, row);
}

function buildUiGroup(settings, _) {
    const group = makeGroup(_('UI'), _('Menu contents and what the top bar shows'), false);
    addIntSpinRow(group, settings, 'preview-size',
        _('Preview Size (characters)'),
        _('Number of characters shown per entry in the history menu'),
        10, 100, 1);
    addSwitchRow(group, settings, 'confirm-clear',
        _('Prompt for confirmation on Clear History'),
        _('Ask before deleting all clipboard entries'));
    addSwitchRow(group, settings, 'confirm-pinned-delete',
        _('Prompt before deleting pinned item'),
        _('Ask for confirmation before deleting a pinned item'));
    addSwitchRow(group, settings, 'pinned-on-bottom',
        _('Place the pinned section on the bottom'),
        _('Move the pinned section to the bottom of the menu. Requires re-login'));
    addSwitchRow(group, settings, 'show-search-bar',
        _('Show Search Bar'),
        _('Display a search field at the top of the clipboard menu'));
    addSwitchRow(group, settings, 'show-private-mode',
        _('Show Private Mode'),
        _('Display the private mode toggle in the clipboard menu'));
    addSwitchRow(group, settings, 'show-settings-button',
        _('Show Settings Button'),
        _('Display a shortcut to these settings in the clipboard menu'));
    addSwitchRow(group, settings, 'show-clear-history-button',
        _('Show Clear History Button'),
        _('Display the clear history button in the clipboard menu'));
    return group;
}

function buildItemActionsGroup(settings, _) {
    const group = makeGroup(_('Item Actions'), _('Buttons shown on every history entry'), false);
    addSwitchRow(group, settings, 'show-delete-button',
        _('Delete'), _('Show the delete button on each item'));
    addSwitchRow(group, settings, 'show-tag-button',
        _('Tag'), _('Show the tag button on each item'));
    addSwitchRow(group, settings, 'paste-button',
        _('Paste'), _('Show the paste button on each item'));
    addSwitchRow(group, settings, 'show-pin-button',
        _('Pin'), _('Show the pin/favorite button on each item'));
    addSwitchRow(group, settings, 'show-edit-button',
        _('Edit'), _('Show the edit button on each text item'));
    addSwitchRow(group, settings, 'show-preview-button',
        _('Preview'), _('Show the preview button on each image item'));
    return group;
}

function buildBehaviorGroup(settings, _) {
    const group = makeGroup(_('Behavior'), _('How entries are recorded, ordered and pasted'), false);
    addSwitchRow(group, settings, 'strip-text',
        _('Remove whitespace around text'),
        _('Strip leading and trailing whitespace from text entries on copy'));
    addSwitchRow(group, settings, 'move-item-first',
        _('Move item to the top after selection'),
        _('When selecting an entry, bring it to the top of the history'));
    addSwitchRow(group, settings, 'keep-selected-on-clear',
        _('Keep selected entry after Clear History'),
        _('The currently active clipboard entry will not be removed when clearing history'));
    addSwitchRow(group, settings, 'open-at-cursor',
        _('Open menu at cursor'),
        _('When using the keyboard shortcut, open the menu at the cursor position'));
    addSwitchRow(group, settings, 'paste-on-select',
        _('Paste on select'),
        _('Automatically paste the entry into the active window when selected'));
    addSwitchRow(group, settings, 'cache-images',
        _('Cache images'),
        _('Save copied images to clipboard history'));
    addSwitchRow(group, settings, 'clear-on-boot',
        _('Clear clipboard history on system reboot'),
        _('Delete all cached clipboard entries when the system starts'));
    const intervalSwitch = addSwitchRow(group, settings, 'clear-history-on-interval',
        _('Clear clipboard history on interval'),
        _('Automatically clear clipboard history at a recurring interval'));
    const intervalRow = addIntSpinRow(group, settings, 'clear-history-interval',
        _('History clear interval (in minutes)'),
        null,
        1, 1440, 10);
    intervalSwitch.connect('notify::active', () => {
        intervalRow.set_sensitive(intervalSwitch.active);
    });
    intervalRow.set_sensitive(intervalSwitch.active);
    return group;
}

function buildSearchGroup(settings, _) {
    const group = makeGroup(_('Search'), _('How the search field matches entries'), false);
    addSwitchRow(group, settings, 'case-sensitive-search',
        _('Case-sensitive'),
        _('Match uppercase and lowercase letters exactly when searching'));
    addSwitchRow(group, settings, 'regex-search',
        _('Regular expressions'),
        _('Allow regular expressions to filter clipboard entries'));
    return group;
}

function buildLimitsGroup(settings, _) {
    const group = makeGroup(_('Limits'), _('History size and disk usage'), false);
    addIntSpinRow(group, settings, 'history-size',
        _('History Size'),
        _('Maximum number of entries to keep in clipboard history'),
        1, 10000, 1);
    addIntSpinRow(group, settings, 'cache-size',
        _('Max cache file size (MB)'),
        _('Maximum disk space used for caching clipboard data'),
        1, 1024, 1);
    addSwitchRow(group, settings, 'cache-only-favorites',
        _('Cache only pinned items'),
        _('Only save pinned (favorite) entries to disk'));
    return group;
}

function createAppPickerButton(entry, _) {
    const popover = new Gtk.Popover();

    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        margin_top: 6,
        margin_bottom: 6,
        margin_start: 6,
        margin_end: 6,
    });

    const searchEntry = new Gtk.SearchEntry({
        placeholder_text: _('Search applications...'),
        margin_bottom: 6,
    });

    const scrolledWindow = new Gtk.ScrolledWindow({
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        height_request: 300,
        width_request: 300,
    });

    const listBox = new Gtk.ListBox();
    scrolledWindow.set_child(listBox);

    const appRows = [];
    const appInfoList = Gio.AppInfo.get_all();
    appInfoList.sort((a, b) => a.get_display_name().localeCompare(b.get_display_name()));

    for (const appInfo of appInfoList) {
        if (!appInfo.should_show())
            continue;

        const row = new Gtk.ListBoxRow();
        const rowBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 10,
            margin_top: 6,
            margin_bottom: 6,
            margin_start: 6,
            margin_end: 6,
        });

        const icon = appInfo.get_icon();
        if (icon) {
            rowBox.append(new Gtk.Image({ gicon: icon, pixel_size: 24 }));
        }

        const label = new Gtk.Label({
            label: appInfo.get_display_name(),
            halign: Gtk.Align.START,
            hexpand: true,
        });
        rowBox.append(label);

        row.set_child(rowBox);
        row.appInfo = appInfo;
        listBox.append(row);
        appRows.push({ row, appInfo });
    }

    searchEntry.connect('search-changed', () => {
        const text = searchEntry.get_text().toLowerCase();
        for (const { row, appInfo } of appRows)
            row.set_visible(appInfo.get_display_name().toLowerCase().includes(text));
    });

    searchEntry.connect('activate', () => {
        const firstVisibleRow = appRows.find(({ row }) => row.visible);
        if (firstVisibleRow)
            listBox.emit('row-activated', firstVisibleRow.row);
        entry.grab_focus();
    });

    listBox.connect('row-activated', (list, row) => {
        if (!row || !row.appInfo)
            return;
        entry.set_text(row.appInfo.get_id().replace(/\.desktop$/, ''));
        popover.popdown();
    });

    box.append(searchEntry);
    box.append(scrolledWindow);
    popover.set_child(box);

    const button = new Gtk.MenuButton({
        iconName: 'view-list-symbolic',
        cssClasses: ['flat'],
        valign: Gtk.Align.CENTER,
        halign: Gtk.Align.CENTER,
        tooltip_text: _('Choose from installed applications'),
    });
    button.set_popover(popover);
    return button;
}

function buildExclusionGroup(settings, _) {
    const group = makeGroup(_('Exclusion'), _('Applications whose copies are ignored'), false);

    const expander = new Adw.ExpanderRow({
        title: _('Excluded Apps'),
        subtitle: _('Content copied will not be saved while these apps are in focus'),
    });

    const addButton = new Gtk.Button({
        iconName: 'list-add-symbolic',
        cssClasses: ['flat'],
        valign: Gtk.Align.CENTER,
        halign: Gtk.Align.CENTER,
    });
    expander.add_suffix(addButton);
    addRow(group, expander);

    let rowCount = 0;

    const updateExpansion = () => {
        const hasRows = rowCount > 0;
        expander.set_enable_expansion(hasRows);
        expander.set_expanded(hasRows);
    };

    const createExcludedAppRow = className => {
        const row = new Adw.ActionRow({ title: className });

        const removeButton = new Gtk.Button({
            cssClasses: ['destructive-action'],
            iconName: 'edit-delete-symbolic',
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.CENTER,
        });
        removeButton.connect('clicked', () => {
            expander.remove(row);
            settings.set_strv('excluded-apps',
                settings.get_strv('excluded-apps').filter(app => app !== className));
            rowCount--;
            updateExpansion();
        });

        row.add_suffix(removeButton);
        return row;
    };

    const createExcludedAppInputRow = () => {
        const row = new Adw.ActionRow();

        const entry = new Gtk.Entry({
            placeholderText: _('Window class name, e.g. "KeePassXC"'),
            halign: Gtk.Align.FILL,
            valign: Gtk.Align.CENTER,
            hexpand: true,
        });

        const okButton = new Gtk.Button({
            iconName: 'object-select-symbolic',
            cssClasses: ['flat'],
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.CENTER,
        });

        const cancelButton = new Gtk.Button({
            iconName: 'window-close-symbolic',
            cssClasses: ['flat'],
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.CENTER,
        });

        const commit = () => {
            const text = entry.get_text().trim();
            if (text === '')
                return;
            expander.remove(row);
            expander.add_row(createExcludedAppRow(text));
            addButton.set_sensitive(true);
            settings.set_strv('excluded-apps',
                [...settings.get_strv('excluded-apps'), text]);
        };

        okButton.connect('clicked', commit);
        entry.connect('activate', commit);

        cancelButton.connect('clicked', () => {
            expander.remove(row);
            addButton.set_sensitive(true);
            rowCount--;
            updateExpansion();
        });

        row.add_prefix(entry);
        row.add_suffix(createAppPickerButton(entry, _));
        row.add_suffix(okButton);
        row.add_suffix(cancelButton);
        return row;
    };

    addButton.connect('clicked', () => {
        addButton.set_sensitive(false);
        rowCount++;
        updateExpansion();
        expander.add_row(createExcludedAppInputRow());
    });

    for (const app of settings.get_strv('excluded-apps')) {
        expander.add_row(createExcludedAppRow(app));
        rowCount++;
    }
    updateExpansion();

    return group;
}

function buildTopbarGroup(settings, _) {
    const group = makeGroup(_('Topbar'), _('What the panel indicator displays'), false);

    const displayModes = new Gtk.StringList();
    for (const option of DISPLAY_MODE_OPTIONS)
        displayModes.append(option);

    const displayModeRow = new Adw.ComboRow({
        title: _('What to show in top bar'),
        model: displayModes,
    });
    displayModeRow.selected = settings.get_int('display-mode');
    displayModeRow.connect('notify::selected', () => {
        if (settings.get_int('display-mode') !== displayModeRow.selected)
            settings.set_int('display-mode', displayModeRow.selected);
    });
    addRow(group, displayModeRow);

    addIntSpinRow(group, settings, 'topbar-preview-size',
        _('Number of characters in top bar'),
        _('Length of the clipboard content preview shown in the panel'),
        1, 100, 1);
    addSwitchRow(group, settings, 'disable-down-arrow',
        _('Remove down arrow in top bar'),
        _('Hide the dropdown arrow next to the clipboard indicator'));
    addSwitchRow(group, settings, 'blink-icon-on-copy',
        _('Blink icon on copy'),
        _('Briefly flash the indicator icon when something is copied'));
    return group;
}

function buildNotificationsGroup(settings, _) {
    const group = makeGroup(_('Notifications'), _('Banners shown for clipboard events'), false);
    addSwitchRow(group, settings, 'notify-on-copy',
        _('Show notification on copy'),
        _('Display a notification each time text is copied'));
    addSwitchRow(group, settings, 'notify-on-cycle',
        _('Show notification on cycle'),
        _('Display a notification when cycling through entries with shortcuts'));
    addSwitchRow(group, settings, 'notify-on-clear',
        _('Show notification on Clear History'),
        _('Display a notification when clipboard history is cleared'));
    return group;
}

function createShortcutButton(settings, key, _) {
    const button = new Gtk.Button({ has_frame: false });

    let controller = null;
    let debounceTimeoutId = null;
    let labelBeforeEdit = null;

    const setLabelFromSettings = () => {
        const accelerator = settings.get_strv(key)[0];
        button.set_label(accelerator || _('Disabled'));
    };

    const stopEditing = () => {
        if (debounceTimeoutId) {
            clearTimeout(debounceTimeoutId);
            debounceTimeoutId = null;
        }
        if (controller) {
            button.remove_controller(controller);
            controller = null;
        }
        labelBeforeEdit = null;
    };

    const commitShortcut = () => {
        stopEditing();
        setLabelFromSettings();
    };

    const revertEditing = () => {
        const previousLabel = labelBeforeEdit;
        stopEditing();
        button.set_label(previousLabel);
    };

    setLabelFromSettings();

    button.connect('clicked', () => {
        if (controller) {
            revertEditing();
            return;
        }

        labelBeforeEdit = button.label;
        button.set_label(_('Enter shortcut'));

        controller = new Gtk.EventControllerKey();
        button.add_controller(controller);

        controller.connect('key-pressed', (_controller, keyval, keycode, mask) => {
            if (debounceTimeoutId)
                clearTimeout(debounceTimeoutId);

            mask = mask & Gtk.accelerator_get_default_mod_mask();

            if (mask === 0) {
                if (keyval === Gdk.KEY_Escape) {
                    revertEditing();
                    return Gdk.EVENT_STOP;
                }
                if (keyval === Gdk.KEY_BackSpace) {
                    settings.set_strv(key, []);
                    commitShortcut();
                    return Gdk.EVENT_STOP;
                }
            }

            const selectedShortcut = Gtk.accelerator_name_with_keycode(null, keyval, keycode, mask);
            debounceTimeoutId = setTimeout(() => {
                debounceTimeoutId = null;
                settings.set_strv(key, [selectedShortcut]);
                commitShortcut();
            }, 400);

            return Gdk.EVENT_STOP;
        });
    });

    return button;
}

function buildShortcutsGroup(settings, _) {
    const group = makeGroup(_('Shortcuts'), _('Keyboard bindings for clipboard actions'), false);

    addSwitchRow(group, settings, 'enable-keybindings', _('Enable shortcuts'), null);

    const shortcuts = [
        ['private-mode-binding', _('Private mode')],
        ['toggle-menu', _('Toggle the menu')],
        ['clear-history', _('Clear history')],
        ['prev-entry', _('Previous entry')],
        ['next-entry', _('Next entry')],
    ];

    for (const [key, title] of shortcuts) {
        const row = new Adw.ActionRow({ title });
        row.add_suffix(createShortcutButton(settings, key, _));
        addRow(group, row);
    }

    return group;
}

export function buildClipboardPrefsPage(page, settings, _) {
    if (typeof _ !== 'function')
        throw new Error('buildClipboardPrefsPage needs the gettext function');

    DISPLAY_MODE_OPTIONS = [_('Icon'), _('Clipboard Content'), _('Both'), _('Neither')];

    page.add(buildClipboardSection(settings, _));
}

// The sections live inside one group so they read as cards of a single page.
function buildClipboardSection(settings, _) {
    const section = new Adw.PreferencesGroup();

    for (const build of [
        buildUiGroup,
        buildItemActionsGroup,
        buildBehaviorGroup,
        buildSearchGroup,
        buildLimitsGroup,
        buildExclusionGroup,
        buildTopbarGroup,
        buildNotificationsGroup,
        buildShortcutsGroup,
    ])
        section.add(build(settings, _));

    return section;
}
