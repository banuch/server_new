// One meter: header with communication status, then tabs. The header and the
// live tabs refresh on the timer; history tabs keep their filters and reload
// only when opened, filtered, or refreshed by hand.
import { api, devicePath, isAbort } from '../api.js';
import { dateTime, present } from '../format.js';
import { esc, icon, statusBadge, agoText, stateBox, errorBox } from '../ui.js';
import { renderInstant, renderEnergy, renderInfo, renderComm } from './meter-live.js';
import { createProfileTab, createBillingTab, createEventsTab } from './meter-history.js';
import { createPacketTable } from './packets.js';

const REFRESH_MS = 30_000;
const TABS = [
    ['instant', 'Instantaneous'], ['energy', 'Energy & demand'], ['info', 'Meter info'],
    ['profile', 'Load profile'], ['billing', 'Billing'], ['events', 'Events'],
    ['comm', 'Communication'], ['packets', 'Packets'],
];
const LIVE_TABS = new Set(['instant', 'energy', 'info', 'comm']);
const HISTORY_TABS = {
    profile: createProfileTab,
    billing: createBillingTab,
    events: createEventsTab,
    packets: (deviceId) => createPacketTable({ deviceId }),
};

const validTab = (name) => (TABS.some(([key]) => key === name) ? name : 'instant');

export function createMeterView(route, context) {
    const deviceId = route.id;
    let tab = validTab(route.tab);
    let root;
    let overview = null;
    let history = null;
    let historyName = null;

    const href = (name) => `#/meters/${encodeURIComponent(deviceId)}/${name}`;
    const pane = () => root.querySelector('#meterPane');

    function renderTabs() {
        root.querySelector('.tabs').innerHTML = TABS.map(([key, label]) => `<a class="tab${key === tab ? ' active' : ''}" href="${href(key)}" role="tab" aria-selected="${key === tab}">${label}</a>`).join('');
    }

    function renderHeader() {
        const name = overview.meter_serial || overview.device_uid;
        context.setCrumb(`<a href="#/meters">Meters</a> <span>/ ${esc(name)}</span>`);
        document.title = `${name} · AMR Meter Monitoring`;
        const clockInvalid = overview.meter_clock_valid === 0 || overview.meter_clock_valid === false;
        const ids = [`Device ${overview.device_uid}`, overview.manufacturer, overview.firmware ? `FW ${overview.firmware}` : null].filter(Boolean);
        root.querySelector('#meterHead').innerHTML = `
            <div><h1>${esc(name)} ${statusBadge(overview.status)}</h1><div class="ids">${esc(ids.join(' · '))}</div></div>
            <div class="facts">
                <div class="fact"><small>Last valid packet</small><b>${overview.received_at ? `${esc(dateTime(overview.received_at))} · ${agoText(overview.received_at)}` : 'None'}</b></div>
                <div class="fact"><small>Meter clock</small><b>${esc(dateTime(overview.meter_ts_utc))}${clockInvalid ? ' · <span class="pill no">invalid</span>' : ''}</b></div>
                <div class="fact"><small>Cycle</small><b>${present(overview.device_cycle_number) ? `#${esc(overview.device_cycle_number)} · ${esc(overview.mode || '—')}` : '—'}</b></div>
            </div>`;

        const since = overview.received_at ? agoText(overview.received_at) : '';
        const banners = [];
        if (overview.status === 'offline') {
            banners.push(['bad', 'x', `<strong>Meter offline: no packet for ${since.replace(' ago', '')}.</strong><br>Values shown are the last stored reading (meter time ${esc(dateTime(overview.meter_ts_utc))}), not live data.`]);
        } else if (overview.status === 'delayed') {
            banners.push(['warn', 'clock', `<strong>Packets are late: last valid packet ${since}.</strong> Values may be out of date.`]);
        } else if (overview.status === 'rejected') {
            banners.push(['bad', 'warn', `<strong>The latest packet from this meter was rejected: ${esc(overview.newest_parse_error || 'validation failed')}.</strong><br>Values shown come from the last valid packet (${since}). The Packets tab has the raw data.`]);
        } else if (overview.status === 'never') {
            banners.push(['info', 'minus', '<strong>No valid packet is stored for this meter.</strong>']);
        }
        if (clockInvalid) {
            banners.push(['warn', 'warn', 'The meter reported its clock as invalid. Meter timestamps may be wrong; packet receive times are from the server.']);
        }
        root.querySelector('#meterBanner').innerHTML = banners
            .map(([kind, symbol, text]) => `<div class="banner ${kind}" role="status">${icon(symbol)}<div>${text}</div></div>`).join('');
    }

    function closeHistory() {
        history?.destroy?.();
        history = null;
        historyName = null;
    }

    async function renderLiveTab(signal) {
        closeHistory();
        if (tab === 'energy') {
            if (!pane().children.length) pane().innerHTML = '<span class="skeleton block"></span>';
            const markup = await renderEnergy(overview, deviceId, signal);
            pane().innerHTML = markup;
            return;
        }
        pane().innerHTML = { instant: renderInstant, info: renderInfo, comm: renderComm }[tab](overview);
    }

    async function loadHistoryTab(signal) {
        if (historyName !== tab) {
            closeHistory();
            history = HISTORY_TABS[tab](deviceId);
            historyName = tab;
            pane().innerHTML = '';
            const holder = document.createElement('div');
            if (tab === 'packets') holder.className = 'panel';
            pane().append(holder);
            history.mount(holder);
        }
        try {
            await history.load(signal);
        } catch (error) {
            // History tabs show their own errors; only cancellation propagates.
            if (isAbort(error)) throw error;
        }
    }

    function layout() {
        closeHistory();
        root.innerHTML = `<div class="mhead" id="meterHead"><span class="skeleton" style="width:260px"></span></div>
            <div id="meterBanner"></div>
            <nav class="tabs" role="tablist" aria-label="Meter sections"></nav>
            <div id="meterPane"><span class="skeleton block"></span></div>`;
        renderTabs();
    }

    return {
        mount(element) {
            root = element;
            context.setCrumb(`<a href="#/meters">Meters</a> <span>/ ${esc(deviceId)}</span>`);
            layout();
            root.addEventListener('click', (event) => {
                if (event.target.closest('#meterPane > .state [data-action=retry], #meterRetry')) context.reload('manual');
            });
        },
        update(next) {
            if (next.id !== deviceId) return false;
            const nextTab = validTab(next.tab);
            if (nextTab !== tab) {
                tab = nextTab;
                renderTabs();
                if (LIVE_TABS.has(tab)) pane().innerHTML = '<span class="skeleton block"></span>';
            }
            return true;
        },
        async load(signal, reason) {
            overview = await api(devicePath(deviceId, '/overview'), { signal });
            if (!root.querySelector('#meterHead')) layout();
            renderHeader();
            if (LIVE_TABS.has(tab)) await renderLiveTab(signal);
            else if (reason !== 'auto' || historyName !== tab) await loadHistoryTab(signal);
        },
        refreshMs: () => REFRESH_MS,
        hasData: () => Boolean(overview),
        showError(error) {
            overview = null;
            document.title = 'AMR Meter Monitoring';
            if (error.status === 404) {
                root.innerHTML = `<div class="panel">${stateBox({ kind: 'info', title: 'Meter not found', detail: `No meter with device ID "${deviceId}" has reported to this server.` })}
                    <p style="text-align:center;margin:0 0 24px"><a class="btn" href="#/meters">Back to meters</a></p></div>`;
                return;
            }
            root.innerHTML = `<div class="panel">${errorBox(error).replace('data-action="retry"', 'id="meterRetry"')}</div>`;
        },
        destroy() {
            closeHistory();
            document.title = 'AMR Meter Monitoring';
        },
    };
}
