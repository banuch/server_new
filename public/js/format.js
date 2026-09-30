// Formatting of timestamps and engineering values. Every timestamp is shown in
// the configured display time zone, never the browser's, so all operators see
// the same clock.
import { serverNow } from './api.js';

let timeZone = 'Asia/Kolkata';
let partsFormat = null;
const LOCALE = 'en-IN';

export function setTimeZone(value) {
    timeZone = value;
    partsFormat = null;
}

export function zoneLabel() {
    try {
        const part = new Intl.DateTimeFormat(LOCALE, { timeZone, timeZoneName: 'short' })
            .formatToParts(new Date()).find((item) => item.type === 'timeZoneName');
        return part ? part.value : timeZone;
    } catch {
        return timeZone;
    }
}

export function zoneName() {
    return timeZone;
}

function parts(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (value === null || value === undefined || value === '' || Number.isNaN(date.getTime())) return null;
    partsFormat ||= new Intl.DateTimeFormat('en-GB', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
    return Object.fromEntries(partsFormat.formatToParts(date).map((part) => [part.type, part.value]));
}

// 30-09-2026 10:15:24
export function dateTime(value) {
    const p = parts(value);
    return p ? `${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute}:${p.second}` : '—';
}

// 30-09-2026 10:15
export function dateMinute(value) {
    const p = parts(value);
    return p ? `${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute}` : '—';
}

export function dateOnly(value) {
    const p = parts(value);
    return p ? `${p.day}-${p.month}-${p.year}` : '—';
}

// Time of day when the value is from today, otherwise date and time.
export function shortTime(value) {
    const p = parts(value);
    if (!p) return '—';
    const today = parts(new Date(serverNow()));
    const time = `${p.hour}:${p.minute}:${p.second}`;
    return p.day === today.day && p.month === today.month && p.year === today.year
        ? time : `${p.day}-${p.month} ${p.hour}:${p.minute}`;
}

export function clockTime(value) {
    const p = parts(value);
    return p ? `${p.hour}:${p.minute}:${p.second}` : '—';
}

export function durationText(seconds) {
    if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return '—';
    const s = Math.max(0, Math.round(seconds));
    if (s < 60) return `${s} s`;
    if (s < 3600) return `${Math.floor(s / 60)} min`;
    if (s < 86400) {
        const minutes = Math.floor((s % 3600) / 60);
        return `${Math.floor(s / 3600)} h${minutes ? ` ${minutes} min` : ''}`;
    }
    const hours = Math.floor((s % 86400) / 3600);
    return `${Math.floor(s / 86400)} d${hours ? ` ${hours} h` : ''}`;
}

export function ageSeconds(value) {
    if (!value) return null;
    const time = new Date(value).getTime();
    return Number.isNaN(time) ? null : Math.max(0, (serverNow() - time) / 1000);
}

export function ago(value) {
    const seconds = ageSeconds(value);
    return seconds === null ? 'never' : `${durationText(seconds)} ago`;
}

// datetime-local input value (in the display time zone) → ISO string
export function localInputToIso(value) {
    if (!value) return '';
    const [date, time = '00:00'] = value.split('T');
    const [year, month, day] = date.split('-').map(Number);
    const [hour, minute] = time.split(':').map(Number);
    const guess = Date.UTC(year, month - 1, day, hour, minute);
    const p = parts(new Date(guess));
    const shown = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
    return new Date(guess - (shown - guess)).toISOString();
}

// ISO / Date → datetime-local input value in the display time zone
export function isoToLocalInput(value) {
    const p = parts(value);
    return p ? `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}` : '';
}

export function present(value) {
    return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

export function num(value, digits = 2) {
    if (!present(value)) return '—';
    return Number(value).toLocaleString(LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function int(value) {
    return num(value, 0);
}

// Base SI value (W, Wh, VA, …) shown in kilo-units.
export function kilo(value, digits = 2) {
    return present(value) ? num(Number(value) / 1000, digits) : '—';
}

export function withUnit(text, unit) {
    return text === '—' ? text : `${text} ${unit}`;
}

export function bytesToMb(value) {
    return present(value) ? `${num(Number(value) / 1048576, 2)} MB` : '—';
}

// Spread between the highest and lowest phase relative to their average, in
// percent; ignores missing and zero phases.
export function unbalance(values) {
    const loaded = values.filter(present).map(Number).filter((value) => value !== 0);
    if (loaded.length < 2) return null;
    const average = loaded.reduce((sum, value) => sum + value, 0) / loaded.length;
    return ((Math.max(...loaded) - Math.min(...loaded)) / Math.abs(average)) * 100;
}

export function average(values) {
    const loaded = values.filter(present).map(Number);
    return loaded.length ? loaded.reduce((sum, value) => sum + value, 0) / loaded.length : null;
}
