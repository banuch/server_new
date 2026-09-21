'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractDlmsSummary, formatDlmsSummary } = require('../src/dlms-parser');

const sample = {
    schema_version: '2.0.0',
    device: {
        device_id: 'MRI-001',
        meter_serial: '9120944',
        firmware: 'ADMS3.0',
        manufacturer: 'Avon Meters Pvt. Ltd.',
        mfr_year: 2021,
    },
    cycle: { id: 557, mode: 'full', ts_ist: '2026-09-21T19:33:11+05:30', meter_clock_valid: true },
    readings: {
        instant: {
            voltage: { l1_v: 242.09, l2_v: 242.15, l3_v: 243.05 },
            current: { l1_a: 0, l2_a: 0.65, l3_a: 0.65 },
            power_factor: { l1: 1, l2: 1, l3: 1, system: 1 },
            frequency_hz: 50.2,
            power: { active_import_w: 323.75, reactive_q1q2_var: 0, apparent_import_va: 323.75 },
        },
        energy: { active_import_wh: 23346410, apparent_import_vah: 24202980 },
        max_demand: { live: { active_kw_w: 340, active_kw_ts: '2026-09-21T13:00:00+05:30' } },
        tou: [{ zone: 1, kwh: 190471, kvah: 210349, md_kw_w: 36, md_kva_va: 36 }],
    },
    billing: { history: [{ cycle: 2 }] },
    profiles: {
        block_load: { total_entries: 2208, interval_min: 30, latest_10: [{ ts: 'x' }] },
        daily_load: { total_entries: 45, latest_10: [{ ts: 'x' }] },
    },
    events: { power_events: { obis: '0.0.99.98.0.255', count: 6, latest_10: [{ ts: 'x' }] } },
    device_health: { fw_version: '1.0.5', modem: { sim_status: 'READY', csq: 20 } },
};

test('extracts values from the supplied DLMS schema', () => {
    const summary = extractDlmsSummary(sample);

    assert.equal(summary.device.id, 'MRI-001');
    assert.equal(summary.instant.voltageV.l1, 242.09);
    assert.equal(summary.instant.activePowerW, 323.75);
    assert.equal(summary.energy.activeImportWh, 23346410);
    assert.equal(summary.tou.length, 1);
    assert.equal(summary.profiles.blockLoad.totalEntries, 2208);
    assert.equal(summary.events[0].count, 6);
    assert.equal(summary.health.modem.csq, 20);
});

test('formats a readable value display with units', () => {
    const lines = formatDlmsSummary(extractDlmsSummary(sample));
    const display = lines.join('\n');

    assert.match(display, /Device: MRI-001/);
    assert.match(display, /Voltage \(V\): L1=242\.09/);
    assert.match(display, /Power: active=323\.75 W/);
    assert.match(display, /Active=23346410 Wh/);
    assert.match(display, /power_events: count=6/);
    assert.match(display, /SIM=READY  CSQ=20/);
});
