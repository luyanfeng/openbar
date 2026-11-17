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
// All queries are ASYNCHRONOUS on purpose. The shell both serves
// org.gnome.Shell.Extensions and calls into it, so a synchronous call from the
// shell's own main thread deadlocks on itself and aborts the process. Results
// are cached briefly so a settings-changed storm cannot flood the bus.
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

const CALL_TIMEOUT_MS = 3000;

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
    'clipboard-enabled': {
        uuid: 'clipboard-indicator@tudmotu.com',
        label: 'Clipboard Indicator',
    },
    'lilypad-enabled': {
        uuid: 'lilypad@shendrew.github.io',
        label: 'Lilypad',
    },
    'date-menu-format-enabled': {
        uuid: 'date-menu-formatter@marcinjakubowski.github.com',
        label: 'Date Menu Formatter',
    },
    'magic-lamp-enabled': {
        uuid: 'compiz-alike-magic-lamp-effect@hermes83.github.com',
        label: 'Compiz alike magic lamp effect',
    },
};

// Extensions that conflict with Open Gnome Box as a whole rather than with one
// optional feature. Open Bar is the extension this one was forked from: both
// generate a stylesheet for the panel, both write ~/.config/gtk-{3,4}.0/gtk.css
// and the flatpak overrides, so whichever loads last silently wins.
export const CONFLICTING_WHOLE_EXTENSIONS = [
    {
        uuid: 'openbar@neuromorph',
        label: 'Open Bar',
    },
    {
        uuid: 'lilypad@shendrew.github.io',
        label: 'Lilypad',
    },
];

// Standalone extensions from CONFLICTING_EXTENSIONS that are currently enabled.
// Unknown state counts as "not conflicting" so a missing shell does not block
// the feature.
export async function activeWholeConflicts() {
    const found = [];
    for (const entry of CONFLICTING_WHOLE_EXTENSIONS) {
        const info = await foreignExtensionInfo(entry.uuid);
        if (info?.enabled)
            found.push(entry);
    }
    return found;
}

// Disable one of those extensions by uuid. Resolves true only when the shell
// confirms it is no longer enabled.
export async function disableWholeConflict(uuid) {
    try {
        await callRemote('DisableExtension', new GLib.Variant('(s)', [uuid]));
        const info = await foreignExtensionInfo(uuid);
        return !info?.enabled;
    } catch (e) {
        console.warn(`Open Gnome Box: could not disable ${uuid}: ${e.message}`);
        return false;
    }
}

function unpack(value) {
    return value && typeof value.deep_unpack === 'function'
        ? value.deep_unpack()
        : value;
}

function callRemote(method, params) {
    return new Promise((resolve, reject) => {
        const bus = Gio.DBus.session;
        if (!bus) {
            reject(new Error('no session bus'));
            return;
        }
        bus.call(
            SHELL_EXTENSIONS_DBUS.name, SHELL_EXTENSIONS_DBUS.path,
            SHELL_EXTENSIONS_DBUS.iface, method, params, null,
            Gio.DBusCallFlags.NONE, CALL_TIMEOUT_MS, null,
            (source, result) => {
                try {
                    resolve(source.call_finish(result));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

// Current state of another extension, or null when the shell cannot be asked
// (no session bus, shell not answering). Callers must treat null as "unknown"
// and stay quiet rather than claiming a conflict.
export async function foreignExtensionInfo(uuid) {
    if (typeof uuid !== 'string' || uuid.length === 0)
        return null;
    try {
        const reply = await callRemote('GetExtensionInfo',
            new GLib.Variant('(s)', [uuid]));
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
export async function conflictingExtensionEnabled(settingKey) {
    const entry = CONFLICTING_EXTENSIONS[settingKey];
    if (!entry)
        return false;
    const info = await foreignExtensionInfo(entry.uuid);
    return !!info?.enabled;
}

// Disable the standalone extension so the built-in copy can own the feature.
// Resolves true only when the shell confirms it is no longer enabled, so the
// caller never ends up with both copies running.
export async function disableConflictingExtension(settingKey) {
    const entry = CONFLICTING_EXTENSIONS[settingKey];
    if (!entry)
        return true;
    try {
        await callRemote('DisableExtension', new GLib.Variant('(s)', [entry.uuid]));
        return !(await conflictingExtensionEnabled(settingKey));
    } catch (e) {
        console.warn(`Open Gnome Box: could not disable ${entry.uuid}: ${e.message}`);
        return false;
    }
}
