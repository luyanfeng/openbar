// magiclamp.js
//
// Compiz-like "magic lamp" minimize / unminimize animation, ported from
// Compiz alike magic lamp effect
// (compiz-alike-magic-lamp-effect@hermes83.github.com).
//
// The shell's own minimize animation is bypassed by patching
// Main.wm._shouldAnimateActor, and its completion hooks are held back until the
// deform effect finishes. Both patches are restored exactly on disable.
//
// GPL-2.0-or-later, same as the rest of Open Gnome Box.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const MINIMIZE_EFFECT_NAME = 'opengnomebox-magic-lamp-minimize';
const UNMINIMIZE_EFFECT_NAME = 'opengnomebox-magic-lamp-unminimize';

const DEFAULT_ICON_SIZE = 48;

export class MagicLampEffects {
    constructor(ext) {
        this.ext = ext;
        this._settings = ext._settings;
        this._enabled = false;
        this._wm = null;
        this._shellwm = null;
        this._originalShouldAnimateActor = null;
        this._originalCompletedMinimize = null;
        this._originalCompletedUnminimize = null;
        this._minimizeId = 0;
        this._unminimizeId = 0;
    }

    enable() {
        if (this._enabled)
            return;

        const wm = Main.wm;
        const shellwm = wm?._shellwm;
        if (typeof wm?._shouldAnimateActor !== 'function' || !shellwm ||
            typeof shellwm.completed_minimize !== 'function' ||
            typeof shellwm.completed_unminimize !== 'function') {
            // The effect is nothing but these three hooks. Refuse to half-apply
            // them and leave a readable reason in the log.
            console.error('Open Gnome Box: magic lamp effect cannot run: ' +
                'WindowManager._shouldAnimateActor or ShellWM.completed_minimize/' +
                'completed_unminimize is missing in this GNOME Shell version.');
            return;
        }

        this._enabled = true;
        this._wm = wm;
        this._shellwm = shellwm;
        this._originalShouldAnimateActor = wm._shouldAnimateActor;
        this._originalCompletedMinimize = shellwm.completed_minimize;
        this._originalCompletedUnminimize = shellwm.completed_unminimize;

        wm._shouldAnimateActor = (actor, types) => {
            const stack = new Error().stack ?? '';
            if (stack.includes('_minimizeWindow') || stack.includes('_unminimizeWindow'))
                return false;
            return this._originalShouldAnimateActor.call(wm, actor, types);
        };
        shellwm.completed_minimize = () => {};
        shellwm.completed_unminimize = () => {};

        this._minimizeId = global.window_manager.connect('minimize',
            (_manager, actor) => this._onMinimize(actor));
        this._unminimizeId = global.window_manager.connect('unminimize',
            (_manager, actor) => this._onUnminimize(actor));
    }

    disable() {
        if (!this._enabled)
            return;
        this._enabled = false;

        if (this._minimizeId) {
            global.window_manager.disconnect(this._minimizeId);
            this._minimizeId = 0;
        }
        if (this._unminimizeId) {
            global.window_manager.disconnect(this._unminimizeId);
            this._unminimizeId = 0;
        }

        // Effects complete (and call the original completed_* hooks) before the
        // patches are restored, so no window is left mid-animation.
        global.get_window_actors().forEach(actor => this._destroyEffect(actor));

        if (this._wm) {
            this._wm._shouldAnimateActor = this._originalShouldAnimateActor;
            this._shellwm.completed_minimize = this._originalCompletedMinimize;
            this._shellwm.completed_unminimize = this._originalCompletedUnminimize;
        }

        this._wm = null;
        this._shellwm = null;
        this._originalShouldAnimateActor = null;
        this._originalCompletedMinimize = null;
        this._originalCompletedUnminimize = null;
    }

    _readConfig() {
        return {
            effect: this._settings.get_string('magic-lamp-effect'),
            duration: this._settings.get_double('magic-lamp-duration'),
            xTiles: Math.round(this._settings.get_double('magic-lamp-x-tiles')),
            yTiles: Math.round(this._settings.get_double('magic-lamp-y-tiles')),
        };
    }

    _onMinimize(actor) {
        if (Main.overview.visible) {
            this._originalCompletedMinimize.call(this._shellwm, actor);
            return;
        }

        const icon = this._getIcon(actor);
        this._destroyEffect(actor);
        actor.add_effect_with_name(MINIMIZE_EFFECT_NAME, new MagicLampMinimizeEffect({
            config: this._readConfig(),
            icon,
            onComplete: () => this._originalCompletedMinimize.call(this._shellwm, actor),
        }));
    }

    _onUnminimize(actor) {
        actor.show();

        if (Main.overview.visible) {
            this._originalCompletedUnminimize.call(this._shellwm, actor);
            return;
        }

        const icon = this._getIcon(actor);
        this._destroyEffect(actor);
        actor.add_effect_with_name(UNMINIMIZE_EFFECT_NAME, new MagicLampUnminimizeEffect({
            config: this._readConfig(),
            icon,
            onComplete: () => this._originalCompletedUnminimize.call(this._shellwm, actor),
        }));
    }

    // Where the window should appear to collapse to: its own icon geometry when
    // the window manager knows it, otherwise the dash icon of its app, otherwise
    // null so the effect uses the bottom of the monitor.
    _getIcon(actor) {
        const metaWindow = actor.meta_window;
        if (!metaWindow)
            return null;

        const [success, geometry] = metaWindow.get_icon_geometry();
        if (success)
            return geometry;

        const monitor = Main.layoutManager.monitors[metaWindow.get_monitor()];
        const dash = Main.overview.dash;
        if (!monitor || !dash?._box)
            return null;

        const pid = metaWindow.get_pid();
        if (!pid)
            return null;

        dash._redisplay?.();
        for (const dashElement of dash._box.get_children()) {
            const app = dashElement.child?._delegate?.app;
            if (!app)
                continue;
            const pids = app.get_pids();
            if (!pids || !pids.includes(pid))
                continue;
            const position = dashElement.get_transformed_position();
            if (position?.[0])
                return { x: position[0], y: monitor.y + monitor.height, width: 0, height: 0 };
        }

        return null;
    }

    _destroyEffect(actor) {
        for (const name of [MINIMIZE_EFFECT_NAME, UNMINIMIZE_EFFECT_NAME]) {
            const effect = actor?.get_effect(name);
            if (effect)
                effect.destroy();
        }
    }
}

class AbstractMagicLampEffect extends Clutter.DeformEffect {
    static {
        GObject.registerClass(this);
    }

    _init(params = {}) {
        super._init();

        this.config = params.config ?? { effect: 'default', duration: 400, xTiles: 10, yTiles: 10 };
        this.icon = params.icon ?? null;
        this.onComplete = params.onComplete ?? null;

        this.EPSILON = 40;

        this._destroyed = false;
        this._timerId = null;
        this._newFrameId = 0;
        this._completedId = 0;
        this._progress = 0;

        this.monitor = { x: 0, y: 0, width: 0, height: 0 };
        this.iconMonitor = { x: 0, y: 0, width: 0, height: 0 };
        this.window = { x: 0, y: 0, width: 0, height: 0 };
        this.iconPosition = null;

        this.progress = 0;
        this.split = 0.3;
        this.k = 0;
        this.j = 0;
        this.expandWidth = 0;
        this.fullWidth = 0;
        this.expandHeight = 0;
        this.fullHeight = 0;
        this.width = 0;
        this.height = 0;
        this.x = 0;
        this.y = 0;
        this.offsetX = 0;
        this.offsetY = 0;
        this.effectX = 0;
        this.effectY = 0;

        this.toTheBorder = true;
        this.maxIconSize = null;
        this.alignIcon = 'center';

        this.initialized = false;
    }

    destroy_actor(actor) {}

    on_tick_elapsed(timer, msecs) {}

    vfunc_set_actor(actor) {
        super.vfunc_set_actor(actor);

        const effectActor = this.get_actor();
        if (!effectActor || this.initialized)
            return;

        this.initialized = true;

        const metaWindow = effectActor.meta_window;
        this.monitor = Main.layoutManager.monitors[metaWindow.get_monitor()];
        if (!this.monitor)
            this.monitor = Main.layoutManager.primaryMonitor;

        this.window.x = effectActor.get_x() - this.monitor.x;
        this.window.y = effectActor.get_y() - this.monitor.y;
        [this.window.width, this.window.height] = effectActor.get_size();

        // get_icon_geometry() hands back a Meta.Rectangle, a boxed GI type whose
        // x/y/width/height are not enumerable own properties: spreading it would
        // yield an empty object and every later calculation NaN. Read the four
        // numbers explicitly, whether the icon came from a rectangle or from
        // this file's own plain object.
        const rawIcon = this.icon;
        if (!rawIcon || (rawIcon.x === 0 && rawIcon.y === 0 &&
            rawIcon.width === 0 && rawIcon.height === 0)) {
            this.icon = {
                x: this.monitor.x + this.monitor.width / 2,
                y: this.monitor.height + this.monitor.y,
                width: 0,
                height: 0,
            };
        } else {
            this.icon = {
                x: rawIcon.x,
                y: rawIcon.y,
                width: rawIcon.width,
                height: rawIcon.height,
            };
        }

        Main.layoutManager.monitors.forEach((monitor, monitorIndex) => {
            let scale = 1;
            if (global.display?.get_monitor_scale)
                scale = global.display.get_monitor_scale(monitorIndex);

            if (this.icon.x >= monitor.x && this.icon.x <= monitor.x + monitor.width * scale &&
                this.icon.y >= monitor.y && this.icon.y <= monitor.y + monitor.height * scale)
                this.iconMonitor = monitor;
        });
        if (this.iconMonitor.x === 0 && this.iconMonitor.y === 0 &&
            this.iconMonitor.width === 0 && this.iconMonitor.height === 0)
            this.iconMonitor = this.monitor;

        this.icon.x -= this.monitor.x;
        this.icon.y -= this.monitor.y;

        if (this.icon.y + this.icon.height >= this.monitor.height - this.EPSILON) {
            this.iconPosition = St.Side.BOTTOM;
            if (this.toTheBorder) {
                this.icon.y = this.iconMonitor.y + this.iconMonitor.height - this.monitor.y;
                this.icon.height = 0;
            }
        } else if (this.icon.x <= this.EPSILON) {
            this.iconPosition = St.Side.LEFT;
            if (this.toTheBorder) {
                this.icon.x = this.iconMonitor.x - this.monitor.x;
                this.icon.width = 0;
            }
        } else if (this.icon.x + this.icon.width >= this.monitor.width - this.EPSILON) {
            this.iconPosition = St.Side.RIGHT;
            if (this.toTheBorder) {
                this.icon.x = this.iconMonitor.x + this.iconMonitor.width - this.monitor.x;
                this.icon.width = 0;
            }
        } else {
            this.iconPosition = St.Side.TOP;
            if (this.toTheBorder) {
                this.icon.y = this.iconMonitor.y - this.monitor.y;
                this.icon.height = 0;
            }
        }

        this.set_n_tiles(this.config.xTiles, this.config.yTiles);

        // The source extension stretches the duration by the ratio of monitor
        // area to window area. A window with no area would divide by zero.
        const areaRatio = this.window.width > 0 && this.window.height > 0
            ? (this.monitor.width * this.monitor.height) / (this.window.width * this.window.height)
            : 0;

        this._timerId = new Clutter.Timeline({
            actor: effectActor,
            duration: Math.round(this.config.duration + areaRatio),
        });
        this._newFrameId = this._timerId.connect('new-frame', this.on_tick_elapsed.bind(this));
        this._completedId = this._timerId.connect('completed', this.destroy.bind(this));
        this._timerId.start();
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;

        if (this._timerId) {
            if (this._newFrameId) {
                this._timerId.disconnect(this._newFrameId);
                this._newFrameId = 0;
            }
            if (this._completedId) {
                this._timerId.disconnect(this._completedId);
                this._completedId = 0;
            }
            this._timerId = null;
        }

        const actor = this.get_actor();
        if (actor) {
            actor.remove_effect(this);
            this.destroy_actor(actor);
        }
        this.onComplete = null;
    }

    vfunc_deform_vertex(w, h, v) {
        if (!this.initialized)
            return;

        const propX = w / this.window.width;
        const propY = h / this.window.height;

        if (this.iconPosition === St.Side.LEFT) {
            this.width = this.window.width - this.icon.width + this.window.x * this.k;

            this.x = (this.width - this.j * this.width) * v.tx;
            this.y = v.ty * this.window.height * (this.x + (this.width - this.x) * (1 - this.k)) / this.width +
                    v.ty * this.icon.height * (this.width - this.x) / this.width;

            this.offsetX = this.icon.width - this.window.x * this.k;
            this.offsetY = (this.icon.y - this.window.y) * ((this.width - this.x) / this.width) * this.k;

            if (this.config.effect === 'sine')
                this.effectY = Math.sin(this.x / this.width * Math.PI * 4) * this.window.height / 14 * this.k;
            else
                this.effectY = Math.sin((0.5 - (this.width - this.x) / this.width) * 2 * Math.PI) * (this.window.y + this.window.height * v.ty - (this.icon.y + this.icon.height * v.ty)) / 7 * this.k;
        } else if (this.iconPosition === St.Side.TOP) {
            this.height = this.window.height - this.icon.height + this.window.y * this.k;

            this.y = (this.height - this.j * this.height) * v.ty;
            this.x = v.tx * this.window.width * (this.y + (this.height - this.y) * (1 - this.k)) / this.height +
                    v.tx * this.icon.width * (this.height - this.y) / this.height;

            this.offsetX = (this.icon.x - this.window.x) * ((this.height - this.y) / this.height) * this.k;
            this.offsetY = this.icon.height - this.window.y * this.k;

            if (this.config.effect === 'sine')
                this.effectX = Math.sin(this.y / this.height * Math.PI * 4) * this.window.width / 14 * this.k;
            else
                this.effectX = Math.sin((0.5 - (this.height - this.y) / this.height) * 2 * Math.PI) * (this.window.x + this.window.width * v.tx - (this.icon.x + this.icon.width * v.tx)) / 7 * this.k;
        } else if (this.iconPosition === St.Side.RIGHT) {
            this.expandWidth = this.iconMonitor.width - this.icon.width - this.window.x - this.window.width;
            this.fullWidth = (this.iconMonitor.width - this.icon.width - this.window.x) - this.expandWidth * (1 - this.k);
            this.width = this.fullWidth - this.j * this.fullWidth;

            this.x = v.tx * this.width;
            this.y = v.ty * this.icon.height +
                    v.ty * (this.window.height - this.icon.height) * (1 - this.j) * (1 - v.tx) +
                    v.ty * (this.window.height - this.icon.height) * (1 - this.k) * v.tx;

            this.offsetY = (this.icon.y - this.window.y) * (this.x / this.fullWidth) * this.k + (this.icon.y - this.window.y) * this.j;
            this.offsetX = this.iconMonitor.width - this.icon.width - this.window.x - this.width - this.expandWidth * (1 - this.k);

            if (this.config.effect === 'sine')
                this.effectY = Math.sin((this.width - this.x) / this.fullWidth * Math.PI * 4) * this.window.height / 14 * this.k;
            else
                this.effectY = Math.sin(((this.width - this.x) / this.fullWidth) * 2 * Math.PI + Math.PI) * (this.window.y + this.window.height * v.ty - (this.icon.y + this.icon.height * v.ty)) / 7 * this.k;
        } else if (this.iconPosition === St.Side.BOTTOM) {
            this.expandHeight = this.iconMonitor.height - this.icon.height - this.window.y - this.window.height;
            this.fullHeight = (this.iconMonitor.height - this.icon.height - this.window.y) - this.expandHeight * (1 - this.k);
            this.height = this.fullHeight - this.j * this.fullHeight;

            this.y = v.ty * this.height;
            this.x = v.tx * this.icon.width +
                    v.tx * (this.window.width - this.icon.width) * (1 - this.j) * (1 - v.ty) +
                    v.tx * (this.window.width - this.icon.width) * (1 - this.k) * v.ty;

            this.offsetX = (this.icon.x - this.window.x) * (this.y / this.fullHeight) * this.k + (this.icon.x - this.window.x) * this.j;
            this.offsetY = this.iconMonitor.height - this.icon.height - this.window.y - this.height - this.expandHeight * (1 - this.k);

            if (this.config.effect === 'sine')
                this.effectX = Math.sin((this.height - this.y) / this.fullHeight * Math.PI * 4) * this.window.width / 14 * this.k;
            else
                this.effectX = Math.sin(((this.height - this.y) / this.fullHeight) * 2 * Math.PI + Math.PI) * (this.window.x + this.window.width * v.tx - (this.icon.x + this.icon.width * v.tx)) / 7 * this.k;
        }

        v.x = (this.x + this.offsetX + this.effectX) * propX;
        v.y = (this.y + this.offsetY + this.effectY) * propY;
    }
}

class MagicLampMinimizeEffect extends AbstractMagicLampEffect {
    static {
        GObject.registerClass(this);
    }

    _init(params = {}) {
        super._init(params);

        this.k = 0;
        this.j = 0;
    }

    destroy_actor(actor) {
        const onComplete = this.onComplete;
        if (onComplete)
            onComplete(actor);
    }

    on_tick_elapsed(timer, msecs) {
        if (Main.overview.visible) {
            this.destroy();
            return;
        }

        this.progress = timer.get_progress();
        this.k = this.progress <= this.split ? this.progress * (1 / 1 / this.split) : 1;
        this.j = this.progress > this.split ? (this.progress - this.split) * (1 / 1 / (1 - this.split)) : 0;

        const actor = this.get_actor();
        actor?.get_parent()?.queue_redraw();
        this.invalidate();
    }

    vfunc_modify_paint_volume(pv) {
        return false;
    }
}

class MagicLampUnminimizeEffect extends AbstractMagicLampEffect {
    static {
        GObject.registerClass(this);
    }

    _init(params = {}) {
        super._init(params);

        this.k = 1;
        this.j = 1;
    }

    destroy_actor(actor) {
        const onComplete = this.onComplete;
        if (onComplete)
            onComplete(actor);
    }

    on_tick_elapsed(timer, msecs) {
        if (Main.overview.visible) {
            this.destroy();
            return;
        }

        this.progress = timer.get_progress();
        this.k = 1 - (this.progress > (1 - this.split) ? (this.progress - (1 - this.split)) * (1 / 1 / (1 - (1 - this.split))) : 0);
        this.j = 1 - (this.progress <= (1 - this.split) ? this.progress * (1 / 1 / (1 - this.split)) : 1);

        const actor = this.get_actor();
        actor?.get_parent()?.queue_redraw();
        this.invalidate();
    }

    vfunc_modify_paint_volume(pv) {
        return false;
    }
}
