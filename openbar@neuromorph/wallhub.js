// wallhub.js
//
// Wallpaper slideshow engine ported from Wallhub (wallhub@sakithb.github.io).
// Original project is archived (https://github.com/sakithb/wallhub).
//
// Ported into Open Bar as a background wallpaper rotation feature. Wallhub's
// setWallpaper writes org.gnome.desktop.background picture-uri / picture-uri-dark,
// which Open Bar already watches to re-derive its color palette — so the two
// features compose without extra coupling.
//
// The control surface is a top-bar indicator (previous / next / random plus a
// preview of the next wallpaper), modelled on the Bing Wallpaper extension.
// There is deliberately no desktop right-click item: on systems with the DING
// desktop-icons extension the desktop menu runs in a separate gjs process and
// cannot be reached from the shell process.
//
// GPL-2.0-or-later, same as the rest of Open Bar.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import Cogl from 'gi://Cogl';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

// Promisify the async GIO methods used for directory enumeration so they can be
// awaited. Without these, the calls throw "At least 5 arguments required" because
// GJS falls back to the callback form, which aborts updateQueue and the slideshow
// never starts.
Gio._promisify(Gio.File.prototype, 'enumerate_children_async', 'enumerate_children_finish');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async', 'next_files_finish');

const PREVIEW_WIDTH = 360;
const PREVIEW_HEIGHT = 203;

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

    dequeue() {
        if (this.length === 0)
            return null;
        // Rotate: pick a pseudo-random entry from the first 80% and move it to
        // the end, so the same image does not repeat too soon.
        const index = Math.floor(Math.random() * (this.length * 0.8));
        const wallpaper = this.splice(index, 1)[0];
        this.push(wallpaper);
        return wallpaper;
    }

    clear() {
        this.length = 0;
    }
}

// ---- Dynamic wallpaper (.xml) parser ----
export function parseDynamicWallpaper(xml) {
    const name = xml.match(/<name>(.*?)<\/name>/);
    const lightBg = xml.match(/<filename>(.*?)<\/filename>/);
    const darkBg = xml.match(/<filename-dark>(.*?)<\/filename-dark>/);

    if (!name || !lightBg || !darkBg)
        return null;
    return {
        name: name[1],
        lightBg: lightBg[1],
        darkBg: darkBg[1],
    };
}

// ---- Wallhub manager (slideshow engine + top-bar indicator) ----
export class WallhubManager {
    constructor(ext) {
        this.ext = ext;
        this.settings = ext._settings;
        this.bgSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.background' });

        this.wallpaperQueue = new WallpaperQueue();
        this.directoryMonitors = [];
        this.loopSourceId = null;
        this._signalIds = [];
        this._cursor = -1;

        this.indicator = null;
        this._previewItem = null;
        this._previewBox = null;
        this._intervalItem = null;
        this._controlItem = null;
        this._randomIdx = null;
    }

    enable() {
        if (this._enabled) {
            console.warn('Wallhub: enable() called while already enabled; skipping');
            return;
        }
        this._enabled = true;

        this.wallpaperPaths = this.settings.get_strv('wallpaper-paths');
        this.wallpaperPathsSelected = this.settings.get_int('wallpaper-paths-selected');
        this.slideshowIntervalUnit = this.settings.get_enum('slideshow-interval-unit');
        this.slideshowInterval = this.settings.get_uint('slideshow-interval');

        // First run with no configured sources: seed the system wallpaper
        // directory so the slideshow works out of the box and is visible in prefs.
        if (this.wallpaperPaths.length === 0)
            this.seedDefaultPaths();

        this._signalIds.push(this.settings.connect('changed::wallpaper-paths', () => {
            this.wallpaperPaths = this.settings.get_strv('wallpaper-paths');
            this.updateQueue()
                .then(() => this.updatePreview())
                .catch(e => console.error('Wallhub: updateQueue failed: ' + e));
        }));
        this._signalIds.push(this.settings.connect('changed::wallpaper-paths-selected', () => {
            this.wallpaperPathsSelected = this.settings.get_int('wallpaper-paths-selected');
            this.updateQueue()
                .then(() => this.updatePreview())
                .catch(e => console.error('Wallhub: updateQueue failed: ' + e));
        }));
        this._signalIds.push(this.settings.connect('changed::slideshow-interval-unit', () => {
            this.slideshowIntervalUnit = this.settings.get_enum('slideshow-interval-unit');
            this.updateIntervalLabel();
            this.startLoop();
        }));
        this._signalIds.push(this.settings.connect('changed::slideshow-interval', () => {
            this.slideshowInterval = this.settings.get_uint('slideshow-interval');
            this.updateIntervalLabel();
            this.startLoop();
        }));

        this.buildIndicator();
        this.updateIntervalLabel();
        // Refresh preview and pick a fresh random candidate whenever the menu
        // is opened, so both always reflect the current state.
        this.indicator.menu.connect('open-state-changed', (menu, isOpen) => {
            if (!isOpen || this.ext.disabling)
                return;
            this._randomIdx = null;
            this.updateIntervalLabel();
            this.updatePreview();
        });
        this.updateQueue()
            .then(() => {
                this.startLoop();
                this.updatePreview();
            })
            .catch(e => console.error('Wallhub: updateQueue failed: ' + e));
    }

    // Populate wallpaper-paths with the system backgrounds directory on first run.
    seedDefaultPaths() {
        const candidates = [
            '/usr/share/backgrounds',
            '/usr/share/wallpapers',
            GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES),
        ];
        for (const dir of candidates) {
            if (!dir)
                continue;
            const file = Gio.File.new_for_path(dir);
            if (file.query_exists(null) &&
                file.query_file_type(Gio.FileQueryInfoFlags.NONE, null) === Gio.FileType.DIRECTORY) {
                this.settings.set_strv('wallpaper-paths', [dir]);
                // Select the single seeded source (bit 0).
                this.settings.set_int('wallpaper-paths-selected', 1);
                this.wallpaperPaths = [dir];
                this.wallpaperPathsSelected = 1;
                console.log('Wallhub: seeded default wallpaper directory: ' + dir);
                return;
            }
        }
    }

    disable() {
        this._enabled = false;
        this._signalIds.forEach(id => {
            try { this.settings.disconnect(id); } catch (e) {}
        });
        this._signalIds = [];

        this.wallpaperQueue.clear();
        this.directoryMonitors.forEach(monitor => {
            try { monitor.cancel(); } catch (e) {}
        });
        this.directoryMonitors = [];

        if (this.loopSourceId != null) {
            GLib.source_remove(this.loopSourceId);
            this.loopSourceId = null;
        }

        if (this.indicator) {
            this.indicator.destroy();
            this.indicator = null;
        }
        this._previewItem = null;
        this._previewBox = null;
        this._intervalItem = null;
        this._controlItem = null;
        this._randomIdx = null;

        this.wallpaperQueue = null;
        this.bgSettings = null;
    }

    // ---- Top-bar indicator ----

    buildIndicator() {
        this.indicator = new PanelMenu.Button(0.0, 'openbar-wallhub', false);

        const icon = new St.Icon({
            icon_name: 'preferences-desktop-wallpaper-symbolic',
            style_class: 'system-status-icon',
        });
        this.indicator.add_child(icon);

        // Preview of the wallpaper the hovered/next action would apply. Wrapped
        // in a container so the image keeps a margin on all four sides.
        this._previewItem = new PopupMenu.PopupBaseMenuItem({
            style_class: 'wallhub-preview',
            reactive: false,
        });
        this._previewItem.setSensitive(false);

        this._previewBox = new St.Bin({
            x_align: St.Align.MIDDLE,
            y_align: St.Align.MIDDLE,
            style: 'margin: 12px;',
            x_expand: true,
            y_expand: true,
        });
        this._previewItem.add_child(this._previewBox);

        // Interval caption, e.g. "Every 10 seconds".
        this._intervalItem = new PopupMenu.PopupMenuItem('');
        this._intervalItem.setSensitive(false);

        // Control bar: previous / next / random / settings.
        this._controlItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        this.buildControls();

        this.indicator.menu.addMenuItem(this._intervalItem);
        this.indicator.menu.addMenuItem(this._previewItem);
        this.indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.indicator.menu.addMenuItem(this._controlItem);

        Main.panel.addToStatusArea('openbar-wallhub', this.indicator, 1, 'right');
    }

    buildControls() {
        // hoverPath: preview path to show while the pointer is over this button
        // (undefined = keep the default next-wallpaper preview).
        const makeButton = (iconName, tooltip, callback, hoverPath) => {
            const btnIcon = new St.Icon({
                icon_name: iconName,
                style_class: 'popup-menu-icon',
                icon_size: 16,
            });
            const btn = new St.Button({
                style_class: 'ci-action-btn',
                can_focus: true,
                child: btnIcon,
                x_expand: true,
                y_expand: true,
            });
            btn.connect('clicked', () => {
                if (this.ext.disabling)
                    return;
                callback();
            });
            btn.connect('enter-event', () => {
                if (!this.ext.disabling)
                    this._showPreviewFor(hoverPath ? hoverPath() : undefined);
                return false;
            });
            btn.connect('leave-event', () => {
                if (!this.ext.disabling)
                    this.updatePreview();
                return false;
            });
            this._controlItem.add_child(btn);
            return btn;
        };

        makeButton('media-skip-backward-symbolic', _('Previous'),
            () => this.prevWallpaper(), () => this._peekPrev());
        makeButton('media-skip-forward-symbolic', _('Next'),
            () => this.nextWallpaper(), () => this._peekNext());
        makeButton('media-playlist-shuffle-symbolic', _('Random'),
            () => this.randomWallpaper(), () => this._randomCandidate());
        makeButton('emblem-system-symbolic', _('Open Bar Settings'),
            () => this.ext.openPreferences(), null);
    }

    // ---- Slideshow navigation ----

    _applyAndPreview(path) {
        if (!path)
            return;
        this.setWallpaper(path)
            .then(() => this.updatePreview())
            .catch(e => console.error('Wallhub: setWallpaper failed: ' + e));
    }

    nextWallpaper() {
        const len = this.wallpaperQueue.length;
        if (len === 0)
            return;
        this._cursor = (this._cursor + 1) % len;
        this._applyAndPreview(this.wallpaperQueue[this._cursor]);
    }

    prevWallpaper() {
        const len = this.wallpaperQueue.length;
        if (len === 0)
            return;
        this._cursor = (this._cursor - 1 + len) % len;
        this._applyAndPreview(this.wallpaperQueue[this._cursor]);
    }

    randomWallpaper() {
        const len = this.wallpaperQueue.length;
        if (len === 0)
            return;
        // Apply the candidate that was already being previewed, so what the user
        // saw is exactly what gets applied.
        const candidate = this._randomCandidate();
        this._cursor = candidate !== null ? candidate : Math.floor(Math.random() * len);
        this._applyAndPreview(this.wallpaperQueue[this._cursor]);
    }

    // Path that nextWallpaper() would apply.
    _peekNext() {
        const len = this.wallpaperQueue.length;
        if (len === 0)
            return null;
        return this.wallpaperQueue[(this._cursor + 1) % len];
    }

    // Path that prevWallpaper() would apply.
    _peekPrev() {
        const len = this.wallpaperQueue.length;
        if (len === 0)
            return null;
        return this.wallpaperQueue[(this._cursor - 1 + len) % len];
    }

    // A stable random candidate index, kept until randomWallpaper() consumes it
    // so the preview and the applied wallpaper are the same image.
    _randomCandidate() {
        const len = this.wallpaperQueue.length;
        if (len === 0)
            return null;
        if (this._randomIdx === undefined || this._randomIdx === null ||
            this._randomIdx < 0 || this._randomIdx >= len)
            this._randomIdx = Math.floor(Math.random() * len);
        return this._randomIdx;
    }

    // Resolve a previewable image path for a queue entry. Dynamic wallpaper
    // .xml files have no raster of their own, so extract the first frame.
    _previewImagePath(path) {
        if (!path)
            return null;
        if (!path.toLowerCase().endsWith('.xml'))
            return path;
        try {
            const [ok, bytes] = Gio.File.new_for_path(path).load_contents(null);
            if (!ok)
                return null;
            const xml = new TextDecoder().decode(bytes);
            const match = xml.match(/<file>(.*?)<\/file>/) ||
                xml.match(/<from>(.*?)<\/from>/) ||
                xml.match(/<filename>(.*?)<\/filename>/);
            return match ? match[1] : null;
        } catch (e) {
            console.warn('Wallhub: could not extract preview frame: ' + e);
            return null;
        }
    }

    updatePreview() {
        this._showPreviewFor(this._peekNext());
    }

    // Show the preview for a specific queue path (or the default next one when
    // path is undefined). Used for hover feedback on the control buttons.
    _showPreviewFor(path) {
        if (!this._previewItem || !this._previewBox)
            return;
        const target = path === undefined ? this._peekNext() : path;
        const imagePath = this._previewImagePath(target);
        if (!imagePath) {
            this._previewItem.hide();
            return;
        }
        try {
            const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            const width = Math.round(PREVIEW_WIDTH * scale);
            const height = Math.round(PREVIEW_HEIGHT * scale);
            const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_size(imagePath, width, height);
            const image = new St.ImageContent();
            const args = [
                pixbuf.get_pixels(),
                pixbuf.get_has_alpha() ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
                pixbuf.get_width(),
                pixbuf.get_height(),
                pixbuf.get_rowstride(),
            ];
            if ((this.ext.gnomeVersion || 50) >= 48)
                args.unshift(global.stage.context.get_backend().get_cogl_context());
            const ok = image.set_data(...args);
            if (!ok) {
                console.warn('Wallhub: failed to build preview image');
                this._previewItem.hide();
                return;
            }
            this._previewBox.set_size(width, height);
            this._previewBox.child = image;
            this._previewItem.show();
        } catch (e) {
            console.warn('Wallhub: preview render failed: ' + e);
            this._previewItem.hide();
        }
    }

    // Human-readable interval, e.g. "Every 10 seconds" / "Every 5 minutes".
    _intervalLabel() {
        const unit = this.slideshowIntervalUnit;
        const n = this.slideshowInterval;
        if (unit >= 3600) {
            return n === 1
                ? _('Changes every hour')
                : _('Changes every %d hours').format(n);
        }
        if (unit >= 60) {
            return n === 1
                ? _('Changes every minute')
                : _('Changes every %d minutes').format(n);
        }
        return n === 1
            ? _('Changes every second')
            : _('Changes every %d seconds').format(n);
    }

    updateIntervalLabel() {
        if (this._intervalItem)
            this._intervalItem.label.text = this._intervalLabel();
    }

    // ---- Timed rotation ----

    startLoop() {
        if (this.loopSourceId != null)
            GLib.source_remove(this.loopSourceId);

        if (this.wallpaperQueue.length === 0) {
            this.loopSourceId = null;
            return;
        }

        const interval = this.slideshowInterval * this.slideshowIntervalUnit;
        this.loopSourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            if (this.ext.disabling) {
                this.loopSourceId = null;
                return GLib.SOURCE_REMOVE;
            }
            if (this.wallpaperQueue.length === 0) {
                this.loopSourceId = null;
                return GLib.SOURCE_REMOVE;
            }
            this.nextWallpaper();
            return GLib.SOURCE_CONTINUE;
        });
    }

    // ---- Source scanning ----

    async updateQueue() {
        this.wallpaperQueue.clear();
        this._cursor = -1;
        if (!this.wallpaperPaths || this.wallpaperPaths.length === 0)
            return;

        for (let i = 0; i < this.wallpaperPaths.length; i++) {
            const path = this.wallpaperPaths[i];
            if (!isBitSet(this.wallpaperPathsSelected, i))
                continue;
            if (!path) {
                console.error('Wallhub: Empty path at index ' + i);
                continue;
            }
            const file = Gio.File.new_for_path(path);
            const fileType = file.query_file_type(Gio.FileQueryInfoFlags.NONE, null);
            if (fileType === Gio.FileType.REGULAR) {
                this.wallpaperQueue.enqueue(path);
            } else if (fileType === Gio.FileType.DIRECTORY) {
                const wallpapers = await this.getWallpapersFromDirectory(file);
                if (wallpapers == null) {
                    console.error('Wallhub: Failed to get wallpapers from directory: ' + path);
                    return;
                }
                for (const wallpaper of wallpapers)
                    this.wallpaperQueue.enqueue(wallpaper);
            } else {
                console.error('Wallhub: Invalid file type: ' + path);
            }
        }
    }

    async getWallpapersFromDirectory(directory) {
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
                // Skip hidden files and unsupported formats (e.g. SVG, which the
                // GNOME background does not support).
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
                    const childWallpapers = await this.getWallpapersFromDirectory(file);
                    wallpapers.push(...childWallpapers);
                }
            }
        }
        this.createDirectoryMonitor(directory);
        return wallpapers;
    }

    createDirectoryMonitor(file) {
        const monitor = file.monitor_directory(Gio.FileMonitorFlags.NONE, null);
        monitor.rateLimit = 1000;
        monitor.connect('changed', (m, changedFile, otherFile, eventType) => {
            if (this.ext.disabling)
                return;
            const pathname = changedFile.get_path();
            if (eventType === Gio.FileMonitorEvent.CREATED) {
                if (!this.wallpaperQueue.includes(pathname))
                    this.wallpaperQueue.enqueue(pathname);
            } else if (eventType === Gio.FileMonitorEvent.DELETED) {
                this.wallpaperQueue.remove(pathname);
            }
        });
        this.directoryMonitors.push(monitor);
    }

    // ---- Apply wallpaper ----

    async setWallpaper(path) {
        if (!path) {
            console.error('Wallhub: setWallpaper called with empty path');
            return;
        }
        // Normalize to a proper file:// URI (avoids //// from naive concatenation).
        const toUri = p => GLib.filename_to_uri(p, null);
        const extension = path.split('.').pop().toLowerCase();
        if (extension === 'xml') {
            // GNOME-native dynamic wallpapers use the <background> schema and are
            // played automatically by GNOME's own background manager when set as
            // picture-uri — no manual time-based switching is needed. Only fall
            // back to Wallhub's own dwp format (<name>/<filename>/<filename-dark>)
            // if the file is not a GNOME native dynamic wallpaper.
            let xmlBytes;
            try {
                const file = Gio.File.new_for_path(path);
                const [ok, contents] = file.load_contents(null);
                if (!ok) {
                    console.error('Wallhub: Failed to read dynamic wallpaper: ' + path);
                    return;
                }
                xmlBytes = contents;
            } catch (e) {
                console.error('Wallhub: Failed to read dynamic wallpaper: ' + e);
                return;
            }
            const decoder = new TextDecoder();
            const xml = decoder.decode(xmlBytes);
            if (xml.includes('<background>')) {
                // GNOME native dynamic wallpaper: set directly and let GNOME
                // handle the time-based transitions.
                this.bgSettings.set_string('picture-uri', toUri(path));
                this.bgSettings.set_string('picture-uri-dark', toUri(path));
                return;
            }
            const dwpConfig = parseDynamicWallpaper(xml);
            if (dwpConfig == null) {
                console.error('Wallhub: Failed to parse dynamic wallpaper: ' + path);
                return;
            }
            this.bgSettings.set_string('picture-uri', toUri(dwpConfig.lightBg));
            this.bgSettings.set_string('picture-uri-dark', toUri(dwpConfig.darkBg));
        } else if (extension === 'svg') {
            // GNOME background does not support SVG; skip to avoid a broken set.
            console.warn('Wallhub: skipping unsupported SVG wallpaper: ' + path);
        } else {
            this.bgSettings.set_string('picture-uri', toUri(path));
            this.bgSettings.set_string('picture-uri-dark', toUri(path));
        }
    }
}
