// wallhub.js
//
// Wallpaper slideshow engine ported from Wallhub (wallhub@sakithb.github.io).
// Original project is archived (https://github.com/sakithb/wallhub).
//
// Ported into Open Gnome Box as a background wallpaper rotation feature. Wallhub's
// setWallpaper writes org.gnome.desktop.background picture-uri / picture-uri-dark,
// which Open Gnome Box already watches to re-derive its color palette — so the two
// features compose without extra coupling.
//
// The control surface is a top-bar indicator (previous / next / random plus a
// preview of the next wallpaper), modelled on the Bing Wallpaper extension.
// There is deliberately no desktop right-click item: on systems with the DING
// desktop-icons extension the desktop menu runs in a separate gjs process and
// cannot be reached from the shell process.
//
// GPL-2.0-or-later, same as the rest of Open Gnome Box.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import Cogl from 'gi://Cogl';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { WallpaperQueue, scanWallpapers } from './wallpaperscan.js';

// Promisify the async GIO methods used for directory enumeration so they can be
// awaited. Without these, the calls throw "At least 5 arguments required" because
// GJS falls back to the callback form, which aborts updateQueue and the slideshow
// never starts.
Gio._promisify(Gio.File.prototype, 'enumerate_children_async', 'enumerate_children_finish');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async', 'next_files_finish');

const PREVIEW_WIDTH = 360;
const PREVIEW_HEIGHT = 203;

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
        this._interfaceSettings = null;

        this.indicator = null;
        this._previewItem = null;
        this._previewBox = null;
        this._previewImage = null;
        this._lastPreviewPath = null;
        this._intervalItem = null;
        this._controlItem = null;
        this._randomIdx = null;
        this._favoriteButton = null;
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
        this._paused = this.settings.get_boolean('slideshow-paused');
        this.favorites = this.settings.get_strv('wallpaper-favorites');

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
        // Keep the indicator in sync when the pref switch changes the value.
        // Single apply path for the persistent flag. Guarded so the signal and
        // setPaused() can both run without depending on ordering.
        this._signalIds.push(this.settings.connect('changed::slideshow-paused', () => {
            try {
                this._paused = this.settings.get_boolean('slideshow-paused');
            } catch (e) {
                return;
            }
            this.startLoop();
            this.updatePauseButton();
        }));
        // Prefs can clear the favorites set; keep the tray star in sync.
        this._signalIds.push(this.settings.connect('changed::wallpaper-favorites', () => {
            try {
                this.favorites = this.settings.get_strv('wallpaper-favorites');
            } catch (e) {
                return;
            }
            this.updateFavoriteButton();
        }));

        this.buildIndicator();
        this.updateIntervalLabel();
        this.updateFavoriteButton();
        // Refresh preview and pick a fresh random candidate whenever the menu
        // is opened, so both always reflect the current state.
        this.indicator.menu.connect('open-state-changed', (menu, isOpen) => {
            if (!isOpen || this.ext.disabling)
                return;
            this._randomIdx = null;
            this.updateIntervalLabel();
            this.updateFavoriteButton();
            this.updatePreview();
        });
        // Keep the default preview and the favorite star in sync when the
        // desktop wallpaper changes (e.g. our own rotation, or another program
        // setting it).
        this._signalIds.push(this.bgSettings.connect('changed::picture-uri', () => {
            if (!this.ext.disabling) {
                this.updatePreview();
                this.updateFavoriteButton();
            }
        }));
        this._signalIds.push(this.bgSettings.connect('changed::picture-uri-dark', () => {
            if (!this.ext.disabling)
                this.updatePreview();
        }));
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
        this._previewImage = null;
        this._lastPreviewPath = null;
        this._intervalItem = null;
        this._controlItem = null;
        this._randomIdx = null;

        this.wallpaperQueue = null;
        this.bgSettings = null;
        this._interfaceSettings = null;
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

        // Margin container. Inside it a plain St.Widget carries the
        // St.ImageContent (St.Bin.child only accepts ClutterActors, and
        // ImageContent is not one).
        this._previewBox = new St.Bin({
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'margin: 12px;',
            x_expand: true,
            y_expand: true,
        });
        this._previewImage = new St.Widget({
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._previewBox.set_child(this._previewImage);
        this._previewItem.add_child(this._previewBox);

        // Interval caption, e.g. "Every 10 seconds".
        this._intervalItem = new PopupMenu.PopupMenuItem('');
        this._intervalItem.setSensitive(false);

        // Control bar: previous / next / random / settings.
        this._controlItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            style_class: 'wallhub-controls',
        });
        try {
            this._controlItem.style = 'padding: 4px 6px;';
        } catch (e) {}
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
            const ICON_SIZE = 22;
            const btnIcon = new St.Icon({
                icon_name: iconName,
                style_class: 'popup-menu-icon',
                icon_size: ICON_SIZE,
            });
            const btn = new St.Button({
                style_class: 'ci-action-btn',
                can_focus: true,
                child: btnIcon,
                x_expand: true,
                y_expand: true,
                track_hover: true,
            });
            // Larger hit area and icon than the default menu button.
            const basePadding = 'padding: 8px 4px;';
            btn.set_size(64, 44);
            btn.style = basePadding;
            btn.connect('clicked', () => {
                if (this.ext.disabling)
                    return;
                callback();
            });
            // Single hover handler: visible feedback plus preview switching.
            // notify::hover is what shell widgets actually use.
            btn.connect('notify::hover', () => {
                if (this.ext.disabling)
                    return;
                const hovered = btn.hover;
                try {
                    btn.style = hovered
                        ? `${basePadding} background-color: rgba(255,255,255,0.16); border-radius: 8px;`
                        : basePadding;
                } catch (e) {
                    // styling must never break interaction
                }
                if (!hoverPath)
                    return;
                if (hovered)
                    this._showPreviewFor(hoverPath());
                else
                    this.updatePreview();
            });
            this._controlItem.add_child(btn);
            return btn;
        };

        this._favoriteButton = makeButton('starred-symbolic', _('Favorite'),
            () => this.toggleFavorite(), null);
        makeButton('media-skip-backward-symbolic', _('Previous'),
            () => this.prevWallpaper(), () => this._peekPrev());
        makeButton('media-skip-forward-symbolic', _('Next'),
            () => this.nextWallpaper(), () => this._peekNext());
        makeButton('media-playlist-shuffle-symbolic', _('Random'),
            () => this.randomWallpaper(), () => this._peekRandom());
        this._pauseButton = makeButton(
            this._paused ? 'media-playback-start-symbolic' : 'media-playback-pause-symbolic',
            _('Pause / Resume'),
            () => this.setPaused(!this._paused), null);
        makeButton('emblem-system-symbolic', _('Open Gnome Box Settings'),
            () => this.ext.openPreferences(), null);
    }

    // ---- Slideshow navigation ----

    _applyAndPreview(path) {
        if (!path)
            return;
        try {
            this.settings.set_string('slideshow-last-path', path);
        } catch (e) {
            console.warn('Wallhub: could not persist last wallpaper: ' + e.message);
        }
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
        // Consume the candidate so the next hover previews a fresh random image.
        this._randomIdx = null;
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
            this._randomIdx = this._weightedRandomIndex();
        return this._randomIdx;
    }

    // Weighted pick: a favorited wallpaper carries slideshow-favorite-weight
    // times the weight of a plain one, so starred images come up more often.
    // The wallpaper currently on the desktop gets zero weight (when there is
    // more than one candidate) so the same image never repeats back to back.
    _weightedRandomIndex() {
        const len = this.wallpaperQueue.length;
        if (len === 0)
            return null;
        let weight;
        try {
            weight = this.settings.get_uint('slideshow-favorite-weight');
        } catch (e) {
            weight = 5;
        }
        const last = this.settings.get_string('slideshow-last-path');
        let total = 0;
        const weights = this.wallpaperQueue.map(path => {
            if (len > 1 && path === last)
                return 0;
            const w = this.favorites && this.favorites.includes(path) ? weight : 1;
            total += w;
            return w;
        });
        if (total <= 0)
            return Math.floor(Math.random() * len);
        let r = Math.random() * total;
        for (let i = 0; i < len; i++) {
            r -= weights[i];
            if (r < 0)
                return i;
        }
        return len - 1;
    }

    // ---- Favorites ----

    _favoriteIconName() {
        const current = this._currentDesktopWallpaper();
        return current && this.favorites && this.favorites.includes(current)
            ? 'starred-symbolic'
            : 'non-starred-symbolic';
    }

    updateFavoriteButton() {
        if (!this._favoriteButton)
            return;
        try {
            this._favoriteButton.child.icon_name = this._favoriteIconName();
        } catch (e) {
            // icon updates must never break the menu
        }
    }

    // Star or unstar the wallpaper currently on the desktop. The path is the
    // anchor (same as slideshow-last-path): it works for read-only system
    // directories and for dynamic .xml wallpapers alike.
    toggleFavorite() {
        const current = this._currentDesktopWallpaper();
        if (!current) {
            console.warn('Wallhub: no current wallpaper to favorite');
            return;
        }
        const idx = this.favorites.indexOf(current);
        if (idx >= 0)
            this.favorites.splice(idx, 1);
        else
            this.favorites.push(current);
        try {
            this.settings.set_strv('wallpaper-favorites', this.favorites);
        } catch (e) {
            console.warn('Wallhub: could not persist favorites: ' + e.message);
            return;
        }
        this.updateFavoriteButton();
    }

    // Path that randomWallpaper() would apply (for the hover preview).
    _peekRandom() {
        const idx = this._randomCandidate();
        return idx === null ? null : this.wallpaperQueue[idx];
    }

    // Resolve a previewable image path for a queue entry. Dynamic wallpaper
    // .xml files have no raster of their own, so extract the first frame.
    _previewImagePath(path) {
        if (!path || typeof path !== 'string')
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

    // Default preview: the wallpaper currently on the desktop.
    updatePreview() {
        this._showPreviewFor(this._currentDesktopWallpaper());
    }

    // Resolve the current desktop wallpaper path, honouring the light/dark
    // colour scheme, and unwrapping dynamic .xml wallpapers to a real image.
    _currentDesktopWallpaper() {
        try {
            if (!this.bgSettings)
                return null;
            let uri = this.bgSettings.get_string('picture-uri');
            if (this._prefersDark()) {
                const darkUri = this.bgSettings.get_string('picture-uri-dark');
                if (darkUri)
                    uri = darkUri;
            }
            if (!uri || !uri.startsWith('file://'))
                return null;
            const [path] = GLib.filename_from_uri(uri);
            return path || null;
        } catch (e) {
            console.warn('Wallhub: could not read current wallpaper: ' + e.message);
            return null;
        }
    }

    _prefersDark() {
        try {
            if (!this._interfaceSettings) {
                this._interfaceSettings =
                    new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
            }
            return this._interfaceSettings.get_string('color-scheme') === 'prefer-dark';
        } catch (e) {
            return false;
        }
    }

    // Show the preview for a specific queue path (or the default next one when
    // path is undefined). Used for hover feedback on the control buttons.
    _showPreviewFor(path) {
        if (!this._previewItem || !this._previewImage)
            return;
        const target = path === undefined ? this._peekNext() : path;
        const imagePath = this._previewImagePath(target);
        if (!imagePath) {
            this._previewItem.hide();
            return;
        }
        // Avoid rebuilding the texture when the requested image is unchanged:
        // notify::hover can fire repeatedly and decoding a full wallpaper each
        // time would be wasteful.
        if (imagePath === this._lastPreviewPath && this._previewItem.visible)
            return;
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
            this._previewImage.set_size(width, height);
            this._previewImage.content = image;
            this._lastPreviewPath = imagePath;
            this._previewItem.show();
        } catch (e) {
            console.warn('Wallhub: preview render failed: ' + e);
            this._lastPreviewPath = null;
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
        if (this.loopSourceId != null) {
            GLib.source_remove(this.loopSourceId);
            this.loopSourceId = null;
        }

        // Respect the paused flag: no timer is created while paused.
        if (this._paused || this.wallpaperQueue.length === 0) {
            this.loopSourceId = null;
            return;
        }

        const interval = this.slideshowInterval * this.slideshowIntervalUnit;
        // Guard against a zero/invalid interval producing a busy loop.
        if (!Number.isFinite(interval) || interval <= 0) {
            console.warn('Wallhub: invalid slideshow interval (' + interval + '), not starting loop');
            this.loopSourceId = null;
            return;
        }

        this.loopSourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            if (this.ext.disabling) {
                this.loopSourceId = null;
                return GLib.SOURCE_REMOVE;
            }
            if (this._paused || this.wallpaperQueue.length === 0) {
                this.loopSourceId = null;
                return GLib.SOURCE_REMOVE;
            }
            this._autoTick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    // One automatic rotation step. Sequential mode walks the queue in order;
    // Random mode draws a weighted pick (favorites get extra weight). Manual
    // previous/next always navigate sequentially regardless of the mode.
    _autoTick() {
        let mode;
        try {
            mode = this.settings.get_enum('slideshow-mode');
        } catch (e) {
            mode = 1;
        }
        if (mode === 0)
            this.nextWallpaper();
        else
            this.randomWallpaper();
    }

    // Toggle automatic rotation. Manual prev/next/random stay available.
    //
    // slideshow-paused is the single source of truth: this writes it and the
    // changed::slideshow-paused handler applies it, so the tray button and the
    // preference switch are the same persistent setting and survive a restart.
    setPaused(paused) {
        const value = Boolean(paused);
        try {
            if (this.settings.get_boolean('slideshow-paused') === value) {
                // Already in the requested state; make sure the in-memory flag
                // and button agree with the stored value.
                this._paused = value;
                this.startLoop();
                this.updatePauseButton();
                return;
            }
            this.settings.set_boolean('slideshow-paused', value);
        } catch (e) {
            console.warn('Wallhub: could not persist slideshow-paused: ' + e.message);
            return;
        }
        // changed::slideshow-paused applies it; do it here too in case the
        // signal is coalesced, but keep both paths idempotent.
        this._paused = value;
        this.startLoop();
        this.updatePauseButton();
    }

    updatePauseButton() {
        if (!this._pauseButton)
            return;
        try {
            this._pauseButton.child.icon_name = this._paused
                ? 'media-playback-start-symbolic'
                : 'media-playback-pause-symbolic';
        } catch (e) {
            // icon updates must never break the menu
        }
    }

    // ---- Source scanning ----

    // Point the cursor at the wallpaper the slideshow last applied, so a
    // restart continues the rotation instead of starting over at queue[0].
    // The queue is rebuilt on every update, so a remembered index would
    // drift as files come and go; the applied path itself is the stable
    // anchor. Falls back to the start when the path is no longer in the
    // queue (its source was removed).
    _resumeCursor() {
        const last = this.settings.get_string('slideshow-last-path');
        if (!last) {
            this._cursor = -1;
            return;
        }
        const idx = this.wallpaperQueue.indexOf(last);
        this._cursor = idx >= 0 ? idx : -1;
    }

    async updateQueue() {
        this.wallpaperQueue.clear();
        this._cursor = -1;
        if (!this.wallpaperPaths || this.wallpaperPaths.length === 0)
            return;

        const { wallpapers, directories } =
            await scanWallpapers(this.wallpaperPaths, this.wallpaperPathsSelected);
        for (const directory of directories)
            this.createDirectoryMonitor(Gio.File.new_for_path(directory));
        for (const wallpaper of wallpapers)
            this.wallpaperQueue.enqueue(wallpaper);
        this._resumeCursor();
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
