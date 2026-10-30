// conflicts.js
//
// Detection of standalone extensions that provide the same feature as one of
// Open Gnome Box's built-in integrations.
//
// Ubuntu 26.04 ships the gnome-shell-extensions set as *system* extensions under
// /usr/share/gnome-shell/extensions, so "Auto Move Windows" and "Removable
// Drive Menu" can already be installed and enabled from there. Running one of
// those alongside our built-in copy means two implementations of the same hook:
// duplicate drive icons, and windows redirected to a workspace twice.
//
// Only Gio/GLib are imported here: this module is used both by the extension
// (integrations.js) and by the preference window, which runs in its own gjs
// process where the shell's UI modules are not available.
//
// GPL-2.0-or-later, same as the rest of Open Gnome Box.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const SHELL_EXTENSIONS_DBUS = {
    name: 'org.gnome.Shell',
    path: '/org/gnome/Shell',
    iface: 'org.gnome.Shell.Extensions',
};

// Keyed by the Open Gnome Box setting that turns the feature on, so callers can
// look a feature up from the key they already have.
export const CONFLICTING_EXTENSIONS = {
    'auto-move-windows': {
        uuid: 'auto-move-windows@gnome-shell-extensions.gcampax.github.com',
        label: 'Auto Move Windows',
    },
    'drive-menu-enabled': {
        uuid: 'drive-menu@gnome-shell-extensions.gcampax.github.com',
        label: 'Removable Drive Menu',
    },
};

function unpack(value) {
    return value && typeof value.deep_unpack === 'function'
        ? value.deep_unpack()
        : value;
}

// Current state of another extension, or null when the shell cannot be asked
// (no session bus, shell not answering). Callers must treat null as "unknown"
// and stay quiet rather than claiming a conflict.
export function foreignExtensionInfo(uuid) {
    if (typeof uuid !== 'string' || uuid.length === 0)
        return null;
    try {
        const bus = Gio.DBus.session;
        if (!bus)
            return null;
        const reply = bus.call_sync(
            SHELL_EXTENSIONS_DBUS.name, SHELL_EXTENSIONS_DBUS.path,
            SHELL_EXTENSIONS_DBUS.iface, 'GetExtensionInfo',
            new GLib.Variant('(s)', [uuid]), null,
            Gio.DBusCallFlags.NONE, 2000, null);
        const [info] = reply.deep_unpack();
        if (!info)
            return null;
        return {
            uuid,
            name: String(unpack(info.name) ?? ''),
            enabled: !!unpack(info.enabled),
            state: Number(unpack(info.state) ?? 0),
            // 0 = user extension, 1 = system extension.
            type: Number(unpack(info.type) ?? 0),
        };
    } catch (e) {
        return null;
    }
}

// True when the standalone extension providing `settingKey` is installed and
// enabled. Unknown state counts as "not conflicting" so a missing shell does
// not block the feature.
export function conflictingExtensionEnabled(settingKey) {
    const entry = CONFLICTING_EXTENSIONS[settingKey];
    if (!entry)
        return false;
    const info = foreignExtensionInfo(entry.uuid);
    return !!info?.enabled;
}

// Disable the standalone extension so the built-in copy can own the feature.
// Returns true only when the shell confirms it is no longer enabled, so the
// caller never ends up with both copies running.
export function disableConflictingExtension(settingKey) {
    const entry = CONFLICTING_EXTENSIONS[settingKey];
    if (!entry)
        return true;
    try {
        const bus = Gio.DBus.session;
        if (!bus)
            return false;
        bus.call_sync(
            SHELL_EXTENSIONS_DBUS.name, SHELL_EXTENSIONS_DBUS.path,
            SHELL_EXTENSIONS_DBUS.iface, 'DisableExtension',
            new GLib.Variant('(s)', [entry.uuid]), null,
            Gio.DBusCallFlags.NONE, 3000, null);
        return !conflictingExtensionEnabled(settingKey);
    } catch (e) {
        console.warn(`Open Gnome Box: could not disable ${entry.uuid}: ${e.message}`);
        return false;
    }
}
