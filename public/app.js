'use strict';

const state = { page: 1, pageSize: 25, totalPages: 0, chart: null, refreshTimer: null };
const byId = (id) => document.getElementById(id);
const metricConfig = {
    voltage_v: { label: 'Voltage L1', unit: 'V', color: '#20d9a3' },
    current_a: { label: 'Current L1', unit: 'A', color: '#5ea9ff' },
    active_power_w: { label: 'Active power', unit: 'W', color: '#f2b84b' },
    energy_kwh: { label: 'Energy', unit: 'kWh', color: '#b488ff' },
};

async function api(path) {
    const response = await fetch(path, { headers: { Accept: 'application/json' } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
    return body;
}

function queryString(values) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) {
        if (value !== '' && value !== null && value !== undefined) params.set(key, value);
    }
    return params.toString();
}

function isoInputValue(date) {
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 16);
}

function inputIso(id) {
    const value = byId(id).value;
    return value ? new Date(value).toISOString() : '';
}

function formatDate(value) {
    if (!value) return '—';
    return new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium', timeStyle: 'medium', hour12: false,
    }).format(new Date(value));
}

function formatNumber(value, digits = 2) {
    if (value === null || value === undefined) return '—';
    return Number(value).toLocaleString(undefined, { maximumFractionDigits: digits });
}

function relativeTime(value) {
    if (!value) return 'No packets received';
    const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
    })[char]);
}

function showError(error) {
    byId('notice').textContent = error.message;
    byId('notice').classList.remove('hidden');
}

function clearError() { byId('notice').classList.add('hidden'); }

async function loadDevices() {
    const { devices } = await api('/api/devices');
    const options = devices.map((device) => {
        const serial = device.meter_serial ? ` · ${device.meter_serial}` : '';
        return `<option value="${escapeHtml(device.device_uid)}">${escapeHtml(device.device_uid + serial)}</option>`;
    }).join('');
    byId('deviceFilter').insertAdjacentHTML('beforeend', options);
    byId('chartDevice').insertAdjacentHTML('beforeend', options);
}

function packetFilters() {
    return {
        page: state.page,
        pageSize: state.pageSize,
        search: byId('search').value.trim(),
        deviceId: byId('deviceFilter').value,
        meterSerial: byId('meterFilter').value.trim(),
        from: inputIso('dateFrom'),
        to: inputIso('dateTo'),
    };
}

async function loadPackets() {
    try {
        clearError();
        const data = await api(`/api/packets?${queryString(packetFilters())}`);
        state.totalPages = data.pagination.totalPages;
        const rows = data.rows.map((packet) => `
            <tr>
                <td>#${escapeHtml(packet.id)}</td>
                <td><span class="status ${['valid', 'success'].includes(packet.parse_status) ? 'success' : 'invalid'}">${escapeHtml(packet.parse_status)}</span></td>
                <td>${escapeHtml(packet.device_uid || '—')}</td>
                <td class="muted">${escapeHtml(packet.meter_serial || '—')}</td>
                <td title="${escapeHtml(packet.received_at)}">${escapeHtml(formatDate(packet.received_at))}</td>
                <td>${formatNumber(packet.voltage_l1_v)} <span class="muted">V</span></td>
                <td>${formatNumber(packet.current_l1_a, 3)} <span class="muted">A</span></td>
                <td>${packet.active_import_wh == null ? '—' : formatNumber(Number(packet.active_import_wh) / 1000, 3)} <span class="muted">kWh</span></td>
                <td>${formatNumber(Number(packet.byte_count) / 1024, 1)} <span class="muted">KB</span></td>
                <td><button class="view-button" data-packet-id="${escapeHtml(packet.id)}" type="button">View JSON</button></td>
            </tr>`).join('');
        byId('packetRows').innerHTML = rows;
        byId('tableEmpty').classList.toggle('hidden', data.rows.length !== 0);
        const start = data.pagination.total === 0 ? 0 : (data.pagination.page - 1) * data.pagination.pageSize + 1;
        const end = Math.min(data.pagination.total, data.pagination.page * data.pagination.pageSize);
        byId('pageSummary').textContent = `${start}–${end} of ${data.pagination.total.toLocaleString()} packets`;
        byId('previousPage').disabled = state.page <= 1;
        byId('nextPage').disabled = state.page >= state.totalPages;
    } catch (error) {
        showError(error);
    }
}

function chartFilters() {
    return {
        deviceId: byId('chartDevice').value,
        from: inputIso('chartFrom'),
        to: inputIso('chartTo'),
        interval: byId('chartInterval').value,
        aggregate: byId('chartAggregate').value,
    };
}

async function loadStats() {
    try {
        const data = await api(`/api/packets/stats?${queryString(chartFilters())}`);
        byId('packetsToday').textContent = Number(data.summary.total_packets_today || 0).toLocaleString();
        byId('activeDevices').textContent = Number(data.summary.active_devices_last_hour || 0).toLocaleString();
        byId('lastPacket').textContent = formatDate(data.summary.last_packet_received_at);
        byId('lastPacketRelative').textContent = relativeTime(data.summary.last_packet_received_at);
        renderChart(data.chart.series);
    } catch (error) {
        showError(error);
    }
}

function renderChart(series) {
    const metric = byId('chartMetric').value;
    const config = metricConfig[metric];
    const values = series.map((point) => point[metric] == null ? null : Number(point[metric]));
    byId('chartEmpty').classList.toggle('hidden', series.length !== 0);
    if (state.chart) state.chart.destroy();
    state.chart = new Chart(byId('telemetryChart'), {
        type: 'line',
        data: {
            labels: series.map((point) => formatDate(point.bucket)),
            datasets: [{
                label: `${config.label} (${config.unit})`, data: values,
                borderColor: config.color, backgroundColor: `${config.color}20`,
                borderWidth: 2, pointRadius: series.length > 70 ? 0 : 2,
                pointHoverRadius: 5, tension: .25, fill: true, spanGaps: true,
            }],
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            interaction: { intersect: false, mode: 'index' },
            plugins: { legend: { labels: { color: '#a7b3bf', boxWidth: 12 } } },
            scales: {
                x: { ticks: { color: '#718191', maxTicksLimit: 9 }, grid: { color: 'rgba(38,51,64,.45)' } },
                y: { ticks: { color: '#718191', callback: (value) => `${value} ${config.unit}` }, grid: { color: 'rgba(38,51,64,.45)' } },
            },
        },
    });
}

async function openPacket(id) {
    const dialog = byId('packetDialog');
    byId('dialogTitle').textContent = `Packet #${id}`;
    byId('packetMeta').textContent = 'Loading…';
    byId('rawPayload').textContent = '';
    dialog.showModal();
    try {
        const packet = await api(`/api/packets/${id}`);
        byId('packetMeta').innerHTML = `
            <span>${escapeHtml(packet.device_uid || 'Unknown device')}</span>
            <span>${escapeHtml(formatDate(packet.received_at))}</span>
            <span>${Number(packet.byte_count).toLocaleString()} bytes</span>
            <span class="status ${['valid', 'success'].includes(packet.parse_status) ? 'success' : 'invalid'}">${escapeHtml(packet.parse_status)}</span>`;
        try {
            byId('rawPayload').textContent = JSON.stringify(JSON.parse(packet.raw_payload), null, 2);
        } catch {
            byId('rawPayload').textContent = packet.raw_payload;
        }
    } catch (error) {
        byId('packetMeta').textContent = error.message;
    }
}

function setRefreshTimer() {
    if (state.refreshTimer) clearInterval(state.refreshTimer);
    state.refreshTimer = null;
    if (byId('autoRefresh').checked) {
        state.refreshTimer = setInterval(() => Promise.all([loadPackets(), loadStats()]), 30_000);
    }
}

async function initialize() {
    const now = new Date();
    byId('chartTo').value = isoInputValue(now);
    byId('chartFrom').value = isoInputValue(new Date(now.getTime() - 24 * 60 * 60 * 1000));

    byId('filterForm').addEventListener('submit', (event) => { event.preventDefault(); state.page = 1; loadPackets(); });
    byId('clearFilters').addEventListener('click', () => {
        byId('filterForm').reset(); state.page = 1; loadPackets();
    });
    byId('previousPage').addEventListener('click', () => { if (state.page > 1) { state.page -= 1; loadPackets(); } });
    byId('nextPage').addEventListener('click', () => { if (state.page < state.totalPages) { state.page += 1; loadPackets(); } });
    byId('applyChart').addEventListener('click', loadStats);
    byId('chartMetric').addEventListener('change', loadStats);
    byId('autoRefresh').addEventListener('change', setRefreshTimer);
    byId('packetRows').addEventListener('click', (event) => {
        const button = event.target.closest('[data-packet-id]');
        if (button) openPacket(button.dataset.packetId);
    });
    byId('closeDialog').addEventListener('click', () => byId('packetDialog').close());

    try {
        await loadDevices();
        await Promise.all([loadPackets(), loadStats()]);
    } catch (error) {
        showError(error);
    }
    setRefreshTimer();
}

initialize();
