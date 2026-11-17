// dateformat.js
//
// Pattern formatting for the built-in date menu clock, ported from Date Menu
// Formatter (date-menu-formatter@marcinjakubowski.github.com).
//
// The token set is Luxon's, so luxon.js next to this file is the vendored copy
// from that extension. Nothing here imports shell UI modules: the preference
// window runs in its own gjs process and uses this file for the pattern preview.
//
// GPL-2.0-or-later, same as the rest of Open Gnome Box.

import { DateTime } from './luxon.js';

export const FONT_WEIGHT_OPTIONS = ['initial', 'lighter', 'normal', 'bold', 'bolder'];
export const TEXT_ALIGN_OPTIONS = ['left', 'center', 'right'];

function resolvedOptions() {
    return new Intl.DateTimeFormat().resolvedOptions();
}

export function systemLocale() {
    return resolvedOptions().locale;
}

export function systemTimezone() {
    return resolvedOptions().timeZone;
}

export function systemCalendar() {
    return resolvedOptions().calendar;
}

// An empty locale/timezone/calendar means "follow the system", the same way the
// source extension's use-default-* switches did. The system values are resolved
// on every call, so a timezone or locale change needs no extra signal.
export function formatPattern(pattern, date, { locale = '', timezone = '', calendar = '' } = {}) {
    const system = resolvedOptions();
    const dateTime = DateTime.fromJSDate(date)
        .setZone(timezone || system.timeZone)
        .reconfigure({
            locale: locale || system.locale,
            outputCalendar: calendar || system.calendar,
        });
    // Luxon returns an Invalid DateTime instead of throwing for an unknown zone
    // or locale, and toFormat would then render the literal text "Invalid
    // DateTime" into the panel. Fail loudly so the caller can put the shell
    // clock back and log a reason.
    if (!dateTime.isValid)
        throw new Error(dateTime.invalidReason || 'invalid date/time');
    return dateTime.toFormat(String(pattern ?? '').replaceAll('\\n', '\n'));
}
