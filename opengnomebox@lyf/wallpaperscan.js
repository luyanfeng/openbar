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

// Collect every image path referenced by a GNOME-native dynamic wallpaper
// (.xml) into `excluded`: the <static>/<transition> images are the animation's
// internal time-of-day slides, not standalone wallpapers. Leaving them in the
// queue makes the rotation look like it keeps switching between different
// states of the same dynamic wallpaper. Recognises the tags used by GNOME's
// timed format (<file>/<from>/<to>) and the simple filename variants
// (<filename>/<filename-dark>, also Wallhub's dwp format).
function collectDynamicFrames(xmlPath, xmlText, excluded) {
    const matches = xmlText.match(
        /<(?:file|from|to|filename|filename-dark)>([^<]*)<\/(?:file|from|to|filename|filename-dark)>/g
    ) ?? [];
    const dir = GLib.path_get_dirname(xmlPath);
    for (const m of matches) {
        const value = m.slice(m.indexOf('>') + 1, m.lastIndexOf('<'))
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        // A single tag may carry a light#dark pair.
        for (const part of value.split('#')) {
            const p = part.trim();
            if (!p)
                continue;
            if (p.startsWith('/')) {
                excluded.add(p);
                continue;
            }
            // Paths in the GNOME spec are relative to the XML's directory.
            excluded.add(GLib.build_filenamev([dir, p]));
        }
    }
}

// Resolve the image a GNOME dynamic wallpaper (.xml) is showing right now, so
// color sampling has a real file to read. Handles both the timed format
// (<starttime> + a sequence of <static>/<transition> segments) and the simple
// <filename>/<filename-dark> variant. Returns a filesystem path, or null when
// nothing usable can be found.
export function resolveDynamicWallpaperFrame(xmlPath, preferDark = false) {
    let xml;
    try {
        const [ok, contents] = Gio.File.new_for_path(xmlPath).load_contents(null);
        if (!ok)
            return null;
        xml = new TextDecoder().decode(contents);
    } catch (e) {
        return null;
    }

    const dir = GLib.path_get_dirname(xmlPath);
    const resolve = p => {
        const clean = p.trim()
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        if (!clean)
            return null;
        return clean.startsWith('/') ? clean : GLib.build_filenamev([dir, clean]);
    };

    // Segments in document order: <static>…</static> and <transition …>…</transition>
    const segments = [];
    for (const m of xml.matchAll(/<(static|transition)[^>]*>([\s\S]*?)<\/\1>/g)) {
        const body = m[2];
        const file = body.match(/<file>([^<]*)<\/file>/);
        const from = body.match(/<from>([^<]*)<\/from>/);
        const to = body.match(/<to>([^<]*)<\/to>/);
        const dur = body.match(/<duration>([^<]*)<\/duration>/);
        const duration = dur ? parseFloat(dur[1]) : 0;
        if (!Number.isFinite(duration) || duration <= 0)
            continue;
        segments.push({
            kind: m[1],
            duration,
            file: file ? resolve(file[1]) : null,
            from: from ? resolve(from[1]) : null,
            to: to ? resolve(to[1]) : null,
        });
    }

    if (segments.length > 0) {
        // GNOME positions the animation by (now - starttime) mod total duration.
        let elapsed = 0;
        const st = xml.match(/<starttime>([\s\S]*?)<\/starttime>/);
        if (st) {
            const num = tag => {
                const hit = st[1].match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
                return hit ? parseInt(hit[1], 10) : NaN;
            };
            const year = num('year'), month = num('month'), day = num('day');
            const hour = num('hour'), minute = num('minute'), second = num('second');
            if ([year, month, day, hour, minute, second].every(Number.isFinite)) {
                const start = GLib.DateTime.new_local(year, month, day, hour, minute, second);
                const now = GLib.DateTime.new_now_local();
                const diffSeconds = now.difference(start) / 1e6;
                elapsed = diffSeconds;
            }
        }
        const total = segments.reduce((sum, s) => sum + s.duration, 0);
        elapsed = ((elapsed % total) + total) % total;
        let offset = 0;
        for (const seg of segments) {
            if (elapsed < offset + seg.duration) {
                if (seg.kind === 'static')
                    return seg.file;
                const progress = (elapsed - offset) / seg.duration;
                return progress < 0.5 ? (seg.from ?? seg.to) : (seg.to ?? seg.from);
            }
            offset += seg.duration;
        }
        const last = segments[segments.length - 1];
        return last.kind === 'static' ? last.file : (last.to ?? last.from);
    }

    // Simple format: one image per color scheme.
    const light = xml.match(/<filename>([^<]*)<\/filename>/);
    const dark = xml.match(/<filename-dark>([^<]*)<\/filename-dark>/);
    const chosen = (preferDark && dark) ? dark[1] : (light ? light[1] : (dark ? dark[1] : null));
    return chosen ? resolve(chosen) : null;
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

    // Exclude the internal frames of dynamic wallpapers.
    const excluded = new Set();
    for (const w of wallpapers) {
        if (!w.toLowerCase().endsWith('.xml'))
            continue;
        try {
            const file = Gio.File.new_for_path(w);
            const [ok, contents] = file.load_contents(null);
            if (!ok)
                continue;
            collectDynamicFrames(w, new TextDecoder().decode(contents), excluded);
        } catch (e) {
            console.warn(`Wallpapers: could not read dynamic wallpaper ${w}: ${e.message}`);
        }
    }
    const filtered = excluded.size > 0
        ? wallpapers.filter(w => !excluded.has(w))
        : wallpapers;
    return { wallpapers: filtered, directories };
}
