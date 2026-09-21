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
