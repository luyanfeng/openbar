// Shared wallpaper discovery for the slideshow engine and the preferences
// dialog. Pure Gio/GLib only - this module must stay importable from the
// preferences process, which has no access to gnome-shell modules.
//
// GPL-2.0-or-later, same as the rest of Open Gnome Box.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// ---- Bit flag helpers (wallpaper-paths-selected is an int bitmask) ----
export function isBitSet(value, bit) {
    return (value & (1 << bit)) !== 0;
}

export function setBit(value, bit) {
    return value | (1 << bit);
}

export function clearBit(value, bit) {
    return value & ~(1 << bit);
}

// ---- Wallpaper rotation queue ----
export class WallpaperQueue extends Array {
    enqueue(path) {
        if (!this.includes(path))
            this.push(path);
    }

    clear() {
        this.length = 0;
    }
}

// Recursively collect image files under one directory, skipping hidden files
// and formats the GNOME background does not support (e.g. SVG).
async function scanDirectory(directory) {
    const enumerator = await directory.enumerate_children_async(
        'standard::*',
        Gio.FileQueryInfoFlags.NONE,
        GLib.PRIORITY_DEFAULT,
        null
    );
    const wallpapers = [];
    while (true) {
        const fileInfos = await enumerator.next_files_async(10, GLib.PRIORITY_DEFAULT, null);
        if (fileInfos.length === 0)
            break;
        for (const fileInfo of fileInfos) {
            const name = fileInfo.get_name();
            if (name.startsWith('.'))
                continue;
            const lower = name.toLowerCase();
            if (lower.endsWith('.svg'))
                continue;
            const file = directory.get_child(name);
            const fileType = fileInfo.get_file_type();
            if (fileType === Gio.FileType.REGULAR) {
                wallpapers.push(file.get_path());
            } else if (fileType === Gio.FileType.DIRECTORY) {
                wallpapers.push(...await scanDirectory(file));
            }
        }
    }
    return wallpapers;
}

// Resolve every enabled source into a flat, de-duplicated queue. Returns the
// wallpapers plus the directories that contributed, so callers that need live
// change monitoring can attach their own watches.
export async function scanWallpapers(paths, selectedBitmask) {
    const wallpapers = [];
    const directories = [];
    for (let i = 0; i < paths.length; i++) {
        if (!isBitSet(selectedBitmask, i))
            continue;
        const path = paths[i];
        if (!path) {
            console.warn(`Wallpapers: empty path at index ${i}, skipping`);
            continue;
        }
        const file = Gio.File.new_for_path(path);
        const fileType = file.query_file_type(Gio.FileQueryInfoFlags.NONE, null);
        if (fileType === Gio.FileType.REGULAR) {
            wallpapers.push(path);
        } else if (fileType === Gio.FileType.DIRECTORY) {
            directories.push(path);
            wallpapers.push(...await scanDirectory(file));
        } else {
            console.warn(`Wallpapers: path is neither a file nor a directory: ${path}`);
        }
    }
    return { wallpapers, directories };
}
