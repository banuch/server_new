// Meter list with latest values, communication status, filters, and sorting.
import { api, query } from '../api.js';
import { num, kilo, withUnit, average, present } from '../format.js';
import { esc, icon, statusBadge, timeCell, signal, pager, skeletonRows, emptyRow, errorBox, debounce, STATUS } from '../ui.js';

const REFRESH_MS = 30_000;
const PAGE_SIZE = 25;
const COLUMNS = 9;
const SORTABLE = { meter: 'Meter', status: 'Status', last: 'Last packet', power: 'Active power', energy: 'Energy import', manufacturer: 'Manufacturer' };
// Default direction when a column is first clicked: most useful first.
const FIRST_DIRECTION = { meter: 'asc', status: 'asc', last: 'desc', power: 'desc', energy: 'desc', manufacturer: 'asc' };

// Filter state survives navigating to a meter and back.
const state = { search: '', status: '', manufacturer: '', sort: 'status', dir: 'asc', page: 1 };

function applyRoute(route) {
    const search = route.params.get('search');
    const status = route.params.get('status');
    if (search === null && status === null) return false;
    state.search = search || '';
    state.status = STATUS[status] ? status : '';
    state.page = 1;
    return true;
}

export function createMetersView(route, context) {
    let root;
    let data = null;
    applyRoute(route);

    function voltageText(row) {
        const values = [row.voltage_l1_v, row.voltage_l2_v, row.voltage_l3_v];
        return values.some(present) ? `${values.map((value) => num(value, 1)).join(' / ')} V` : '—';
    }

    function renderChips() {
        const { counts } = data;
        const chip = (value, label, count, symbol, color) => `<button class="chip${state.status === value ? ' active' : ''}" type="button" data-status="${value}" aria-pressed="${state.status === value}">
            ${symbol ? `<span style="color:${color}">${icon(symbol)}</span>` : ''}${label} <b>${count}</b></button>`;
        root.querySelector('#statusChips').innerHTML = [
            chip('', 'All', counts.total),
            chip('online', 'Online', counts.online, 'ok', 'var(--ok)'),
            chip('delayed', 'Delayed', counts.delayed, 'clock', 'var(--warn)'),
            chip('offline', 'Offline', counts.offline, 'x', 'var(--bad)'),
            counts.rejected || state.status === 'rejected' ? chip('rejected', 'Rejected', counts.rejected, 'warn', 'var(--bad)') : '',
            counts.never || state.status === 'never' ? chip('never', 'No valid data', counts.never, 'minus', 'var(--off)') : '',
        ].join('');

        const select = root.querySelector('#manufacturer');
        select.innerHTML = `<option value="">All manufacturers</option>${data.manufacturers
            .map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join('')}`;
        select.value = state.manufacturer;
    }

    function renderHead() {
        const th = (key, extra = '') => {
            const sorted = state.sort === key ? ` aria-sort="${state.dir === 'asc' ? 'ascending' : 'descending'}"` : '';
            return `<th class="sort ${extra}" data-sort="${key}" tabindex="0"${sorted}>${SORTABLE[key]}</th>`;
        };
        root.querySelector('thead').innerHTML = `<tr>${th('meter')}${th('status')}${th('last')}
            <th class="num">Voltage R/Y/B</th><th class="num p2">Current (avg)</th>${th('power', 'num')}
            ${th('energy', 'num p2')}${th('manufacturer', 'p3')}<th class="p3">Signal</th></tr>`;
    }

    function renderRows() {
        const body = root.querySelector('tbody');
        if (data.counts.total === 0) {
            body.innerHTML = emptyRow(COLUMNS, 'No meters have reported yet', 'A meter appears here after the server stores its first valid packet.');
        } else if (data.rows.length === 0) {
            body.innerHTML = emptyRow(COLUMNS, 'No meters match these filters', 'Clear the search or choose another status.');
        } else {
            body.innerHTML = data.rows.map((row) => {
                const stale = row.status === 'offline' || row.status === 'never';
                const current = average([row.current_l1_a, row.current_l2_a, row.current_l3_a]);
                const sig = signal(row.csq);
                return `<tr class="${stale ? 'stale' : ''}">
                    <td class="full"><a class="link" href="#/meters/${encodeURIComponent(row.device_uid)}">${esc(row.meter_serial || row.device_uid)}</a><span class="sub">${esc(row.device_uid)}</span></td>
                    <td data-l="Status">${statusBadge(row.status)}</td>
                    <td data-l="Last packet">${timeCell(row.last_received_at)}</td>
                    <td class="num val" data-l="Voltage R/Y/B">${esc(voltageText(row))}</td>
                    <td class="num val p2" data-l="Current (avg)">${esc(withUnit(num(current, 2), 'A'))}</td>
                    <td class="num val" data-l="Active power">${esc(withUnit(kilo(row.active_import_w, 3), 'kW'))}</td>
                    <td class="num val p2" data-l="Energy import">${esc(withUnit(kilo(row.active_import_wh, 2), 'kWh'))}</td>
                    <td class="p3" data-l="Manufacturer">${esc(row.manufacturer || '—')}</td>
                    <td class="p3 hide-m">${sig ? sig.html : '—'}</td>
                </tr>`;
            }).join('');
        }
        root.querySelector('.pager').innerHTML = pager(data.pagination, 'meters')
            .replace('</span>', ' · offline values shown greyed</span>');
    }

    const reload = () => context.reload('filter');
    const onSearch = debounce(() => {
        state.search = root.querySelector('#meterSearch').value.trim();
        state.page = 1;
        reload();
    }, 300);

    function sortBy(key) {
        if (state.sort === key) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
        else {
            state.sort = key;
            state.dir = FIRST_DIRECTION[key];
        }
        state.page = 1;
        renderHead();
        reload();
    }

    return {
        mount(element) {
            root = element;
            context.setCrumb('Meters');
            root.innerHTML = `<section class="panel">
                <div class="toolbar">
                    <div class="grow"><input id="meterSearch" type="search" placeholder="Search serial, device ID, manufacturer, firmware, IP" aria-label="Search meters"></div>
                    <div class="chips" id="statusChips" role="group" aria-label="Status filter"></div>
                    <select id="manufacturer" aria-label="Manufacturer"><option value="">All manufacturers</option></select>
                </div>
                <div class="tscroll"><table class="cards"><thead></thead><tbody>${skeletonRows(COLUMNS)}</tbody></table></div>
                <div class="pager"></div>
            </section>`;
            root.querySelector('#meterSearch').value = state.search;
            renderHead();

            root.querySelector('#meterSearch').addEventListener('input', onSearch);
            root.querySelector('#manufacturer').addEventListener('change', (event) => {
                state.manufacturer = event.target.value;
                state.page = 1;
                reload();
            });
            root.addEventListener('click', (event) => {
                const chip = event.target.closest('[data-status]');
                if (chip) {
                    state.status = chip.dataset.status;
                    state.page = 1;
                    reload();
                    return;
                }
                const header = event.target.closest('th[data-sort]');
                if (header) return sortBy(header.dataset.sort);
                const page = event.target.closest('[data-page]');
                if (page && !page.disabled) {
                    state.page = Number(page.dataset.page);
                    reload();
                    return;
                }
                if (event.target.closest('[data-action=retry]')) reload();
            });
            root.addEventListener('keydown', (event) => {
                const header = event.target.closest('th[data-sort]');
                if (header && (event.key === 'Enter' || event.key === ' ')) {
                    event.preventDefault();
                    sortBy(header.dataset.sort);
                }
            });
        },
        update(next) {
            if (!applyRoute(next)) return false;
            root.querySelector('#meterSearch').value = state.search;
            return true;
        },
        async load(signal) {
            const table = root.querySelector('.tscroll');
            table.classList.add('loading');
            try {
                data = await api(`/api/meters${query({ ...state, pageSize: PAGE_SIZE })}`, { signal });
            } finally {
                table.classList.remove('loading');
            }
            context.setAlertCount(data.counts);
            if (data.pagination.totalPages && state.page > data.pagination.totalPages) {
                state.page = data.pagination.totalPages;
                return this.load(signal);
            }
            renderChips();
            renderRows();
        },
        refreshMs: () => REFRESH_MS,
        hasData: () => Boolean(data),
        showError(error) {
            root.querySelector('tbody').innerHTML = `<tr><td colspan="${COLUMNS}">${errorBox(error)}</td></tr>`;
        },
    };
}
