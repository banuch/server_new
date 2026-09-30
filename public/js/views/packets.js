// Packet ledger: every received packet, stored or rejected, with its raw JSON.
// The same table is used for one meter on the meter Packets tab.
import { api, query, isAbort } from '../api.js';
import { num, kilo, withUnit, localInputToIso } from '../format.js';
import { esc, packetBadge, timeCell, pager, skeletonRows, emptyRow, errorBox, debounce, openPacket } from '../ui.js';

const PAGE_SIZE = 25;
const REFRESH_MS = 30_000;

export function createPacketTable({ deviceId = '', status = '', search = '' } = {}) {
    let root;
    let page = 1;
    let controller = null;
    let loaded = false;
    const columns = 8;

    function filters() {
        return {
            deviceId,
            search: root.querySelector('#kSearch').value.trim(),
            status: root.querySelector('#kStatus').value,
            meterSerial: deviceId ? '' : root.querySelector('#kMeter').value.trim(),
            from: localInputToIso(root.querySelector('#kFrom').value),
            to: localInputToIso(root.querySelector('#kTo').value),
        };
    }

    async function load(signal) {
        controller?.abort();
        controller = new AbortController();
        const own = controller;
        signal?.addEventListener('abort', () => own.abort(), { once: true });
        const wrap = root.querySelector('.tscroll');
        const body = root.querySelector('tbody');
        if (!body.children.length) body.innerHTML = skeletonRows(columns);
        wrap.classList.add('loading');
        try {
            const data = await api(`/api/packets${query({ ...filters(), page, pageSize: PAGE_SIZE })}`, { signal: own.signal });
            if (data.pagination.totalPages && page > data.pagination.totalPages) {
                page = data.pagination.totalPages;
                return load(signal);
            }
            body.innerHTML = data.rows.length ? data.rows.map((packet) => `<tr>
                <td class="full"><b>#${esc(packet.id)}</b>${deviceId ? '' : ` · <a class="link" href="#/meters/${encodeURIComponent(packet.device_uid || '')}">${esc(packet.meter_serial || packet.device_uid || 'unknown')}</a>`}</td>
                <td data-l="Status">${packetBadge(packet.parse_status)}${packet.parse_error ? `<span class="issue-text">${esc(packet.parse_error)}</span>` : ''}</td>
                <td data-l="Received">${timeCell(packet.received_at)}</td>
                <td class="p2" data-l="Cycle">${packet.device_cycle_number == null ? '—' : `#${esc(packet.device_cycle_number)} · ${esc(packet.mode || '—')}`}</td>
                <td class="num p2" data-l="Energy">${esc(withUnit(kilo(packet.active_import_wh, 2), 'kWh'))}</td>
                <td class="p3" data-l="Client IP">${esc(packet.client_ip || '—')}</td>
                <td class="num" data-l="Size">${esc(num(Number(packet.byte_count) / 1024, 1))} KB</td>
                <td><button class="btn small" type="button" data-packet="${esc(packet.id)}">View JSON</button></td>
            </tr>`).join('') : emptyRow(columns, 'No packets match these filters');
            root.querySelector('.pager').innerHTML = pager(data.pagination, 'packets');
            loaded = true;
        } catch (error) {
            if (isAbort(error)) throw error;
            if (loaded) throw error;
            body.innerHTML = `<tr><td colspan="${columns}">${errorBox(error)}</td></tr>`;
            throw error;
        } finally {
            wrap.classList.remove('loading');
        }
    }

    const reload = () => load().catch(() => {});

    return {
        mount(element) {
            root = element;
            root.innerHTML = `<div class="toolbar">
                    <div class="grow"><label class="field">Search<input id="kSearch" type="search" placeholder="Packet no., device, serial, IP, error"></label></div>
                    <label class="field">Status<select id="kStatus"><option value="">All</option><option value="valid">Stored</option><option value="invalid">Rejected</option></select></label>
                    ${deviceId ? '' : '<label class="field">Meter serial<input id="kMeter" type="text" placeholder="Any" style="width:130px"></label>'}
                    <label class="field">From<input id="kFrom" type="datetime-local"></label>
                    <label class="field">To<input id="kTo" type="datetime-local"></label>
                    <button class="btn" type="button" id="kClear">Clear</button>
                    <span class="spacer"></span>
                    <span id="kExtra"></span>
                </div>
                <div class="tscroll"><table class="cards"><thead><tr>
                    <th>Packet</th><th>Status</th><th>Received</th><th class="p2">Cycle</th><th class="num p2">Energy</th><th class="p3">Client IP</th><th class="num">Size</th><th></th>
                </tr></thead><tbody></tbody></table></div>
                <div class="pager"></div>`;
            root.querySelector('#kStatus').value = status;
            root.querySelector('#kSearch').value = search;
            const onFilter = debounce(() => { page = 1; reload(); }, 300);
            root.querySelectorAll('input, select').forEach((input) => {
                input.addEventListener(input.type === 'search' || input.type === 'text' ? 'input' : 'change', onFilter);
            });
            root.querySelector('#kClear').addEventListener('click', () => {
                root.querySelectorAll('.toolbar input:not([type=checkbox]), .toolbar select').forEach((input) => { input.value = ''; });
                page = 1;
                reload();
            });
            root.addEventListener('click', (event) => {
                const packet = event.target.closest('[data-packet]');
                const target = event.target.closest('[data-page]');
                if (packet) openPacket(packet.dataset.packet);
                else if (target && !target.disabled) { page = Number(target.dataset.page); reload(); }
                else if (event.target.closest('[data-action=retry]')) reload();
            });
        },
        load,
        hasData: () => loaded,
        extraSlot: () => root.querySelector('#kExtra'),
    };
}

export function createPacketsView(route, context) {
    let auto = true;
    const table = createPacketTable({ status: route.params.get('status') || '', search: route.params.get('search') || '' });

    return {
        mount(element) {
            context.setCrumb('Packet ledger');
            element.innerHTML = '<section class="panel"><div class="panel-head"><h3>All received packets</h3><span class="note">Stored and rejected packets from every device, newest first</span></div><div id="ledger"></div></section>';
            table.mount(element.querySelector('#ledger'));
            table.extraSlot().innerHTML = '<label class="switch"><input id="kAuto" type="checkbox" checked> Refresh every 30 s</label>';
            element.querySelector('#kAuto').addEventListener('change', (event) => {
                auto = event.target.checked;
                context.reload('filter');
            });
        },
        load: (signal) => table.load(signal),
        refreshMs: () => (auto ? REFRESH_MS : null),
        hasData: () => table.hasData(),
        showError() {
            // The table shows its own error state.
        },
    };
}
