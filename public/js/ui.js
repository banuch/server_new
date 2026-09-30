// Reusable markup helpers. Every value inserted into markup goes through esc().
import { ago, dateTime, shortTime } from './format.js';
import { api } from './api.js';

export const byId = (id) => document.getElementById(id);

export function esc(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
    })[char]);
}

export function icon(name) {
    return `<svg class="i" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

export const STATUS = {
    online: { label: 'Online', icon: 'ok' },
    delayed: { label: 'Delayed', icon: 'clock' },
    offline: { label: 'Offline', icon: 'x' },
    rejected: { label: 'Last packet rejected', icon: 'warn' },
    never: { label: 'No valid data', icon: 'minus' },
};

export function statusBadge(status) {
    const info = STATUS[status] || STATUS.never;
    return `<span class="st ${esc(status)}">${icon(info.icon)}${info.label}</span>`;
}

export function packetBadge(parseStatus) {
    const valid = parseStatus === 'valid';
    return `<span class="st ${valid ? 'valid' : 'invalid'}">${icon(valid ? 'ok' : 'warn')}${valid ? 'Stored' : 'Rejected'}</span>`;
}

// A relative age kept current by the page ticker (see main.js).
export function agoText(value) {
    return value ? `<span data-ago="${esc(new Date(value).toISOString())}">${esc(ago(value))}</span>` : 'never';
}

// "10:15:02" with "22 s ago" underneath.
export function timeCell(value) {
    if (!value) return '—';
    return `<span title="${esc(dateTime(value))}">${esc(shortTime(value))}</span><span class="when">${agoText(value)}</span>`;
}

export function freshnessTag(status) {
    if (status === 'online') return `<span class="tag live">${icon('ok')}LIVE</span>`;
    if (status === 'delayed') return `<span class="tag delayed">${icon('clock')}DELAYED</span>`;
    return `<span class="tag stale">${icon('x')}STALE</span>`;
}

export function stateBox({ kind = 'empty', title, detail = '', retry = false }) {
    const symbol = { empty: 'search', error: 'warn', good: 'ok', info: 'minus' }[kind] || 'search';
    return `<div class="state ${kind}">${icon(symbol)}<strong>${esc(title)}</strong>${detail ? `<span>${esc(detail)}</span>` : ''}${retry ? '<button class="btn small" type="button" data-action="retry">Try again</button>' : ''}</div>`;
}

export function errorBox(error) {
    return stateBox({ kind: 'error', title: 'Data could not be loaded', detail: error.message, retry: true });
}

export function skeletonRows(columns, rows = 5) {
    const cells = '<td><span class="skeleton"></span></td>'.repeat(columns);
    return Array.from({ length: rows }, () => `<tr>${cells}</tr>`).join('');
}

export function emptyRow(columns, title, detail) {
    return `<tr class="empty"><td colspan="${columns}">${stateBox({ title, detail })}</td></tr>`;
}

// Key/value list. Values are text, or { html } for markup built with esc().
// Items whose value is null or undefined are left out.
export function kvList(items, className = '') {
    const rows = items
        .filter(([, value]) => value !== null && value !== undefined)
        .map(([label, value, alert]) => {
            const content = typeof value === 'object' ? value.html : esc(value);
            return `<div><dt>${esc(label)}</dt><dd${alert ? ' class="alert"' : ''}>${content}</dd></div>`;
        });
    return rows.length ? `<dl class="kv ${className}">${rows.join('')}</dl>` : '';
}

export function yesNo(value, yes = 'Yes', no = 'No') {
    if (value === null || value === undefined) return null;
    const truthy = value === true || value === 1 || value === '1';
    return { html: `<span class="pill ${truthy ? 'yes' : 'no'}">${truthy ? yes : no}</span>` };
}

export function signal(csq) {
    if (csq === null || csq === undefined || csq === '') return null;
    const value = Number(csq);
    const [level, text] = value === 99 || value < 0 ? [0, 'Unknown']
        : value >= 20 ? [4, 'Excellent'] : value >= 15 ? [3, 'Good'] : value >= 10 ? [2, 'Fair']
            : value >= 2 ? [1, 'Poor'] : [0, 'No signal'];
    return { html: `<span class="sig l${level}" aria-hidden="true"><i></i><i></i><i></i><i></i></span>${esc(value)} · ${text}` };
}

export function paginationText(pagination, noun = 'records') {
    if (!pagination?.total) return `0 ${noun}`;
    const start = (pagination.page - 1) * pagination.pageSize + 1;
    const end = Math.min(pagination.total, pagination.page * pagination.pageSize);
    return `${start}–${end} of ${Number(pagination.total).toLocaleString('en-IN')} ${noun}`;
}

export function pager(pagination, noun) {
    const page = pagination?.page || 1;
    const pages = pagination?.totalPages || 0;
    return `<span>${esc(paginationText(pagination, noun))}</span><div>
        <button class="btn small" type="button" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>Previous</button>
        <button class="btn small" type="button" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''}>Next</button></div>`;
}

export function toast(message, kind = 'info') {
    const box = document.createElement('div');
    box.className = `toast ${kind}`;
    box.innerHTML = `${icon(kind === 'warn' ? 'warn' : 'ok')}<span>${esc(message)}</span>`;
    byId('toasts').append(box);
    setTimeout(() => box.remove(), 6000);
}

export function debounce(fn, ms) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
}

// Raw JSON viewer shared by the packet ledger and the meter Packets tab.
export async function openPacket(id) {
    const dialog = byId('packetDialog');
    byId('dialogTitle').textContent = `Packet #${id}`;
    byId('packetMeta').innerHTML = '<span class="spinner"></span> Loading…';
    byId('rawPayload').textContent = '';
    dialog.showModal();
    try {
        const packet = await api(`/api/packets/${encodeURIComponent(id)}`);
        byId('packetMeta').innerHTML = `${packetBadge(packet.parse_status)}
            <span>${esc(packet.device_uid || 'Unknown device')}</span>
            <span>Received ${esc(dateTime(packet.received_at))}</span>
            <span>${Number(packet.byte_count).toLocaleString('en-IN')} bytes</span>
            ${packet.parse_error ? `<span>Reason: ${esc(packet.parse_error)}</span>` : ''}`;
        try {
            byId('rawPayload').textContent = JSON.stringify(JSON.parse(packet.raw_payload), null, 2);
        } catch {
            byId('rawPayload').textContent = packet.raw_payload;
        }
    } catch (error) {
        byId('packetMeta').textContent = error.message;
    }
}
