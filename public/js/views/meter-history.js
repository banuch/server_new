// Meter tabs over stored history: load profiles, billing, and events. They
// load when opened or when the operator changes a filter or presses Refresh,
// never on the automatic timer.
import { api, query, devicePath, isAbort, serverNow } from '../api.js';
import { num, int, kilo, withUnit, dateMinute, dateOnly, localInputToIso, isoToLocalInput, present, durationText } from '../format.js';
import { esc, pager, skeletonRows, emptyRow, errorBox, stateBox, agoText } from '../ui.js';

const PAGE_SIZE = 25;
const ALL = -1;
const PHASE_COLORS = ['#c62828', '#b7791f', '#1f5f99'];
const ACCENT = '#1f5f99';

// Runs one tab request at a time; a newer request cancels the older one.
function requestRunner() {
    let controller = null;
    return async (outerSignal, fn) => {
        controller?.abort();
        controller = new AbortController();
        const own = controller;
        outerSignal?.addEventListener('abort', () => own.abort(), { once: true });
        return fn(own.signal);
    };
}

function triple(a, b, c, digits, unit) {
    if (![a, b, c].some(present)) return '—';
    return `<span class="triple"><span><b>R</b>${num(a, digits)}</span><span><b>Y</b>${num(b, digits)}</span><span><b>B</b>${num(c, digits)}</span>${unit ? `<span class="muted">${unit}</span>` : ''}</span>`;
}

function rangeField(id, label, type = 'datetime-local') {
    return `<label class="field">${label}<input id="${id}" type="${type}"></label>`;
}

// ---------------------------------------------------------------- profiles
const PROFILES = {
    block: {
        endpoint: 'block-load',
        label: 'Block load',
        metrics: {
            active_energy_wh: { label: 'Active energy', unit: 'kWh', scale: 1000, digits: 3, bar: true },
            voltage: { label: 'Voltage R/Y/B', unit: 'V', fields: ['voltage_l1_v', 'voltage_l2_v', 'voltage_l3_v'], digits: 1 },
            current: { label: 'Current R/Y/B', unit: 'A', fields: ['current_l1_a', 'current_l2_a', 'current_l3_a'], digits: 2 },
            apparent_energy_vah: { label: 'Apparent energy', unit: 'kVAh', scale: 1000, digits: 3, bar: true },
            reactive_lag_varh: { label: 'Reactive lag', unit: 'kVArh', scale: 1000, digits: 3, bar: true },
            reactive_lead_varh: { label: 'Reactive lead', unit: 'kVArh', scale: 1000, digits: 3, bar: true },
        },
        head: '<th>Time</th><th class="num">Voltage R/Y/B</th><th class="num">Current R/Y/B</th><th class="num">Active</th><th class="num p2">Reactive lag</th><th class="num p2">Reactive lead</th><th class="num">Apparent</th>',
        columns: 7,
        row: (r) => `<td class="full">${esc(dateMinute(r.reading_ts_utc))}</td>
            <td class="num" data-l="Voltage R/Y/B">${triple(r.voltage_l1_v, r.voltage_l2_v, r.voltage_l3_v, 1, 'V')}</td>
            <td class="num" data-l="Current R/Y/B">${triple(r.current_l1_a, r.current_l2_a, r.current_l3_a, 2, 'A')}</td>
            <td class="num" data-l="Active">${esc(withUnit(kilo(r.active_energy_wh, 3), 'kWh'))}</td>
            <td class="num p2" data-l="Reactive lag">${esc(withUnit(kilo(r.reactive_lag_varh, 3), 'kVArh'))}</td>
            <td class="num p2" data-l="Reactive lead">${esc(withUnit(kilo(r.reactive_lead_varh, 3), 'kVArh'))}</td>
            <td class="num" data-l="Apparent">${esc(withUnit(kilo(r.apparent_energy_vah, 3), 'kVAh'))}</td>`,
        time: (value) => dateMinute(value),
    },
    daily: {
        endpoint: 'daily-load',
        label: 'Daily load',
        metrics: {
            active_energy_wh: { label: 'Active energy', unit: 'kWh', scale: 1000, digits: 2, bar: true },
            apparent_energy_vah: { label: 'Apparent energy', unit: 'kVAh', scale: 1000, digits: 2, bar: true },
            reactive_qi_varh: { label: 'Reactive QI', unit: 'kVArh', scale: 1000, digits: 2, bar: true },
            reactive_qiii_varh: { label: 'Reactive QIII', unit: 'kVArh', scale: 1000, digits: 2, bar: true },
            on_minutes: { label: 'Supply on time', unit: 'min', digits: 0, bar: true },
            off_minutes: { label: 'Supply off time', unit: 'min', digits: 0, bar: true },
            missing_minutes: { label: 'Missing time', unit: 'min', digits: 0, bar: true },
        },
        head: '<th>Date</th><th class="num">Active</th><th class="num">Apparent</th><th class="num p2">Reactive QI</th><th class="num p2">Reactive QIII</th><th class="num">On</th><th class="num">Off</th><th class="num p2">Missing</th>',
        columns: 8,
        row: (r) => `<td class="full">${esc(dateOnly(r.reading_ts_utc))}</td>
            <td class="num" data-l="Active">${esc(withUnit(kilo(r.active_energy_wh, 2), 'kWh'))}</td>
            <td class="num" data-l="Apparent">${esc(withUnit(kilo(r.apparent_energy_vah, 2), 'kVAh'))}</td>
            <td class="num p2" data-l="Reactive QI">${esc(withUnit(kilo(r.reactive_qi_varh, 2), 'kVArh'))}</td>
            <td class="num p2" data-l="Reactive QIII">${esc(withUnit(kilo(r.reactive_qiii_varh, 2), 'kVArh'))}</td>
            <td class="num" data-l="On">${esc(withUnit(int(r.on_minutes), 'min'))}</td>
            <td class="num" data-l="Off">${esc(withUnit(int(r.off_minutes), 'min'))}</td>
            <td class="num p2" data-l="Missing">${esc(withUnit(int(r.missing_minutes), 'min'))}</td>`,
        time: (value) => dateOnly(value),
    },
};

export function createProfileTab(deviceId) {
    const state = { type: 'block', hours: 168, page: 1, metric: 'active_energy_wh' };
    let root;
    let chart = null;
    let series = [];
    const run = requestRunner();

    // hours: a trailing window; ALL: no bounds; 0: the custom From/To fields.
    function range() {
        if (state.hours === ALL) return { from: '', to: '' };
        if (state.hours) return { from: new Date(serverNow() - state.hours * 3_600_000).toISOString(), to: '' };
        return { from: localInputToIso(root.querySelector('#pFrom').value), to: localInputToIso(root.querySelector('#pTo').value) };
    }

    function setControls() {
        const config = PROFILES[state.type];
        root.querySelectorAll('[data-profile]').forEach((button) => button.classList.toggle('active', button.dataset.profile === state.type));
        root.querySelectorAll('[data-hours]').forEach((button) => button.classList.toggle('active', Number(button.dataset.hours) === state.hours));
        if (!config.metrics[state.metric]) state.metric = Object.keys(config.metrics)[0];
        root.querySelector('#pMetric').innerHTML = Object.entries(config.metrics)
            .map(([key, metric]) => `<option value="${key}">${esc(metric.label)} (${esc(metric.unit)})</option>`).join('');
        root.querySelector('#pMetric').value = state.metric;
        root.querySelector('thead').innerHTML = `<tr>${config.head}</tr>`;
    }

    function renderChart() {
        const config = PROFILES[state.type];
        const metric = config.metrics[state.metric];
        const fields = metric.fields || [state.metric];
        const box = root.querySelector('.chart-box');
        chart?.destroy();
        chart = null;
        if (series.length === 0) {
            box.innerHTML = stateBox({ title: 'No profile readings in this range', detail: 'Choose a wider range (All shows every stored reading) or the other profile.' });
            return;
        }
        box.innerHTML = '<canvas aria-label="Load profile chart" role="img"></canvas>';
        if (!window.Chart) {
            box.innerHTML = stateBox({ kind: 'error', title: 'Chart library did not load' });
            return;
        }
        const value = (row, field) => (present(row[field]) ? Number(row[field]) / (metric.scale || 1) : null);
        chart = new window.Chart(box.querySelector('canvas'), {
            type: metric.bar ? 'bar' : 'line',
            data: {
                labels: series.map((row) => config.time(row.reading_ts_utc)),
                datasets: fields.map((field, index) => ({
                    label: fields.length > 1 ? `${'RYB'[index]} phase (${metric.unit})` : `${metric.label} (${metric.unit})`,
                    data: series.map((row) => value(row, field)),
                    borderColor: fields.length > 1 ? PHASE_COLORS[index] : ACCENT,
                    backgroundColor: fields.length > 1 ? PHASE_COLORS[index] : (metric.bar ? 'rgba(31,95,153,.75)' : 'rgba(31,95,153,.08)'),
                    fill: !metric.bar && fields.length === 1,
                    borderWidth: metric.bar ? 0 : 2,
                    tension: 0.2,
                    pointRadius: series.length > 60 ? 0 : 2,
                    spanGaps: false,
                })),
            },
            options: {
                responsive: true, maintainAspectRatio: false, animation: false,
                interaction: { intersect: false, mode: 'index' },
                scales: {
                    x: { ticks: { maxTicksLimit: 8, color: '#5f6b7a' }, grid: { display: false } },
                    y: { ticks: { color: '#5f6b7a' }, grid: { color: '#eceff3' }, title: { display: true, text: metric.unit, color: '#5f6b7a' } },
                },
                plugins: {
                    legend: { align: 'end', labels: { boxWidth: 10, boxHeight: 10, color: '#1b2430' } },
                    tooltip: {
                        callbacks: { label: (item) => `${item.dataset.label}: ${num(item.raw, metric.digits)}` },
                    },
                },
            },
        });
    }

    async function load(signal, { chartToo = true } = {}) {
        const config = PROFILES[state.type];
        const wrap = root.querySelector('.tscroll');
        const body = root.querySelector('tbody');
        const { from, to } = range();
        if (from && to && from > to) {
            body.innerHTML = emptyRow(config.columns, 'The start of the range is after its end');
            return;
        }
        if (!body.children.length) body.innerHTML = skeletonRows(config.columns);
        wrap.classList.add('loading');
        try {
            await run(signal, async (own) => {
                const base = devicePath(deviceId, `/${config.endpoint}`);
                const [page, chartData] = await Promise.all([
                    api(`${base}${query({ from, to, page: state.page, pageSize: PAGE_SIZE })}`, { signal: own }),
                    chartToo ? api(`${base}/series${query({ from, to })}`, { signal: own }) : null,
                ]);
                if (chartData) {
                    series = chartData.rows;
                    const note = root.querySelector('.chart-note');
                    note.classList.toggle('hidden', !chartData.truncated);
                    note.textContent = `Showing the newest ${chartData.limit.toLocaleString('en-IN')} points of this range. Narrow the range to see older readings.`;
                    renderChart();
                }
                body.innerHTML = page.rows.length
                    ? page.rows.map((row) => `<tr>${config.row(row)}</tr>`).join('')
                    : emptyRow(config.columns, 'No profile readings in this range');
                root.querySelector('.pager').innerHTML = pager(page.pagination, 'entries');
            });
        } catch (error) {
            if (isAbort(error)) return;
            body.innerHTML = `<tr><td colspan="${config.columns}">${errorBox(error)}</td></tr>`;
        } finally {
            wrap.classList.remove('loading');
        }
    }

    return {
        mount(element) {
            root = element;
            root.innerHTML = `<section class="panel">
                <div class="toolbar">
                    <div class="segmented" role="group" aria-label="Profile">${Object.entries(PROFILES).map(([key, profile]) => `<button type="button" data-profile="${key}">${profile.label}</button>`).join('')}</div>
                    <div class="chips" role="group" aria-label="Range"><button class="chip" type="button" data-hours="24">24 h</button><button class="chip" type="button" data-hours="168">7 days</button><button class="chip" type="button" data-hours="720">30 days</button><button class="chip" type="button" data-hours="${ALL}">All</button><button class="chip" type="button" data-hours="0">Custom</button></div>
                    ${rangeField('pFrom', 'From')}${rangeField('pTo', 'To')}
                    <button class="btn primary" type="button" id="pApply">Apply</button>
                    <span class="spacer"></span>
                    <label class="field">Chart<select id="pMetric"></select></label>
                </div>
                <div class="chart-box"></div><div class="chart-note hidden"></div>
                <div class="tscroll"><table class="cards"><thead></thead><tbody></tbody></table></div>
                <div class="pager"></div>
            </section>`;
            setControls();
            const toCustom = () => { state.hours = 0; setControls(); };
            root.querySelector('#pFrom').addEventListener('input', toCustom);
            root.querySelector('#pTo').addEventListener('input', toCustom);
            root.querySelector('#pMetric').addEventListener('change', (event) => { state.metric = event.target.value; renderChart(); });
            root.addEventListener('click', (event) => {
                const profile = event.target.closest('[data-profile]');
                const hours = event.target.closest('[data-hours]');
                const page = event.target.closest('[data-page]');
                if (profile) {
                    state.type = profile.dataset.profile;
                    state.page = 1;
                    root.querySelector('tbody').innerHTML = '';
                    setControls();
                    load();
                } else if (hours) {
                    state.hours = Number(hours.dataset.hours);
                    state.page = 1;
                    if (state.hours) {
                        root.querySelector('#pFrom').value = state.hours === ALL ? '' : isoToLocalInput(new Date(serverNow() - state.hours * 3_600_000));
                        root.querySelector('#pTo').value = '';
                    }
                    setControls();
                    if (state.hours) load();
                } else if (event.target.closest('#pApply')) {
                    state.page = 1;
                    load();
                } else if (page && !page.disabled) {
                    state.page = Number(page.dataset.page);
                    load(undefined, { chartToo: false });
                } else if (event.target.closest('[data-action=retry]')) {
                    load();
                }
            });
            root.querySelector('#pFrom').value = isoToLocalInput(new Date(serverNow() - state.hours * 3_600_000));
        },
        load: (signal) => load(signal),
        destroy() { chart?.destroy(); },
    };
}

// ----------------------------------------------------------------- billing
export function createBillingTab(deviceId) {
    let root;
    let page = 1;
    const run = requestRunner();
    const COLUMNS = 9;

    function param(label, value, unit) {
        return value === '—' ? '' : `<dl class="param"><dt>${esc(label)}</dt><dd>${esc(value)}<small>${esc(unit)}</small></dd></dl>`;
    }

    async function load(signal) {
        const wrap = root.querySelector('.tscroll');
        const body = root.querySelector('tbody');
        const from = root.querySelector('#bFrom').value;
        const to = root.querySelector('#bTo').value;
        const range = {
            from: from ? localInputToIso(`${from}T00:00`) : '',
            to: to ? new Date(new Date(localInputToIso(`${to}T23:59`)).getTime() + 59_999).toISOString() : '',
        };
        if (!body.children.length) body.innerHTML = skeletonRows(COLUMNS);
        wrap.classList.add('loading');
        try {
            await run(signal, async (own) => {
                const data = await api(`${devicePath(deviceId, '/billing')}${query({ ...range, page, pageSize: PAGE_SIZE })}`, { signal: own });
                const current = data.current;
                const params = current ? [
                    param('Active import', kilo(current.active_import_wh, 2), 'kWh'),
                    param('Apparent import', kilo(current.apparent_import_vah, 2), 'kVAh'),
                    param('Reactive lag (QI)', kilo(current.reactive_qi_lag_varh, 2), 'kVArh'),
                    param('Reactive lead (QIII)', kilo(current.reactive_qiii_lead_varh, 2), 'kVArh'),
                    param('System power factor', num(current.system_power_factor, 3), ''),
                    param('Power-on duration', present(current.cumulative_duration_minutes) ? int(current.cumulative_duration_minutes) : '—', 'min'),
                ].join('') : '';
                root.querySelector('#billingCurrent').innerHTML = params
                    ? `<div class="captured">Snapshot taken ${esc(dateMinute(current.billing_ts_utc))} · ${agoText(current.billing_ts_utc)}</div><div class="params">${params}</div>`
                    : stateBox({ title: 'No current billing snapshot', detail: 'Billing values arrive with full packets from the device.' });
                body.innerHTML = data.history.length ? data.history.map((row) => `<tr>
                    <td class="full"><b>Cycle ${esc(row.billing_cycle_number)}</b> · ${esc(dateOnly(row.billing_date_utc))}</td>
                    <td class="num" data-l="Active">${esc(withUnit(kilo(row.active_import_wh, 2), 'kWh'))}</td>
                    <td class="num" data-l="Apparent">${esc(withUnit(kilo(row.apparent_import_vah, 2), 'kVAh'))}</td>
                    <td class="num p2" data-l="Reactive QI">${esc(withUnit(kilo(row.reactive_qi_varh, 2), 'kVArh'))}</td>
                    <td class="num p2" data-l="Reactive QIII">${esc(withUnit(kilo(row.reactive_qiii_varh, 2), 'kVArh'))}</td>
                    <td class="num" data-l="Power factor">${esc(num(row.system_power_factor, 3))}</td>
                    <td class="num" data-l="Max demand">${esc(withUnit(kilo(row.max_demand_w, 3), 'kW'))}</td>
                    <td class="num p2" data-l="Max apparent demand">${esc(withUnit(kilo(row.max_apparent_demand_va, 3), 'kVA'))}</td>
                    <td class="num p3" data-l="Power-on duration">${present(row.cumulative_duration_minutes) ? esc(durationText(Number(row.cumulative_duration_minutes) * 60)) : '—'}</td>
                </tr>`).join('') : emptyRow(COLUMNS, 'No billing history in this period');
                root.querySelector('.pager').innerHTML = pager(data.pagination, 'billing cycles');
            });
        } catch (error) {
            if (isAbort(error)) return;
            body.innerHTML = `<tr><td colspan="${COLUMNS}">${errorBox(error)}</td></tr>`;
        } finally {
            wrap.classList.remove('loading');
        }
    }

    return {
        mount(element) {
            root = element;
            root.innerHTML = `<h2 class="section">Current billing period</h2><div id="billingCurrent"><span class="skeleton block"></span></div>
                <h2 class="section">Billing history</h2>
                <section class="panel">
                    <div class="toolbar">${rangeField('bFrom', 'From', 'date')}${rangeField('bTo', 'To', 'date')}<button class="btn primary" type="button" id="bApply">Apply</button></div>
                    <div class="tscroll"><table class="cards"><thead><tr><th>Billing cycle</th><th class="num">Active</th><th class="num">Apparent</th><th class="num p2">Reactive QI</th><th class="num p2">Reactive QIII</th><th class="num">PF</th><th class="num">Max demand</th><th class="num p2">Max apparent</th><th class="num p3">Power-on</th></tr></thead><tbody></tbody></table></div>
                    <div class="pager"></div>
                </section>`;
            root.addEventListener('click', (event) => {
                const target = event.target.closest('[data-page]');
                if (event.target.closest('#bApply')) { page = 1; load(); }
                else if (target && !target.disabled) { page = Number(target.dataset.page); load(); }
                else if (event.target.closest('[data-action=retry]')) load();
            });
        },
        load: (signal) => load(signal),
    };
}

// ------------------------------------------------------------------ events
const CATEGORIES = [
    ['', 'All', ''],
    ['Voltage related', 'Voltage', 'cat-voltage'],
    ['Current related', 'Current', 'cat-current'],
    ['Power failure related', 'Power failure', 'cat-power'],
    ['Transaction related', 'Transaction', 'cat-transaction'],
    ['Other events', 'Other', 'cat-other'],
    ['Non-rollover events', 'Non-rollover', 'cat-non-rollover'],
    ['Control events', 'Control', 'cat-control'],
];
const CATEGORY_CLASS = Object.fromEntries(CATEGORIES.map(([value, , css]) => [value, css]));

// Occurrence and restoration come from the meter's own event descriptions.
function eventType(description) {
    const text = String(description || '').toLowerCase();
    if (text.endsWith('- occurrence')) return '<span class="ev-type occ">Occurrence</span>';
    if (text.endsWith('- restoration')) return '<span class="ev-type res">Restoration</span>';
    return '<span class="muted">—</span>';
}

export function createEventsTab(deviceId) {
    let root;
    let page = 1;
    let category = '';
    let logsLoaded = false;
    const run = requestRunner();
    const COLUMNS = 8;

    async function loadLogs(signal) {
        if (logsLoaded) return;
        const { logs } = await api(devicePath(deviceId, '/event-logs'), { signal });
        const select = root.querySelector('#eLog');
        select.innerHTML = `<option value="">All logs</option>${logs.map((log) => `<option value="${esc(log)}">${esc(log)}</option>`).join('')}`;
        logsLoaded = true;
    }

    async function load(signal) {
        const wrap = root.querySelector('.tscroll');
        const body = root.querySelector('tbody');
        if (!body.children.length) body.innerHTML = skeletonRows(COLUMNS);
        wrap.classList.add('loading');
        try {
            await run(signal, async (own) => {
                await loadLogs(own);
                const data = await api(`${devicePath(deviceId, '/events')}${query({
                    page, pageSize: PAGE_SIZE, eventCategory: category,
                    eventLog: root.querySelector('#eLog').value,
                    eventCode: root.querySelector('#eCode').value.trim(),
                    from: localInputToIso(root.querySelector('#eFrom').value),
                    to: localInputToIso(root.querySelector('#eTo').value),
                })}`, { signal: own });
                body.innerHTML = data.rows.length ? data.rows.map((row) => `<tr class="event ${CATEGORY_CLASS[row.event_category] || ''}">
                    <td data-l="Time">${esc(dateMinute(row.event_ts_utc))}</td>
                    <td class="full"><div class="event-name"><strong>${esc(row.event_code)} · ${esc(row.event_description || 'Code not in the event table')}</strong><small>${esc(row.event_category || 'Unknown category')}</small></div></td>
                    <td data-l="Type">${eventType(row.event_description)}</td>
                    <td class="p3" data-l="Log">${esc(row.event_log_key)}</td>
                    <td class="num" data-l="Voltage R/Y/B">${triple(row.voltage_l1_v, row.voltage_l2_v, row.voltage_l3_v, 1, 'V')}</td>
                    <td class="num p2" data-l="Current R/Y/B">${triple(row.current_l1_a, row.current_l2_a, row.current_l3_a, 2, 'A')}</td>
                    <td class="num p3" data-l="PF R/Y/B">${triple(row.power_factor_l1, row.power_factor_l2, row.power_factor_l3, 3, '')}</td>
                    <td class="num p2" data-l="Active energy">${esc(withUnit(kilo(row.active_import_wh, 2), 'kWh'))}</td>
                </tr>`).join('') : emptyRow(COLUMNS, 'No events match these filters');
                root.querySelector('.pager').innerHTML = pager(data.pagination, 'events');
            });
        } catch (error) {
            if (isAbort(error)) return;
            body.innerHTML = `<tr><td colspan="${COLUMNS}">${errorBox(error)}</td></tr>`;
        } finally {
            wrap.classList.remove('loading');
        }
    }

    return {
        mount(element) {
            root = element;
            root.innerHTML = `<section class="panel">
                <div class="toolbar"><div class="chips" role="group" aria-label="Event category">${CATEGORIES.map(([value, label, css]) => `<button class="chip ${css}${value === category ? ' active' : ''}" type="button" data-category="${esc(value)}">${css ? '<span class="dot"></span>' : ''}${label}</button>`).join('')}</div></div>
                <div class="toolbar">
                    <label class="field">Event log<select id="eLog"><option value="">All logs</option></select></label>
                    <label class="field">Event code<input id="eCode" type="number" placeholder="Any" style="width:90px"></label>
                    ${rangeField('eFrom', 'From')}${rangeField('eTo', 'To')}
                    <button class="btn primary" type="button" id="eApply">Apply</button>
                    <button class="btn" type="button" id="eClear">Clear</button>
                </div>
                <div class="tscroll"><table class="cards"><thead><tr><th>Time</th><th>Event</th><th>Type</th><th class="p3">Log</th><th class="num">Voltage R/Y/B</th><th class="num p2">Current R/Y/B</th><th class="num p3">PF R/Y/B</th><th class="num p2">Active energy</th></tr></thead><tbody></tbody></table></div>
                <div class="pager"></div>
            </section>`;
            root.addEventListener('click', (event) => {
                const chip = event.target.closest('[data-category]');
                const target = event.target.closest('[data-page]');
                if (chip) {
                    category = chip.dataset.category;
                    root.querySelectorAll('[data-category]').forEach((item) => item.classList.toggle('active', item === chip));
                    page = 1;
                    load();
                } else if (event.target.closest('#eApply')) { page = 1; load(); }
                else if (event.target.closest('#eClear')) {
                    ['#eLog', '#eCode', '#eFrom', '#eTo'].forEach((selector) => { root.querySelector(selector).value = ''; });
                    page = 1;
                    load();
                } else if (target && !target.disabled) { page = Number(target.dataset.page); load(); }
                else if (event.target.closest('[data-action=retry]')) load();
            });
        },
        load: (signal) => load(signal),
    };
}
