'use strict';

const state = {
    view: 'overview', deviceId: '', profileType: 'block', profileChart: null,
    profilePage: 1, profilePages: 0, billingPage: 1, billingPages: 0,
    eventPage: 1, eventPages: 0, packetPage: 1, packetPages: 0, refreshTimer: null,
};
const byId = (id) => document.getElementById(id);

const profileConfig = {
    block: {
        endpoint: 'block-load',
        metrics: {
            active_energy_wh: ['Active energy', 'Wh'], voltage_l1_v: ['Voltage L1', 'V'],
            current_l1_a: ['Current L1', 'A'], apparent_energy_vah: ['Apparent energy', 'VAh'],
            reactive_lag_varh: ['Reactive lag', 'varh'], reactive_lead_varh: ['Reactive lead', 'varh'],
        },
        headers: ['Time', 'Current L1/L2/L3', 'Voltage L1/L2/L3', 'Active', 'Reactive lag', 'Reactive lead', 'Apparent'],
    },
    daily: {
        endpoint: 'daily-load',
        metrics: {
            active_energy_wh: ['Active energy', 'Wh'], apparent_energy_vah: ['Apparent energy', 'VAh'],
            reactive_qi_varh: ['Reactive QI', 'varh'], reactive_qiii_varh: ['Reactive QIII', 'varh'],
            on_minutes: ['On time', 'min'], off_minutes: ['Off time', 'min'], missing_minutes: ['Missing time', 'min'],
        },
        headers: ['Date', 'Active', 'Reactive QI', 'Reactive QIII', 'Apparent', 'On', 'Off', 'Missing'],
    },
};

async function api(path) {
    const response = await fetch(path, { headers: { Accept: 'application/json' } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
    return body;
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
    })[char]);
}

function queryString(values) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) {
        if (value !== '' && value !== null && value !== undefined) params.set(key, value);
    }
    return params.toString();
}

function formatDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium', hour12: false }).format(date);
}

function relativeTime(value) {
    if (!value) return 'No communication';
    const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
}

function number(value, digits = 2) {
    if (value === null || value === undefined || value === '') return '—';
    return Number(value).toLocaleString(undefined, { maximumFractionDigits: digits });
}

function scaled(value, divisor = 1000, digits = 3) {
    return value === null || value === undefined || value === '' ? '—' : number(Number(value) / divisor, digits);
}

function dateInputRange(fromId, toId) {
    const from = byId(fromId).value;
    const to = byId(toId).value;
    return {
        from: from ? new Date(`${from}T00:00:00`).toISOString() : '',
        to: to ? new Date(`${to}T23:59:59.999`).toISOString() : '',
    };
}

function inputIso(id) {
    const value = byId(id).value;
    return value ? new Date(value).toISOString() : '';
}

function showError(error) {
    byId('notice').textContent = error.message;
    byId('notice').classList.remove('hidden');
}

function clearError() { byId('notice').classList.add('hidden'); }

function details(items) {
    return items.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value ?? '—')}</dd></div>`).join('');
}

function metric(label, value, unit = '', note = '') {
    return `<article class="metric-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}${unit ? ` <small>${escapeHtml(unit)}</small>` : ''}</strong>${note ? `<small>${escapeHtml(note)}</small>` : ''}</article>`;
}

function phaseMetric(label, content, note) {
    return `<article class="metric-card"><span>${escapeHtml(label)}</span><strong>${content}</strong><small>${escapeHtml(note)}</small></article>`;
}

function triple(a, b, c, digits = 2, unit = '') {
    return `<span class="triple"><span><b>L1</b> ${number(a, digits)}</span><span><b>L2</b> ${number(b, digits)}</span><span><b>L3</b> ${number(c, digits)}</span>${unit ? `<span>${escapeHtml(unit)}</span>` : ''}</span>`;
}

function paginationText(pagination) {
    if (!pagination.total) return '0 records';
    const start = (pagination.page - 1) * pagination.pageSize + 1;
    const end = Math.min(pagination.total, pagination.page * pagination.pageSize);
    return `${start}–${end} of ${Number(pagination.total).toLocaleString()}`;
}

async function loadSystemSummary() {
    const summary = await api('/api/summary');
    byId('packetsToday').textContent = Number(summary.total_packets_today || 0).toLocaleString();
    byId('activeDevices').textContent = Number(summary.active_devices_last_hour || 0).toLocaleString();
}

async function loadDevices() {
    const { devices } = await api('/api/devices');
    const select = byId('activeDevice');
    select.insertAdjacentHTML('beforeend', devices.map((device) => {
        const serial = device.meter_serial ? ` · ${device.meter_serial}` : '';
        return `<option value="${escapeHtml(device.device_uid)}">${escapeHtml(device.device_uid + serial)}</option>`;
    }).join(''));
    const saved = localStorage.getItem('amr-active-device');
    const initial = devices.some((device) => device.device_uid === saved) ? saved : devices[0]?.device_uid;
    if (initial) {
        select.value = initial;
        state.deviceId = initial;
    }
}

async function loadOverview() {
    if (!state.deviceId) return;
    const data = await api(`/api/devices/${encodeURIComponent(state.deviceId)}/overview`);
    byId('selectedMeter').textContent = data.meter_serial || data.device_uid;
    byId('selectedMeterMeta').textContent = data.meter_serial ? data.device_uid : 'Device identity';
    byId('lastCommunication').textContent = formatDate(data.received_at);
    byId('lastCommunicationRelative').textContent = relativeTime(data.received_at);
    byId('meterStatus').textContent = data.parse_status === 'valid' ? 'Online' : (data.parse_status || 'Unknown');
    byId('meterStatus').className = `status ${data.parse_status === 'valid' ? 'success' : 'invalid'}`;
    byId('readingTime').textContent = formatDate(data.reading_ts_utc || data.meter_ts_utc);

    byId('nameplateGrid').innerHTML = details([
        ['Device ID', data.device_uid], ['Meter serial', data.meter_serial],
        ['Manufacturer', data.manufacturer], ['Manufacture year', data.manufacture_year],
        ['Firmware', data.firmware], ['Utility', data.utility],
        ['CT ratio', data.ct_ratio], ['Active meter constant', data.active_meter_constant],
        ['Reactive meter constant', data.reactive_meter_constant],
        ['Integration period', data.integration_period_seconds == null ? '—' : `${data.integration_period_seconds} s`],
        ['Profile interval', data.profile_entry_period_seconds == null ? '—' : `${data.profile_entry_period_seconds} s`],
        ['Sanction load', data.sanction_load_w == null ? '—' : `${number(data.sanction_load_w, 2)} W`],
        ['Contracted demand', data.contracted_demand_wh == null ? '—' : `${number(data.contracted_demand_wh, 2)} Wh`],
        ['TOD', data.tod_enabled == null ? '—' : `${data.tod_enabled ? 'Enabled' : 'Disabled'}${data.tod_zones_count == null ? '' : ` · ${data.tod_zones_count} zones`}`],
        ['Cycle number', data.device_cycle_number], ['Acquisition mode', data.mode],
        ['Meter clock', data.meter_clock_valid == null ? '—' : (data.meter_clock_valid ? 'Valid' : 'Invalid')],
        ['Meter time', formatDate(data.meter_ts_utc)],
    ]);
    byId('healthGrid').innerHTML = details([
        ['Health time', formatDate(data.health_ts_utc)], ['Signal quality (CSQ)', data.csq],
        ['Network attached', data.network_attached == null ? '—' : (data.network_attached ? 'Yes' : 'No')],
        ['Registration', data.registration_status], ['Server configured', data.server_configured == null ? '—' : (data.server_configured ? 'Yes' : 'No')],
        ['Heap free', data.heap_free_bytes == null ? '—' : `${number(Number(data.heap_free_bytes) / 1048576, 2)} MB`],
        ['PSRAM free', data.psram_free_bytes == null ? '—' : `${number(Number(data.psram_free_bytes) / 1048576, 2)} MB`],
        ['Objects read', number(data.total_objects_read, 0)], ['Errors', number(data.total_errors, 0)],
        ['Reconnects', number(data.reconnects, 0)], ['DLMS cycles', number(data.dlms_cycles, 0)],
        ['Last send success', data.last_send_success_seconds == null ? '—' : `${number(data.last_send_success_seconds, 0)} s ago`],
    ]);
    byId('instantGrid').innerHTML = [
        phaseMetric('Voltage', triple(data.voltage_l1_v, data.voltage_l2_v, data.voltage_l3_v, 2, 'V'), 'L1 / L2 / L3'),
        phaseMetric('Current', triple(data.current_l1_a, data.current_l2_a, data.current_l3_a, 3, 'A'), 'L1 / L2 / L3'),
        phaseMetric('Power factor', triple(data.power_factor_l1, data.power_factor_l2, data.power_factor_l3, 3), 'L1 / L2 / L3'),
        metric('Frequency', number(data.frequency_hz, 2), 'Hz'), metric('Active power', number(data.active_import_w, 2), 'W'),
        metric('Reactive power', number(data.reactive_var, 2), 'var'), metric('Apparent power', number(data.apparent_import_va, 2), 'VA'),
        metric('System PF', number(data.power_factor_system, 3)),
    ].join('');
    byId('energyGrid').innerHTML = [
        metric('Active import', scaled(data.active_import_wh), 'kWh'),
        metric('Reactive QI lag', scaled(data.reactive_qi_lag_varh), 'kvarh'),
        metric('Reactive QIII lead', scaled(data.reactive_qiii_lead_varh), 'kvarh'),
        metric('Apparent import', scaled(data.apparent_import_vah), 'kVAh'),
    ].join('');
    byId('counterGrid').innerHTML = details([
        ['Power failures', number(data.power_failure_count, 0)], ['Failure duration', data.power_failure_duration_minutes == null ? '—' : `${number(data.power_failure_duration_minutes, 0)} min`],
        ['Tamper count', number(data.tamper_count, 0)], ['Billing count', number(data.billing_count, 0)],
        ['Billing date', formatDate(data.billing_date_utc)], ['Energy as of', formatDate(data.as_of_utc)],
    ]);
}

function setProfileMetrics() {
    const config = profileConfig[state.profileType];
    byId('profileMetric').innerHTML = Object.entries(config.metrics).map(([key, value]) => `<option value="${key}">${escapeHtml(value[0])} (${escapeHtml(value[1])})</option>`).join('');
}

async function loadProfiles() {
    if (!state.deviceId) return;
    const config = profileConfig[state.profileType];
    const data = await api(`/api/devices/${encodeURIComponent(state.deviceId)}/${config.endpoint}?${queryString({ page: state.profilePage, pageSize: 50, from: inputIso('profileFrom'), to: inputIso('profileTo') })}`);
    state.profilePages = data.pagination.totalPages;
    byId('profilePageSummary').textContent = paginationText(data.pagination);
    byId('profilePrevious').disabled = state.profilePage <= 1;
    byId('profileNext').disabled = state.profilePage >= state.profilePages;
    byId('profileHead').innerHTML = `<tr>${config.headers.map((heading) => `<th>${escapeHtml(heading)}</th>`).join('')}</tr>`;
    byId('profileRows').innerHTML = data.rows.map((row) => state.profileType === 'block'
        ? `<tr><td>${escapeHtml(formatDate(row.reading_ts_utc))}</td><td>${triple(row.current_l1_a, row.current_l2_a, row.current_l3_a, 3, 'A')}</td><td>${triple(row.voltage_l1_v, row.voltage_l2_v, row.voltage_l3_v, 2, 'V')}</td><td>${number(row.active_energy_wh, 2)} Wh</td><td>${number(row.reactive_lag_varh, 2)} varh</td><td>${number(row.reactive_lead_varh, 2)} varh</td><td>${number(row.apparent_energy_vah, 2)} VAh</td></tr>`
        : `<tr><td>${escapeHtml(formatDate(row.reading_ts_utc))}</td><td>${number(row.active_energy_wh, 2)} Wh</td><td>${number(row.reactive_qi_varh, 2)} varh</td><td>${number(row.reactive_qiii_varh, 2)} varh</td><td>${number(row.apparent_energy_vah, 2)} VAh</td><td>${number(row.on_minutes, 0)} min</td><td>${number(row.off_minutes, 0)} min</td><td>${number(row.missing_minutes, 0)} min</td></tr>`).join('');
    renderProfileChart(data.rows);
}

function renderProfileChart(rows) {
    const key = byId('profileMetric').value;
    const [label, unit] = profileConfig[state.profileType].metrics[key];
    const points = [...rows].reverse();
    byId('profileChartEmpty').classList.toggle('hidden', points.length !== 0);
    if (state.profileChart) state.profileChart.destroy();
    state.profileChart = new Chart(byId('profileChart'), {
        type: 'line', data: { labels: points.map((row) => formatDate(row.reading_ts_utc)), datasets: [{ label: `${label} (${unit})`, data: points.map((row) => row[key] == null ? null : Number(row[key])), borderColor: '#20d9a3', backgroundColor: 'rgba(32,217,163,.09)', fill: true, tension: .22, pointRadius: points.length > 40 ? 0 : 2, spanGaps: true }] },
        options: { responsive: true, maintainAspectRatio: false, interaction: { intersect: false, mode: 'index' }, scales: { x: { ticks: { color: '#718191', maxTicksLimit: 8 }, grid: { color: 'rgba(38,51,64,.4)' } }, y: { ticks: { color: '#718191' }, grid: { color: 'rgba(38,51,64,.4)' } } }, plugins: { legend: { labels: { color: '#a7b3bf' } } } },
    });
}

async function loadBilling() {
    if (!state.deviceId) return;
    const range = dateInputRange('billingFrom', 'billingTo');
    const data = await api(`/api/devices/${encodeURIComponent(state.deviceId)}/billing?${queryString({ page: state.billingPage, pageSize: 25, ...range })}`);
    const current = data.current || {};
    byId('billingTime').textContent = formatDate(current.billing_ts_utc);
    byId('billingSummary').innerHTML = [metric('Active import', scaled(current.active_import_wh), 'kWh'), metric('Apparent import', scaled(current.apparent_import_vah), 'kVAh'), metric('Reactive QI', scaled(current.reactive_qi_lag_varh), 'kvarh'), metric('Reactive QIII', scaled(current.reactive_qiii_lead_varh), 'kvarh'), metric('System PF', number(current.system_power_factor, 3)), metric('Cumulative duration', number(current.cumulative_duration_minutes, 0), 'min')].join('');
    byId('billingRows').innerHTML = data.history.map((row) => `<tr><td>${escapeHtml(row.billing_cycle_number)}</td><td>${escapeHtml(formatDate(row.billing_date_utc))}</td><td>${scaled(row.active_import_wh)} kWh</td><td>${scaled(row.apparent_import_vah)} kVAh</td><td>${scaled(row.reactive_qi_varh)} kvarh</td><td>${scaled(row.reactive_qiii_varh)} kvarh</td><td>${number(row.system_power_factor, 3)}</td><td>${number(row.cumulative_duration_minutes, 0)} min</td><td>${number(row.max_demand_w, 2)} W</td><td>${number(row.max_apparent_demand_va, 2)} VA</td></tr>`).join('');
    byId('billingEmpty').classList.toggle('hidden', data.history.length !== 0);
    state.billingPages = data.pagination.totalPages;
    byId('billingPageSummary').textContent = paginationText(data.pagination);
    byId('billingPrevious').disabled = state.billingPage <= 1;
    byId('billingNext').disabled = state.billingPage >= state.billingPages;
}

async function loadEvents() {
    if (!state.deviceId) return;
    const data = await api(`/api/devices/${encodeURIComponent(state.deviceId)}/events?${queryString({ page: state.eventPage, pageSize: 25, eventLog: byId('eventLog').value.trim(), eventCode: byId('eventCode').value, from: inputIso('eventFrom'), to: inputIso('eventTo') })}`);
    byId('eventRows').innerHTML = data.rows.map((row, index) => `
        <tr><td>${escapeHtml(formatDate(row.event_ts_utc))}</td><td>${escapeHtml(row.event_log_key)}</td><td><div class="event-code"><strong>${escapeHtml(row.event_code)}</strong><span>${escapeHtml(row.event_description || 'Unrecognized event code')}</span>${row.event_category ? `<small>${escapeHtml(row.event_category)}</small>` : ''}</div></td><td>${triple(row.voltage_l1_v, row.voltage_l2_v, row.voltage_l3_v, 2, 'V')}</td><td>${triple(row.current_l1_a, row.current_l2_a, row.current_l3_a, 3, 'A')}</td><td>${triple(row.power_factor_l1, row.power_factor_l2, row.power_factor_l3, 3)}</td><td>${number(row.active_import_wh, 2)} Wh</td><td>${number(row.apparent_import_vah, 2)} VAh</td><td><button class="view-button" data-event-toggle="${index}" type="button">Details</button></td></tr>
        <tr id="event-detail-${index}" class="event-detail hidden"><td colspan="9"><dl class="snapshot-grid">${details([
            ['Event time', formatDate(row.event_ts_utc)], ['Event log', row.event_log_key], ['Event code', row.event_code],
            ['Event description', row.event_description || 'Unrecognized event code'], ['Event category', row.event_category || 'Unknown'],
            ['Voltage L1', `${number(row.voltage_l1_v, 2)} V`], ['Voltage L2', `${number(row.voltage_l2_v, 2)} V`], ['Voltage L3', `${number(row.voltage_l3_v, 2)} V`],
            ['Current L1', `${number(row.current_l1_a, 3)} A`], ['Current L2', `${number(row.current_l2_a, 3)} A`], ['Current L3', `${number(row.current_l3_a, 3)} A`],
            ['Power factor L1', number(row.power_factor_l1, 3)], ['Power factor L2', number(row.power_factor_l2, 3)], ['Power factor L3', number(row.power_factor_l3, 3)],
            ['Active import', `${number(row.active_import_wh, 2)} Wh`], ['Apparent import', `${number(row.apparent_import_vah, 2)} VAh`],
        ])}</dl></td></tr>`).join('');
    byId('eventEmpty').classList.toggle('hidden', data.rows.length !== 0);
    state.eventPages = data.pagination.totalPages;
    byId('eventPageSummary').textContent = paginationText(data.pagination);
    byId('eventPrevious').disabled = state.eventPage <= 1;
    byId('eventNext').disabled = state.eventPage >= state.eventPages;
}

async function loadPackets() {
    const data = await api(`/api/packets?${queryString({ page: state.packetPage, pageSize: 25, search: byId('search').value.trim(), deviceId: state.deviceId, meterSerial: byId('meterFilter').value.trim(), from: inputIso('dateFrom'), to: inputIso('dateTo') })}`);
    byId('packetRows').innerHTML = data.rows.map((packet) => `<tr><td>#${escapeHtml(packet.id)}</td><td><span class="status ${['valid', 'success'].includes(packet.parse_status) ? 'success' : 'invalid'}">${escapeHtml(packet.parse_status)}</span></td><td>${escapeHtml(packet.device_uid || '—')}</td><td class="muted">${escapeHtml(packet.meter_serial || '—')}</td><td>${escapeHtml(formatDate(packet.received_at))}</td><td>${number(packet.voltage_l1_v)} V</td><td>${number(packet.current_l1_a, 3)} A</td><td>${packet.active_import_wh == null ? '—' : `${number(Number(packet.active_import_wh) / 1000, 3)} kWh`}</td><td>${number(Number(packet.byte_count) / 1024, 1)} KB</td><td><button class="view-button" data-packet-id="${escapeHtml(packet.id)}" type="button">View JSON</button></td></tr>`).join('');
    byId('tableEmpty').classList.toggle('hidden', data.rows.length !== 0);
    state.packetPages = data.pagination.totalPages;
    byId('pageSummary').textContent = paginationText(data.pagination);
    byId('previousPage').disabled = state.packetPage <= 1;
    byId('nextPage').disabled = state.packetPage >= state.packetPages;
}

async function openPacket(id) {
    const dialog = byId('packetDialog');
    byId('dialogTitle').textContent = `Packet #${id}`;
    byId('packetMeta').textContent = 'Loading…'; byId('rawPayload').textContent = ''; dialog.showModal();
    try {
        const packet = await api(`/api/packets/${id}`);
        byId('packetMeta').innerHTML = `<span>${escapeHtml(packet.device_uid || 'Unknown device')}</span><span>${escapeHtml(formatDate(packet.received_at))}</span><span>${Number(packet.byte_count).toLocaleString()} bytes</span><span class="status ${packet.parse_status === 'valid' ? 'success' : 'invalid'}">${escapeHtml(packet.parse_status)}</span>`;
        try { byId('rawPayload').textContent = JSON.stringify(JSON.parse(packet.raw_payload), null, 2); } catch { byId('rawPayload').textContent = packet.raw_payload; }
    } catch (error) { byId('packetMeta').textContent = error.message; }
}

async function loadCurrentView() {
    clearError();
    byId('devicePrompt').classList.toggle('hidden', Boolean(state.deviceId) || state.view === 'packets');
    byId(`view-${state.view}`).classList.toggle('device-unavailable', !state.deviceId && state.view !== 'packets');
    if (!state.deviceId && state.view !== 'packets') return;
    try {
        if (state.view === 'overview') await loadOverview();
        if (state.view === 'profiles') await loadProfiles();
        if (state.view === 'billing') await loadBilling();
        if (state.view === 'events') await loadEvents();
        if (state.view === 'packets') await loadPackets();
    } catch (error) { showError(error); }
}

function switchView(view) {
    state.view = view;
    document.querySelectorAll('.section-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.view === view));
    document.querySelectorAll('.dashboard-view').forEach((section) => section.classList.toggle('hidden', section.id !== `view-${view}`));
    loadCurrentView();
}

function wirePagination(previousId, nextId, pageKey, pagesKey, loader) {
    byId(previousId).addEventListener('click', () => { if (state[pageKey] > 1) { state[pageKey] -= 1; loader(); } });
    byId(nextId).addEventListener('click', () => { if (state[pageKey] < state[pagesKey]) { state[pageKey] += 1; loader(); } });
}

function initializeEvents() {
    document.querySelectorAll('.section-tab').forEach((tab) => tab.addEventListener('click', () => switchView(tab.dataset.view)));
    byId('activeDevice').addEventListener('change', () => {
        state.deviceId = byId('activeDevice').value;
        localStorage.setItem('amr-active-device', state.deviceId);
        state.profilePage = state.billingPage = state.eventPage = state.packetPage = 1;
        if (!state.deviceId) {
            byId('selectedMeter').textContent = '—'; byId('selectedMeterMeta').textContent = 'Choose a device';
            byId('lastCommunication').textContent = '—'; byId('lastCommunicationRelative').textContent = 'Waiting for data';
        }
        loadCurrentView();
        if (state.deviceId && state.view !== 'overview') loadOverview().catch(showError);
    });
    byId('refreshView').addEventListener('click', () => Promise.all([loadSystemSummary(), loadCurrentView()]));
    document.querySelectorAll('[data-profile]').forEach((button) => button.addEventListener('click', () => { state.profileType = button.dataset.profile; state.profilePage = 1; document.querySelectorAll('[data-profile]').forEach((item) => item.classList.toggle('active', item === button)); setProfileMetrics(); loadProfiles().catch(showError); }));
    byId('profileMetric').addEventListener('change', loadProfiles);
    byId('profileFilters').addEventListener('submit', (event) => { event.preventDefault(); state.profilePage = 1; loadProfiles().catch(showError); });
    byId('billingFilters').addEventListener('submit', (event) => { event.preventDefault(); state.billingPage = 1; loadBilling().catch(showError); });
    byId('eventFilters').addEventListener('submit', (event) => { event.preventDefault(); state.eventPage = 1; loadEvents().catch(showError); });
    byId('clearEventFilters').addEventListener('click', () => { byId('eventFilters').reset(); state.eventPage = 1; loadEvents().catch(showError); });
    byId('eventRows').addEventListener('click', (event) => { const button = event.target.closest('[data-event-toggle]'); if (button) byId(`event-detail-${button.dataset.eventToggle}`).classList.toggle('hidden'); });
    byId('filterForm').addEventListener('submit', (event) => { event.preventDefault(); state.packetPage = 1; loadPackets().catch(showError); });
    byId('clearFilters').addEventListener('click', () => { byId('filterForm').reset(); state.packetPage = 1; loadPackets().catch(showError); });
    byId('packetRows').addEventListener('click', (event) => { const button = event.target.closest('[data-packet-id]'); if (button) openPacket(button.dataset.packetId); });
    byId('closeDialog').addEventListener('click', () => byId('packetDialog').close());
    wirePagination('profilePrevious', 'profileNext', 'profilePage', 'profilePages', () => loadProfiles().catch(showError));
    wirePagination('billingPrevious', 'billingNext', 'billingPage', 'billingPages', () => loadBilling().catch(showError));
    wirePagination('eventPrevious', 'eventNext', 'eventPage', 'eventPages', () => loadEvents().catch(showError));
    wirePagination('previousPage', 'nextPage', 'packetPage', 'packetPages', () => loadPackets().catch(showError));
}

async function initialize() {
    initializeEvents(); setProfileMetrics();
    try {
        await Promise.all([loadDevices(), loadSystemSummary()]);
        await loadCurrentView();
    } catch (error) { showError(error); }
    state.refreshTimer = setInterval(() => {
        loadSystemSummary().catch(showError);
        if (state.view !== 'packets' || byId('autoRefresh').checked) loadCurrentView();
    }, 30000);
}

initialize();
