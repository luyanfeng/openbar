// settingsBackup.js
//
// Export and import of every Open Gnome Box setting as a single JSON file.
//
// Values are stored in their GVariant text form (what get_value().print(true)
// returns), so the type survives the round trip and import does not have to
// guess from the schema. Reading every key directly from Gio.Settings means
// defaults are included too, which a `dconf dump` cannot give: dconf only holds
// keys that were written at some point.
//
// GPL-2.0-or-later, same as the rest of Open Gnome Box.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const BACKUP_FORMAT = 'opengnomebox-settings';
export const BACKUP_VERSION = 1;

// Keys that hold transient or machine-local state rather than a preference.
// Exporting them would import a stale "reload pending" flag or another
// machine's monitor geometry.
const EXCLUDED_KEYS = new Set([
    'trigger-reload',
    'trigger-autotheme',
    'reloadstyle',
    'removestyle',
    'menustyle',
    'import-export',
    'pause-reload',
    'monitor-width',
    'monitor-height',
    'next-history-clear',
]);

export function isExcludedKey(key) {
    return EXCLUDED_KEYS.has(key);
}

// All exportable keys of the schema behind `settings`, in schema order.
export function exportableKeys(settings) {
    return settings.settings_schema.list_keys()
        .filter(k => !EXCLUDED_KEYS.has(k))
        .sort();
}

// Snapshot every exportable key as { key: gvariant-text }.
export function collectSettings(settings) {
    const out = {};
    for (const key of exportableKeys(settings)) {
        out[key] = settings.get_value(key).print(true);
    }
    return out;
}

export function buildBackup(settings) {
    return {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        exported: new Date().toISOString(),
        application: 'Open Gnome Box',
        settings: collectSettings(settings),
    };
}

// Default file name: opengnomebox-settings-YYYYMMDD-HHMM.json
export function defaultFileName(date = new Date()) {
    const pad = n => String(n).padStart(2, '0');
    const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
        `-${pad(date.getHours())}${pad(date.getMinutes())}`;
    return `opengnomebox-settings-${stamp}.json`;
}

// Directory the user picked plus our generated file name.
export function targetFileIn(dirPath, date = new Date()) {
    return Gio.File.new_for_path(GLib.build_filenamev([dirPath, defaultFileName(date)]));
}

// Write `backup` to `file`, replacing it if it exists. Throws on failure so the
// caller can show a real error instead of a silent no-op.
export function writeBackup(file, backup) {
    const text = `${JSON.stringify(backup, null, 2)}\n`;
    const bytes = new TextEncoder().encode(text);
    file.replace_contents(bytes, null, false,
        Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    return text.length;
}

// Read and validate a backup file. Returns { backup, problem } where problem is
// null on success, or a short machine-readable reason on failure.
export function readBackup(file) {
    let text;
    try {
        const [, contents] = file.load_contents(null);
        text = new TextDecoder().decode(contents);
    } catch (e) {
        return { backup: null, problem: 'unreadable' };
    }

    let data;
    try {
        data = JSON.parse(text);
    } catch (e) {
        return { backup: null, problem: 'not-json' };
    }

    if (!data || typeof data !== 'object')
        return { backup: null, problem: 'not-json' };
    if (data.format !== BACKUP_FORMAT)
        return { backup: null, problem: 'wrong-format' };
    if (typeof data.version !== 'number' || data.version > BACKUP_VERSION)
        return { backup: null, problem: 'unsupported-version' };
    if (!data.settings || typeof data.settings !== 'object')
        return { backup: null, problem: 'no-settings' };

    return { backup: data, problem: null };
}

// Work out what importing `backup` would change, without touching anything.
// Returns:
//   apply   - [{ key, variant }]  values that differ from the current ones
//   unknown - keys present in the file but absent from this schema
//   invalid - [{ key, reason }]   values that do not parse as their key's type
//   same    - number of keys already holding the imported value
export function planImport(settings, backup) {
    const schema = settings.settings_schema;
    const known = new Set(schema.list_keys());
    const apply = [];
    const unknown = [];
    const invalid = [];
    let same = 0;

    for (const [key, text] of Object.entries(backup.settings)) {
        if (EXCLUDED_KEYS.has(key))
            continue;
        if (!known.has(key)) {
            unknown.push(key);
            continue;
        }
        if (typeof text !== 'string') {
            invalid.push({ key, reason: 'not-a-string' });
            continue;
        }

        const typeStr = schema.get_key(key).get_value_type().dup_string();
        let variant;
        try {
            variant = GLib.Variant.parse(GLib.VariantType.new(typeStr), text, null, null);
        } catch (e) {
            invalid.push({ key, reason: e.message });
            continue;
        }
        if (variant.get_type_string() !== typeStr) {
            invalid.push({ key, reason: 'type-mismatch' });
            continue;
        }

        if (settings.get_value(key).equal(variant)) {
            same++;
            continue;
        }
        apply.push({ key, variant });
    }

    apply.sort((a, b) => a.key.localeCompare(b.key));
    unknown.sort();
    return { apply, unknown, invalid, same };
}

// Apply a plan produced by planImport(). Returns the number of keys written.
export function applyImport(settings, plan) {
    for (const { key, variant } of plan.apply)
        settings.set_value(key, variant);
    return plan.apply.length;
}
