'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DashboardRepository } = require('../src/database/dashboard-repository');

test('packet filters are passed as query parameters and pagination is bounded', async () => {
    const calls = [];
    const database = {
        async execute(sql, values) {
            calls.push({ sql, values });
            if (sql.includes('COUNT(*) AS total')) return [[{ total: 1 }]];
            return [[{ id: 9, device_uid: 'MRI-001' }]];
        },
    };
    const repository = new DashboardRepository(database);
    const result = await repository.getPackets({
        page: '2', pageSize: '10', deviceId: 'MRI-001', search: '127.0.0.1',
        from: '2026-09-20T00:00:00Z', to: '2026-09-21T00:00:00Z',
    });

    assert.equal(result.pagination.page, 2);
    assert.equal(result.pagination.total, 1);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].sql.includes('MRI-001'), false);
    assert.equal(calls[0].values.includes('MRI-001'), true);
    assert.match(calls[0].sql, /COALESCE\(d\.device_uid, pr\.source_device_uid\)/);
    assert.match(calls[1].sql, /COALESCE\(d\.device_uid, pr\.source_device_uid\) AS device_uid/);
    assert.deepEqual(calls[1].values.slice(-2), [10, 10]);
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
                : [[{ device_uid: 'MRI-001', voltage_l1_v: '231.2' }]];
        },
    };
    const repository = new DashboardRepository(database);

    const overview = await repository.getDeviceOverview('MRI-001');

    assert.equal(overview.device_uid, 'MRI-001');
    assert.equal(overview.ct_ratio, '1.000000');
    assert.equal(calls[0].values[0], 'MRI-001');
    assert.match(calls[0].sql, /ORDER BY pr\.received_at DESC/);
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
