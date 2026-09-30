// Meter tabs built from the latest stored cycle: instantaneous values, energy
// and demand, meter information, and communication health.
import { api, devicePath } from '../api.js';
import { num, int, kilo, withUnit, dateTime, dateMinute, shortTime, present, unbalance, bytesToMb, zoneLabel, durationText } from '../format.js';
import { esc, freshnessTag, agoText, kvList, yesNo, signal, stateBox, packetBadge } from '../ui.js';

const PHASES = [['R', 'l1', '--phase-r'], ['Y', 'l2', '--phase-y'], ['B', 'l3', '--phase-b']];
const STALE = new Set(['offline', 'never']);

function capturedLine(overview, when, label = 'Captured') {
    return `<div class="captured">${freshnessTag(overview.status)}
        <span>${esc(label)} ${esc(dateTime(when))} ${esc(zoneLabel())} · ${agoText(when)}</span>
        ${overview.received_at ? `<span>· packet received ${esc(shortTime(overview.received_at))}</span>` : ''}</div>`;
}

function param(label, value, unit = '', hint = '', hintClass = '') {
    if (value === '—') return '';
    return `<dl class="param"><dt>${esc(label)}</dt><dd>${esc(value)}${unit ? `<small>${esc(unit)}</small>` : ''}</dd>${hint ? `<span class="hint ${hintClass}">${esc(hint)}</span>` : ''}</dl>`;
}

function staleClass(overview) {
    return STALE.has(overview.status) ? 'stale-values' : '';
}

export function renderInstant(overview) {
    const phases = PHASES.map(([name, key, color]) => {
        const voltage = overview[`voltage_${key}_v`];
        const current = overview[`current_${key}_a`];
        const pf = overview[`power_factor_${key}`];
        if (![voltage, current, pf].some(present)) return '';
        const value = (label, text, unit) => `<div class="pv"><dt>${label}</dt><dd>${esc(text)}${unit && text !== '—' ? `<small>${unit}</small>` : ''}</dd></div>`;
        return `<div class="phase" style="--c:var(${color})"><h4>${name} PHASE</h4><dl>
            ${value('Voltage', num(voltage, 1), 'V')}${value('Current', num(current, 2), 'A')}${value('Power factor', num(pf, 3), '')}</dl></div>`;
    }).join('');

    const vUnbalance = unbalance([overview.voltage_l1_v, overview.voltage_l2_v, overview.voltage_l3_v]);
    const iUnbalance = unbalance([overview.current_l1_a, overview.current_l2_a, overview.current_l3_a]);
    const params = [
        param('Frequency', num(overview.frequency_hz, 2), 'Hz'),
        param('Active power', kilo(overview.active_import_w, 3), 'kW'),
        param('Reactive power', kilo(overview.reactive_var, 3), 'kVAr'),
        param('Apparent power', kilo(overview.apparent_import_va, 3), 'kVA'),
        param('System power factor', num(overview.power_factor_system, 3)),
        vUnbalance === null ? '' : param('Voltage unbalance', num(vUnbalance, 1), '%', vUnbalance > 3 ? 'Above 3 % · computed from R/Y/B' : 'Computed from R/Y/B', vUnbalance > 3 ? 'warn' : ''),
        iUnbalance === null ? '' : param('Current unbalance', num(iUnbalance, 1), '%', iUnbalance > 20 ? 'Above 20 % · computed from R/Y/B' : 'Computed from R/Y/B', iUnbalance > 20 ? 'warn' : ''),
    ].join('');

    if (!phases && !params) {
        return stateBox({ kind: 'info', title: 'No instantaneous values', detail: 'The latest valid packet from this meter carried no instantaneous readings.' });
    }
    return `${capturedLine(overview, overview.reading_ts_utc || overview.meter_ts_utc)}
        <div class="${staleClass(overview)}">
            ${phases ? `<div class="phases">${phases}</div>` : ''}
            ${params ? `<div class="params">${params}</div>` : ''}
        </div>`;
}

function demandRow(label, row) {
    if (!row) return '';
    return `<tr><td class="full"><b>${esc(label)}</b></td>
        <td class="num val" data-l="Active MD">${esc(withUnit(kilo(row.active_demand_w, 3), 'kW'))}</td>
        <td data-l="Occurred">${esc(dateMinute(row.active_demand_ts_utc))}</td>
        <td class="num val" data-l="Apparent MD">${esc(withUnit(kilo(row.apparent_demand_va, 3), 'kVA'))}</td>
        <td data-l="Occurred">${esc(dateMinute(row.apparent_demand_ts_utc))}</td></tr>`;
}

// TOU zone energies are stored in Wh and VAh (the payload field "kwh" holds
// the scaled register value, whose unit is Wh), so they are shown divided by 1000.
function touRows(zones) {
    return zones
        .filter((zone) => [zone.energy_kwh, zone.apparent_energy_kvah, zone.max_demand_w, zone.max_apparent_demand_va]
            .some((value) => present(value) && Number(value) !== 0))
        .map((zone) => `<tr><td class="full"><b>TZ${esc(zone.zone_number)}</b></td>
            <td class="num val" data-l="Active energy">${esc(withUnit(kilo(zone.energy_kwh, 2), 'kWh'))}</td>
            <td class="num val" data-l="Apparent energy">${esc(withUnit(kilo(zone.apparent_energy_kvah, 2), 'kVAh'))}</td>
            <td class="num val" data-l="Max demand">${esc(withUnit(kilo(zone.max_demand_w, 3), 'kW'))}</td>
            <td data-l="MD occurred">${esc(dateMinute(zone.max_demand_ts_utc))}</td></tr>`).join('');
}

export async function renderEnergy(overview, deviceId, signal) {
    const energy = await api(devicePath(deviceId, '/energy'), { signal });
    const registers = [
        param('Active import', kilo(overview.active_import_wh, 2), 'kWh'),
        param('Apparent import', kilo(overview.apparent_import_vah, 2), 'kVAh'),
        param('Reactive lag (QI)', kilo(overview.reactive_qi_lag_varh, 2), 'kVArh'),
        param('Reactive lead (QIII)', kilo(overview.reactive_qiii_lead_varh, 2), 'kVArh'),
    ].join('');
    const demand = demandRow('Current billing cycle', energy.maxDemand.billing_cycle) + demandRow('Live', energy.maxDemand.live);
    const demandCaptured = energy.maxDemand.billing_cycle?.captured_at || energy.maxDemand.live?.captured_at;
    const tou = touRows(energy.tou);

    return `<div class="${staleClass(overview)}">
        <h2 class="section">Energy registers</h2>
        ${registers ? `${capturedLine(overview, overview.as_of_utc || overview.meter_ts_utc, 'Registers as of')}<div class="params">${registers}</div>`
        : stateBox({ kind: 'info', title: 'No energy registers', detail: 'The latest valid packet carried no energy readings.' })}

        <h2 class="section">Maximum demand ${demandCaptured ? `<small>from cycle at ${esc(dateMinute(demandCaptured))}</small>` : ''}</h2>
        <div class="panel">${demand
        ? `<div class="tscroll"><table class="cards"><thead><tr><th>Period</th><th class="num">Active MD</th><th>Occurred</th><th class="num">Apparent MD</th><th>Occurred</th></tr></thead><tbody>${demand}</tbody></table></div>`
        : stateBox({ title: 'No maximum demand recorded' })}</div>

        <h2 class="section">Time-of-day zones ${energy.tou[0] ? `<small>billing snapshot from cycle at ${esc(dateMinute(energy.tou[0].captured_at))}; zones without energy are hidden</small>` : ''}</h2>
        <div class="panel">${tou
        ? `<div class="tscroll"><table class="cards"><thead><tr><th>Zone</th><th class="num">Active energy</th><th class="num">Apparent energy</th><th class="num">Max demand</th><th>MD occurred</th></tr></thead><tbody>${tou}</tbody></table></div>`
        : stateBox({ title: 'No time-of-day zone data', detail: 'Zone values arrive with the meter billing snapshot.' })}</div>
    </div>`;
}

export function renderInfo(overview) {
    const seconds = (value) => (present(value) ? durationText(Number(value)) : null);
    const nameplate = kvList([
        ['Meter serial', overview.meter_serial ?? '—'],
        ['Device ID', overview.device_uid],
        ['Manufacturer', overview.manufacturer ?? '—'],
        ['Manufacture year', overview.manufacture_year ?? '—'],
        ['Device firmware', overview.firmware ?? '—'],
        ['Utility', overview.utility ?? '—'],
    ]);
    const configuration = kvList([
        ['CT ratio', present(overview.ct_ratio) ? num(overview.ct_ratio, 2) : null],
        ['Active meter constant', present(overview.active_meter_constant) ? num(overview.active_meter_constant, 2) : null],
        ['Reactive meter constant', present(overview.reactive_meter_constant) ? num(overview.reactive_meter_constant, 2) : null],
        ['Demand integration period', seconds(overview.integration_period_seconds)],
        ['Profile capture period', seconds(overview.profile_entry_period_seconds)],
        ['Sanctioned load', present(overview.sanction_load_w) ? withUnit(kilo(overview.sanction_load_w, 2), 'kW') : null],
        ['Contracted demand', present(overview.contracted_demand_wh) ? withUnit(kilo(overview.contracted_demand_wh, 2), 'kW') : null],
        ['Time of day tariff', overview.tod_enabled === null || overview.tod_enabled === undefined ? null
            : `${overview.tod_enabled ? 'Enabled' : 'Disabled'}${present(overview.tod_zones_count) ? ` · ${overview.tod_zones_count} zones` : ''}`],
        ['DLMS client address', overview.client_sap ?? null],
        ['DLMS server address', overview.server_address ?? null],
        ['DLMS authentication', overview.auth_mode ?? null],
        ['Meter port baud rate', overview.baud ?? null],
    ]);
    const counters = kvList([
        ['Power failures', int(overview.power_failure_count)],
        ['Power failure duration', present(overview.power_failure_duration_minutes) ? `${int(overview.power_failure_duration_minutes)} min` : '—'],
        ['Tamper count', int(overview.tamper_count)],
        ['Billing count', int(overview.billing_count)],
        ['Last billing date', dateMinute(overview.billing_date_utc)],
    ]);
    return `<div class="two even">
        <section class="panel"><div class="panel-head"><h3>Name plate</h3></div>${nameplate}</section>
        <section class="panel"><div class="panel-head"><h3>Configuration</h3><span class="note">${overview.config_ts_utc ? `Reported with cycle at ${esc(dateMinute(overview.config_ts_utc))}` : ''}</span></div>
            ${configuration || stateBox({ title: 'No configuration reported yet', detail: 'Configuration arrives with full packets, sent after the device starts.' })}</section>
    </div>
    <section class="panel" style="margin-top:14px"><div class="panel-head"><h3>Meter counters</h3><span class="note">From the latest valid packet</span></div>${counters}</section>`;
}

export function renderComm(overview) {
    const errors = present(overview.total_errors) ? Number(overview.total_errors) : null;
    const link = kvList([
        ['Signal quality (CSQ)', signal(overview.csq) ?? '—'],
        ['Network attached', yesNo(overview.network_attached) ?? '—'],
        ['Registration status', overview.registration_status ?? '—'],
        ['SIM status', overview.sim_status ?? '—'],
        ['Modem firmware', overview.modem_firmware ?? '—'],
        ['Server configured', yesNo(overview.server_configured) ?? '—'],
        ['Previous send success', present(overview.last_send_success_seconds) ? `${durationText(Number(overview.last_send_success_seconds))} before this cycle` : '—'],
        ['Client IP (last valid packet)', overview.client_ip ?? '—'],
    ], 'single');
    const reader = kvList([
        ['DLMS read cycles', int(overview.dlms_cycles)],
        ['Objects read', int(overview.total_objects_read)],
        ['Read errors (total)', int(errors), errors > 0],
        ['Reconnects', int(overview.reconnects)],
        ['Free heap', bytesToMb(overview.heap_free_bytes)],
        ['Free PSRAM', bytesToMb(overview.psram_free_bytes)],
        ['Health reported', dateTime(overview.health_ts_utc)],
    ], 'single');
    const latest = kvList([
        ['Latest packet', overview.newest_parse_status ? { html: packetBadge(overview.newest_parse_status) } : '—'],
        ['Received', overview.newest_received_at ? { html: `${esc(dateTime(overview.newest_received_at))} · ${agoText(overview.newest_received_at)}` } : '—'],
        ['Rejection reason', overview.newest_parse_status === 'invalid' ? (overview.newest_parse_error || 'Unknown') : null],
        ['Last valid packet', overview.received_at ? { html: `${esc(dateTime(overview.received_at))} · ${agoText(overview.received_at)}` } : '—'],
        ['Cycle', present(overview.device_cycle_number) ? `#${overview.device_cycle_number} · ${overview.mode || 'unknown mode'}` : '—'],
    ], 'single');

    const profiles = (overview.profiles || []).map((profile) => {
        const used = present(profile.entries_in_use) && present(profile.profile_capacity) && Number(profile.profile_capacity) > 0
            ? `${num((Number(profile.entries_in_use) / Number(profile.profile_capacity)) * 100, 0)} %` : '—';
        return `<tr><td class="full"><b>${esc(profile.profile_type)}</b><span class="sub">${esc(profile.obis || '')}</span></td>
            <td class="num" data-l="Entries">${int(profile.entries_in_use)} / ${int(profile.profile_capacity)}</td>
            <td class="num" data-l="Used">${esc(used)}</td>
            <td class="num" data-l="Interval">${present(profile.interval_minutes) ? `${int(profile.interval_minutes)} min` : '—'}</td>
            <td data-l="Buffer full">${yesNo(profile.buffer_full)?.html ?? '—'}</td></tr>`;
    }).join('');

    return `<div class="two even">
        <section class="panel"><div class="panel-head"><h3>Link and modem</h3><span class="note">As reported with the latest valid packet</span></div>${link}</section>
        <div class="stack">
            <section class="panel"><div class="panel-head"><h3>Packets</h3></div>${latest}</section>
            <section class="panel"><div class="panel-head"><h3>DLMS reader (device)</h3></div>${reader}</section>
        </div>
    </div>
    <section class="panel" style="margin-top:14px"><div class="panel-head"><h3>Profile buffers in the meter</h3></div>
        ${profiles ? `<div class="tscroll"><table class="cards"><thead><tr><th>Profile</th><th class="num">Entries</th><th class="num">Used</th><th class="num">Interval</th><th>Buffer full</th></tr></thead><tbody>${profiles}</tbody></table></div>`
        : stateBox({ title: 'No profile buffer information reported' })}
    </section>`;
}
