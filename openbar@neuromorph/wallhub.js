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
// GPL-2.0-or-later, same as the rest of Open Bar.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

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

// ---- Wallhub manager (slideshow engine) ----
export class WallhubManager {
    constructor(ext) {
        this.ext = ext;
        this.settings = ext._settings;
        this.bgSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.background' });

        this.wallpaperQueue = new WallpaperQueue();
        this.directoryMonitors = [];
        this.loopSourceId = null;
        this._signalIds = [];
        this._bgMenuInjected = false;
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

        this._signalIds.push(this.settings.connect('changed::wallpaper-paths', () => {
            this.wallpaperPaths = this.settings.get_strv('wallpaper-paths');
        }));
        this._signalIds.push(this.settings.connect('changed::wallpaper-paths-selected', () => {
            this.wallpaperPathsSelected = this.settings.get_int('wallpaper-paths-selected');
            this.updateQueue()
                .catch(e => console.error('Wallhub: updateQueue failed: ' + e));
        }));
        this._signalIds.push(this.settings.connect('changed::slideshow-interval-unit', () => {
            this.slideshowIntervalUnit = this.settings.get_enum('slideshow-interval-unit');
            this.startLoop();
        }));
        this._signalIds.push(this.settings.connect('changed::slideshow-interval', () => {
            this.slideshowInterval = this.settings.get_uint('slideshow-interval');
            this.startLoop();
        }));

        this.injectBackgroundMenu();
        this.updateQueue()
            .then(this.startLoop.bind(this))
            .catch(e => console.error('Wallhub: updateQueue failed: ' + e));
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

        this.removeBackgroundMenu();
        this.wallpaperQueue = null;
        this.bgSettings = null;
    }

    // Add "Next Wallpaper" item to every monitor's desktop background menu
    injectBackgroundMenu() {
        if (this._bgMenuInjected)
            return;
        // _addBackgroundMenu is called when a BackgroundManager is created;
        // hook after the original so the menu already exists.
        // Store the original method in _injections so that _removeInjection
        // can restore it on disable; otherwise the injected wrapper would be
        // deleted and the original lost (breaking background menu on reload).
        this.ext._injections['_addBackgroundMenu'] = this.ext._injectToFunction(
            Main.layoutManager,
            '_addBackgroundMenu',
            (bgManager) => {
                if (this.ext.disabling)
                    return;
                try {
                    // bgManager.backgroundActor._backgroundMenu is set by the original
                    const menu = bgManager.backgroundActor._backgroundMenu;
                    if (menu)
                        this.addBackgroundMenuItem(menu);
                } catch (e) {}
            }
        );
        this._bgMenuInjected = true;

        // Also add to already-existing managers
        try {
            Main.layoutManager._bgManagers.forEach(bgManager => {
                const menu = bgManager.backgroundActor._backgroundMenu;
                if (menu)
                    this.addBackgroundMenuItem(menu);
            });
        } catch (e) {}
    }

    removeBackgroundMenu() {
        // Restore the original method
        this.ext._removeInjection(Main.layoutManager, this.ext._injections, '_addBackgroundMenu');
        this._bgMenuInjected = false;

        // Remove the menu items we added
        try {
            Main.layoutManager._bgManagers.forEach(bgManager => {
                const menu = bgManager.backgroundActor._backgroundMenu;
                if (!menu)
                    return;
                menu._getMenuItems().forEach(item => {
                    if (item.label_actor && item.label_actor.text === _('Next Wallpaper'))
                        menu.box.remove_child(item.actor);
                });
            });
        } catch (e) {}
    }

    addBackgroundMenuItem(menu) {
        const menuItem = new PopupMenu.PopupMenuItem(_('Next Wallpaper'));
        menuItem.connect('activate', () => {
            if (this.ext.disabling)
                return;
            const wallpaper = this.wallpaperQueue.dequeue();
            if (wallpaper != null)
                this.setWallpaper(wallpaper);
        });
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(null));
        menu.addMenuItem(menuItem);
    }

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
            const wallpaper = this.wallpaperQueue.dequeue();
            if (wallpaper != null) {
                this.setWallpaper(wallpaper)
                    .catch(e => console.error('Wallhub: setWallpaper failed: ' + e));
                return GLib.SOURCE_CONTINUE;
            }
            this.loopSourceId = null;
            return GLib.SOURCE_REMOVE;
        });
    }

    async updateQueue() {
        this.wallpaperQueue.clear();
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
                const file = directory.get_child(fileInfo.get_name());
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

    async setWallpaper(path) {
        if (!path) {
            console.error('Wallhub: setWallpaper called with empty path');
            return;
        }
        const extension = path.split('.').pop().toLowerCase();
        if (extension === 'xml') {
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
            const dwpConfig = parseDynamicWallpaper(xml);
            if (dwpConfig == null) {
                console.error('Wallhub: Failed to parse dynamic wallpaper: ' + path);
                return;
            }
            this.bgSettings.set_string('picture-uri', 'file:///' + dwpConfig.lightBg);
            this.bgSettings.set_string('picture-uri-dark', 'file:///' + dwpConfig.darkBg);
        } else {
            this.bgSettings.set_string('picture-uri', 'file:///' + path);
            this.bgSettings.set_string('picture-uri-dark', 'file:///' + path);
        }
    }
}
