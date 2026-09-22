'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDlmsPacket, mysqlDate, timezoneOffsetMinutes } = require('../src/dlms-packet');

const payload = {
    schema_version: '2.1.0',
    device: { device_id: 'MRI-001' },
    cycle: {
        id: 18,
        ts_utc: '2026-09-21T21:15:44Z',
        ts_ist: '2026-09-22T02:45:44+05:30',
    },
    readings: {},
};

test('parses a direct schema 2.1.0 packet', () => {
    const parsed = parseDlmsPacket(JSON.stringify(payload));
    assert.equal(parsed.payload.device.device_id, 'MRI-001');
    assert.equal(parsed.payload.cycle.id, 18);
});

test('unwraps an optional METER_DATA envelope', () => {
    const envelope = { type: 'METER_DATA', deviceId: 'MRI-001', readings: payload };
    const parsed = parseDlmsPacket(JSON.stringify(envelope));
    assert.equal(parsed.payload.schema_version, '2.1.0');
});

test('uses envelope identity when a delta packet omits the device block', () => {
    const delta = {
        schema_version: '2.1.0',
        cycle: { id: 42, ts_utc: '2026-09-22T08:26:09Z', mode: 'delta' },
        readings: {},
    };
    const envelope = { type: 'METER_DATA', deviceId: 'MRI-DELTA-001', readings: delta };
    const parsed = parseDlmsPacket(JSON.stringify(envelope));

    assert.equal(parsed.payload.device.device_id, 'MRI-DELTA-001');
    assert.equal(parsed.payload.cycle.mode, 'delta');
});

test('uses receiver identity for a direct delta packet without a device block', () => {
    const delta = {
        schema_version: '2.1.0',
        cycle: { id: 42, ts_utc: '2026-09-22T08:26:09Z', mode: 'delta' },
        billing: null,
        profiles: { daily_load: null },
    };
    const parsed = parseDlmsPacket(JSON.stringify(delta), { deviceId: 'tcp:192.0.2.10' });

    assert.equal(parsed.payload.device.device_id, 'tcp:192.0.2.10');
});

test('still rejects a device-less non-delta packet', () => {
    assert.throws(
        () => parseDlmsPacket(JSON.stringify({
            schema_version: '2.1.0',
            cycle: { id: 42, ts_utc: '2026-09-22T08:26:09Z', mode: 'full' },
        }), { deviceId: 'tcp:192.0.2.10' }),
        /device must be an object/,
    );
});

test('rejects missing required identity fields', () => {
    assert.throws(
        () => parseDlmsPacket(JSON.stringify({ schema_version: '2.1.0', device: {}, cycle: {} })),
        /device\.device_id is required/,
    );
});

test('normalizes ISO timestamps to UTC MySQL values', () => {
    assert.equal(mysqlDate('2026-09-22T02:45:44+05:30'), '2026-09-21 21:15:44.000');
    assert.equal(timezoneOffsetMinutes('2026-09-22T02:45:44+05:30'), 330);
});
