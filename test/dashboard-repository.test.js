'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DashboardRepository, startOfDay, MAX_SERIES_POINTS } = require('../src/database/dashboard-repository');

const NOW = new Date('2026-09-30T10:00:00Z');
const minutesAgo = (minutes) => new Date(NOW.getTime() - minutes * 60_000);

function meterRow(overrides) {
    return {
        device_uid: 'MRI-001', meter_serial: 'S1', manufacturer: 'Avon',
        last_received_at: minutesAgo(2), newest_received_at: minutesAgo(2), newest_parse_status: 'valid',
        active_import_w: '1000', active_import_wh: '5000', ...overrides,
    };
}

test('local midnight is computed in the display time zone', () => {
    // 10:00 UTC is 15:30 IST, so the IST day began at 18:30 UTC the day before.
    assert.equal(startOfDay('Asia/Kolkata', NOW).toISOString(), '2026-09-29T18:30:00.000Z');
    assert.equal(startOfDay('UTC', NOW).toISOString(), '2026-09-30T00:00:00.000Z');
    // 20:00 UTC is already the next day in IST.
    assert.equal(startOfDay('Asia/Kolkata', new Date('2026-09-30T20:00:00Z')).toISOString(), '2026-09-30T18:30:00.000Z');
});

test('meter list reports status, counts, filters, and sorts in one query', async () => {
    const calls = [];
    const database = {
        async execute(sql) {
            calls.push(sql);
            return [[
                meterRow({ device_uid: 'A', meter_serial: 'S-A', manufacturer: 'Genus', active_import_w: '300' }),
                meterRow({ device_uid: 'B', meter_serial: 'S-B', last_received_at: minutesAgo(45), active_import_w: '900' }),
                meterRow({ device_uid: 'C', meter_serial: 'S-C', last_received_at: minutesAgo(20), active_import_w: '500' }),
            ]];
        },
    };
    const repository = new DashboardRepository(database, { now: () => NOW });

    const all = await repository.getMeters({ sort: 'power', dir: 'desc' });
    assert.equal(calls.length, 1);
    assert.deepEqual(all.counts, { total: 3, online: 1, delayed: 1, offline: 1, rejected: 0, never: 0 });
    assert.deepEqual(all.rows.map((row) => row.device_uid), ['B', 'C', 'A']);
    assert.deepEqual(all.manufacturers, ['Avon', 'Genus']);
    assert.equal(all.rows[0].status, 'offline');

    const offline = await repository.getMeters({ status: 'offline' });
    assert.deepEqual(offline.rows.map((row) => row.device_uid), ['B']);

    const genus = await repository.getMeters({ search: 's-a' });
    assert.deepEqual(genus.rows.map((row) => row.device_uid), ['A']);

    await assert.rejects(repository.getMeters({ status: 'bogus' }), /status must be one of/);
});

test('fleet summary lists meters needing attention, most urgent first', async () => {
    const calls = [];
    const database = {
        async execute(sql, values) {
            calls.push({ sql, values });
            if (sql.includes('rejected_last_24h')) return [[{ rejected_last_24h: 3, packets_today: 40 }]];
            if (sql.includes('ORDER BY received_at DESC, id DESC LIMIT 1')) {
                return [[{ received_at: minutesAgo(1), source_device_uid: 'A', parse_status: 'valid' }]];
            }
            return [[
                meterRow({ device_uid: 'A' }),
                meterRow({ device_uid: 'B', last_received_at: minutesAgo(15) }),
                meterRow({ device_uid: 'C', last_received_at: minutesAgo(90) }),
            ]];
        },
    };
    const fleet = await new DashboardRepository(database, { now: () => NOW }).getFleet();

    assert.equal(fleet.counts.online, 1);
    assert.equal(fleet.rejected_last_24h, 3);
    assert.equal(fleet.packets_today, 40);
    assert.deepEqual(fleet.attention.map((meter) => meter.device_uid), ['C', 'B']);
    assert.equal(fleet.day_start, '2026-09-29T18:30:00.000Z');
    assert.equal(fleet.last_packet.source_device_uid, 'A');
});

test('load profile series is bounded and returned oldest first', async () => {
    const calls = [];
    const database = {
        async execute(sql, values) {
            calls.push({ sql, values });
            return [[{ reading_ts_utc: 'newest' }, { reading_ts_utc: 'oldest' }]];
        },
    };
    const series = await new DashboardRepository(database).getLoadProfileSeries('block', 'MRI-001', {
        from: '2026-09-01', to: '2026-09-30',
    });

    assert.deepEqual(series.rows.map((row) => row.reading_ts_utc), ['oldest', 'newest']);
    assert.equal(series.truncated, false);
    assert.equal(calls[0].values.at(-1), MAX_SERIES_POINTS + 1);
    assert.match(calls[0].sql, /block_load_entries/);
    await assert.rejects(new DashboardRepository(database).getLoadProfileSeries('other', 'MRI-001'), /block or daily/);
});

test('energy returns the latest maximum demand and TOU zones', async () => {
    const calls = [];
    const database = {
        async execute(sql, values) {
            calls.push({ sql, values });
            if (sql.includes('FROM tou_readings')) return [[{ zone_number: 1 }, { zone_number: 2 }]];
            return [[{ active_demand_w: '6840' }]];
        },
    };
    const energy = await new DashboardRepository(database).getEnergy('MRI-001');

    assert.equal(energy.maxDemand.billing_cycle.active_demand_w, '6840');
    assert.equal(energy.tou.length, 2);
    assert.deepEqual(calls[0].values, ['MRI-001', 'billing_cycle']);
    assert.deepEqual(calls[1].values, ['MRI-001', 'live']);
});

test('packet filters are passed as query parameters and pagination is bounded', async () => {
    const calls = [];
    const database = {
        async execute(sql, values) {
            calls.push({ sql, values });
            if (sql.includes('COUNT(*) AS total')) return [[{ total: 11 }]];
            return [[{ id: 9, device_uid: 'MRI-001' }]];
        },
    };
    const repository = new DashboardRepository(database);
    const result = await repository.getPackets({
        page: '2', pageSize: '10', deviceId: 'MRI-001', search: '127.0.0.1',
        from: '2026-09-20T00:00:00Z', to: '2026-09-21T00:00:00Z',
    });

    assert.equal(result.pagination.page, 2);
    assert.equal(result.pagination.total, 11);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].sql.includes('MRI-001'), false);
    assert.equal(calls[0].values.includes('MRI-001'), true);
    assert.match(calls[0].sql, /pr\.source_device_uid = \?/);
    assert.doesNotMatch(calls[0].sql, /JOIN/);
    assert.match(calls[1].sql, /FROM \(SELECT pr\.id FROM packet_receipts pr WHERE/);
    assert.match(calls[1].sql, /COALESCE\(d\.device_uid, pr\.source_device_uid\) AS device_uid/);
    assert.deepEqual(calls[1].values.slice(-2), [10, 10]);
});

test('skips the page query when the page is past the matching rows', async () => {
    const calls = [];
    const database = {
        async execute(sql, values) {
            calls.push({ sql, values });
            return [[{ total: 0 }]];
        },
    };
    const result = await new DashboardRepository(database).getPackets({ search: 'nothing' });

    assert.deepEqual(result.rows, []);
    assert.equal(result.pagination.total, 0);
    assert.equal(calls.length, 1);
});

test('chart dimensions are selected only from validated values', async () => {
    const calls = [];
    const database = {
        async execute(sql, values = []) {
            calls.push({ sql, values });
            return sql.includes('total_packets_today')
                ? [[{ total_packets_today: 4, active_devices_last_hour: 1 }]]
                : [[{ bucket: '2026-09-21T00:00:00.000Z', voltage_v: '230.2' }]];
        },
    };
    const repository = new DashboardRepository(database);
    const result = await repository.getStats({ interval: 'invalid', aggregate: 'invalid' });

    assert.equal(result.chart.interval, 'hour');
    assert.equal(result.chart.aggregate, 'avg');
    assert.match(calls[1].sql, /AVG\(ir\.voltage_l1_v\)/);
    assert.match(calls[1].sql, /DATE_FORMAT\(pr\.received_at/);
});

test('rejects invalid date ranges before querying', async () => {
    const repository = new DashboardRepository({ execute: async () => [[]] });
    await assert.rejects(
        repository.getPackets({ from: '2026-09-22', to: '2026-09-21' }),
        /from must be earlier/,
    );
});

test('returns the latest detailed device overview', async () => {
    const calls = [];
    const database = {
        async execute(sql, values) {
            calls.push({ sql, values });
            return sql.includes('FROM cycle_configs')
                ? [[{ ct_ratio: '1.000000' }]]
                : [[{ device_uid: 'MRI-001', voltage_l1_v: '231.2', received_at: minutesAgo(45) }]];
        },
    };
    const repository = new DashboardRepository(database, { now: () => NOW });

    const overview = await repository.getDeviceOverview('MRI-001');

    // Status comes from the latest valid packet's receive time.
    assert.equal(overview.status, 'offline');
    assert.equal(overview.status_age_seconds, 45 * 60);
    assert.equal(overview.device_uid, 'MRI-001');
    assert.equal(overview.ct_ratio, '1.000000');
    assert.equal(calls[0].values[0], 'MRI-001');
    assert.match(calls[0].sql, /ORDER BY latest\.received_at DESC/);
    assert.match(calls[0].sql, /LEFT JOIN device_health/);
    assert.match(calls[1].sql, /FROM cycle_configs/);
});

test('paginates and date-filters block load readings', async () => {
    const calls = [];
    const database = {
        async execute(sql, values) {
            calls.push({ sql, values });
            return sql.includes('COUNT(*)') ? [[{ total: 11 }]] : [[{ active_energy_wh: '12' }]];
        },
    };
    const repository = new DashboardRepository(database);
    const result = await repository.getBlockLoad('MRI-001', {
        page: '2', pageSize: '5', from: '2026-09-01', to: '2026-09-30',
    });

    assert.equal(result.pagination.totalPages, 3);
    assert.deepEqual(calls[1].values.slice(-2), [5, 5]);
    assert.match(calls[1].sql, /block_load_entries/);
    assert.match(calls[1].sql, /reading_ts_utc >= \?/);
});

test('filters events by category, log, and numeric event code', async () => {
    const calls = [];
    const database = {
        async execute(sql, values) {
            calls.push({ sql, values });
            return sql.includes('COUNT(*)') ? [[{ total: 1 }]] : [[{
                event_code: 203,
                event_category: 'Other events',
                event_description: 'Neutral disturbance - HF and DC - occurrence',
            }]];
        },
    };
    const repository = new DashboardRepository(database);
    const result = await repository.getEvents('MRI-001', {
        eventCategory: 'Other events', eventLog: 'event_log_4', eventCode: '203',
    });

    assert.equal(result.rows[0].event_code, 203);
    assert.equal(result.rows[0].event_description, 'Neutral disturbance - HF and DC - occurrence');
    assert.deepEqual(calls[0].values, ['MRI-001', 'event_log_4', 203, 'Other events']);
    assert.match(calls[0].sql, /LEFT JOIN event_code_lookup/);
    assert.match(calls[1].sql, /LEFT JOIN event_code_lookup/);
    assert.match(calls[1].sql, /LEFT JOIN event_measurements/);
});

test('returns current billing and paginated billing history', async () => {
    const calls = [];
    const database = {
        async execute(sql, values) {
            calls.push({ sql, values });
            if (sql.includes('FROM billing_current')) return [[{ active_import_wh: '1000' }]];
            if (sql.includes('COUNT(*)')) return [[{ total: 2 }]];
            return [[{ billing_cycle_number: 7 }]];
        },
    };
    const repository = new DashboardRepository(database);
    const result = await repository.getBilling('MRI-001', { page: '1', pageSize: '10' });

    assert.equal(result.current.active_import_wh, '1000');
    assert.equal(result.history[0].billing_cycle_number, 7);
    assert.equal(result.pagination.total, 2);
    assert.deepEqual(calls[2].values.slice(-2), [10, 0]);
});

test('rejects profile requests without a device identity', async () => {
    const repository = new DashboardRepository({ execute: async () => [[]] });
    await assert.rejects(repository.getDailyLoad('', {}), /deviceId is required/);
});
