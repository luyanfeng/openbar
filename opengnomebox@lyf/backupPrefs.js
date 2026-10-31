// backupPrefs.js
//
// Preferences page for exporting and importing every setting as one JSON file.
// The heavy lifting lives in settingsBackup.js; this module is only the page and
// the file dialogs.
//
// GPL-2.0-or-later, same as the rest of Open Gnome Box.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

import {
    buildBackup,
    exportableKeys,
    targetFileIn,
    writeBackup,
    readBackup,
    planImport,
    applyImport,
} from './settingsBackup.js';

export class BackupPage {
    constructor({ window, settings, gettext, onImported }) {
        this._window = window;
        this._settings = settings;
        this._ = gettext;
        this._onImported = onImported;
    }

    // Build the page and add it to the preferences window.
    //
    // The page is created last, so it sits at the right of the tab bar next to
    // the log viewer: both are utilities rather than everyday settings.
    build() {
        const page = new Adw.PreferencesPage({
            name: 'backup',
            title: this._('Backup'),
            icon_name: 'document-save-symbolic',
        });
        this._window.add(page);
        this._page = page;

        this._buildExportGroup(page);
        this._buildImportGroup(page);
        return page;
    }

    // ---- export ------------------------------------------------------------

    _buildExportGroup(page) {
        const group = new Adw.PreferencesGroup({
            title: this._('Export'),
            description: this._('Save every setting to a JSON file you can keep ' +
                'or copy to another machine.'),
        });
        page.add(group);

        this._exportStatus = new Adw.ActionRow({
            title: this._('Not exported yet'),
            subtitle: this._('%s settings will be written.').format(
                exportableKeys(this._settings).length),
        });
        group.add(this._exportStatus);

        const row = new Adw.ActionRow({
            title: this._('Export to folder'),
            subtitle: this._('Choose where to save the file.'),
        });
        const button = new Gtk.Button({
            label: this._('Choose Folder'),
            valign: Gtk.Align.CENTER,
        });
        button.connect('clicked', () => this._export());
        row.add_suffix(button);
        row.activatable_widget = button;
        group.add(row);
    }

    _export() {
        const dialog = new Gtk.FileDialog({
            title: this._('Choose a folder for the export'),
            modal: true,
        });

        dialog.select_folder(this._window, null, (source, result) => {
            let folder;
            try {
                folder = source.select_folder_finish(result);
            } catch (e) {
                // Dismissing the dialog is not an error worth reporting.
                return;
            }
            if (!folder)
                return;

            const file = targetFileIn(folder.get_path());
            try {
                const size = writeBackup(file, buildBackup(this._settings));
                this._exportStatus.title = this._('Saved %s').format(file.get_basename());
                this._exportStatus.subtitle = this._('%s bytes, %s settings')
                    .format(size, exportableKeys(this._settings).length);
                this._showToast(this._('Exported to %s').format(file.get_path()));
            } catch (e) {
                this._exportStatus.title = this._('Export failed');
                this._exportStatus.subtitle = e.message;
                this._showError(this._('Could not write the file'), e.message);
            }
        });
    }

    // ---- import ------------------------------------------------------------

    _buildImportGroup(page) {
        const group = new Adw.PreferencesGroup({
            title: this._('Import'),
            description: this._('Load settings from a file. You will see what ' +
                'changes before anything is applied.'),
        });
        page.add(group);

        this._importStatus = new Adw.ActionRow({
            title: this._('No file chosen'),
            subtitle: this._('Only settings that differ will be written.'),
        });
        group.add(this._importStatus);

        const row = new Adw.ActionRow({
            title: this._('Import from file'),
            subtitle: this._('Pick a backup file exported by this extension.'),
        });
        const button = new Gtk.Button({
            label: this._('Choose File'),
            valign: Gtk.Align.CENTER,
        });
        button.connect('clicked', () => this._import());
        row.add_suffix(button);
        row.activatable_widget = button;
        group.add(row);
    }

    _import() {
        const dialog = new Gtk.FileDialog({
            title: this._('Choose a settings file'),
            modal: true,
        });

        const filter = new Gtk.FileFilter();
        filter.set_name(this._('Settings files'));
        filter.add_pattern('*.json');
        const filters = new Gio.ListStore({ item_type: Gtk.FileFilter });
        filters.append(filter);
        dialog.filters = filters;
        dialog.default_filter = filter;

        dialog.open(this._window, null, (source, result) => {
            let file;
            try {
                file = source.open_finish(result);
            } catch (e) {
                return;
            }
            if (!file)
                return;
            this._review(file);
        });
    }

    _review(file) {
        const { backup, problem } = readBackup(file);
        if (problem) {
            this._importStatus.title = this._('Cannot read this file');
            this._importStatus.subtitle = this._describeProblem(problem);
            this._showError(this._('Cannot read this file'), this._describeProblem(problem));
            return;
        }

        const plan = planImport(this._settings, backup);
        this._importStatus.title = file.get_basename();
        this._importStatus.subtitle = this._('%s of %s settings differ')
            .format(plan.apply.length, Object.keys(backup.settings).length);

        this._confirmImport(backup, plan, file);
    }

    _confirmImport(backup, plan, file) {
        const lines = [];

        if (plan.apply.length === 0)
            lines.push(this._('Nothing would change: this file matches the current settings.'));
        else
            lines.push(this._('%s settings will be replaced.').format(plan.apply.length));

        if (plan.same > 0)
            lines.push(this._('%s already match and are skipped.').format(plan.same));

        if (plan.unknown.length > 0) {
            lines.push(this._('%s settings in the file are not known to this version ' +
                'and will be ignored:').format(plan.unknown.length));
            lines.push('  ' + plan.unknown.slice(0, 8).join(', ') +
                (plan.unknown.length > 8 ? ', …' : ''));
        }

        if (plan.invalid.length > 0) {
            lines.push(this._('%s values could not be read and will be skipped:')
                .format(plan.invalid.length));
            lines.push('  ' + plan.invalid.slice(0, 6).map(i => i.key).join(', ') +
                (plan.invalid.length > 6 ? ', …' : ''));
        }

        if (backup.exported)
            lines.push(this._('Exported %s').format(backup.exported));

        const dialog = new Adw.MessageDialog({
            transient_for: this._window,
            modal: true,
            heading: this._('Import these settings?'),
            body: lines.join('\n'),
        });
        dialog.add_response('cancel', this._('Cancel'));
        dialog.add_response('import', this._('Import'));
        dialog.set_response_appearance('import', Adw.ResponseAppearance.SUGGESTED);
        dialog.set_default_response(plan.apply.length > 0 ? 'import' : 'cancel');
        dialog.set_close_response('cancel');
        dialog.connect('response', (_dlg, response) => {
            if (response !== 'import')
                return;
            this._applyPlan(plan, file);
        });
        dialog.present();
    }

    _applyPlan(plan, file) {
        try {
            const count = applyImport(this._settings, plan);
            this._importStatus.title = this._('Imported %s').format(file.get_basename());
            this._importStatus.subtitle = this._('%s settings were written.').format(count);
            this._showToast(this._('Imported %s settings').format(count));
            if (this._onImported)
                this._onImported(count);
        } catch (e) {
            this._importStatus.title = this._('Import failed');
            this._importStatus.subtitle = e.message;
            this._showError(this._('Could not apply the settings'), e.message);
        }
    }

    _describeProblem(problem) {
        switch (problem) {
        case 'not-json':
            return this._('The file is not valid JSON.');
        case 'wrong-format':
            return this._('The file was not exported by Open Gnome Box.');
        case 'unsupported-version':
            return this._('The file was written by a newer version and cannot be read here.');
        case 'no-settings':
            return this._('The file contains no settings.');
        default:
            return this._('The file could not be read.');
        }
    }

    // ---- feedback ----------------------------------------------------------

    _showError(heading, body) {
        const dialog = new Adw.MessageDialog({
            transient_for: this._window,
            modal: true,
            heading,
            body: body ?? '',
        });
        dialog.add_response('close', this._('Close'));
        dialog.present();
    }

    // Short-lived confirmation at the bottom of the window. Adw.PreferencesWindow
    // provides add_toast() itself; wrapping the window in a ToastOverlay would
    // replace every page.
    _showToast(text) {
        if (typeof this._window.add_toast !== 'function')
            return;
        this._window.add_toast(new Adw.Toast({ title: text }));
    }
}
