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
