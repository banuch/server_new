'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { meterStatus } = require('../src/meter-status');

const now = new Date('2026-09-30T10:00:00Z');
const thresholds = { onlineAfterSeconds: 600, offlineAfterSeconds: 1800 };
const minutesAgo = (minutes) => new Date(now.getTime() - minutes * 60_000).toISOString();

test('classifies meters by the age of their last valid packet', () => {
    assert.equal(meterStatus({ last_received_at: minutesAgo(10) }, now, thresholds).status, 'online');
    assert.equal(meterStatus({ last_received_at: minutesAgo(11) }, now, thresholds).status, 'delayed');
    assert.equal(meterStatus({ last_received_at: minutesAgo(30) }, now, thresholds).status, 'delayed');
    assert.equal(meterStatus({ last_received_at: minutesAgo(31) }, now, thresholds).status, 'offline');
    assert.equal(meterStatus({}, now, thresholds).status, 'never');
    assert.equal(meterStatus({ last_received_at: minutesAgo(2) }, now, thresholds).ageSeconds, 120);
});

test('a recent rejected packet overrides the age status', () => {
    const result = meterStatus({
        last_received_at: minutesAgo(3),
        newest_received_at: minutesAgo(1),
        newest_parse_status: 'invalid',
        newest_parse_error: 'cycle.ts_utc is required',
    }, now, thresholds);
    assert.equal(result.status, 'rejected');
    assert.deepEqual(result.issues, ['cycle.ts_utc is required']);
});

test('an old rejected packet does not hide an offline meter', () => {
    const result = meterStatus({
        last_received_at: minutesAgo(120),
        newest_received_at: minutesAgo(90),
        newest_parse_status: 'invalid',
    }, now, thresholds);
    assert.equal(result.status, 'offline');
});

test('reports an invalid meter clock as an issue', () => {
    const result = meterStatus({ last_received_at: minutesAgo(1), meter_clock_valid: 0 }, now, thresholds);
    assert.equal(result.status, 'online');
    assert.deepEqual(result.issues, ['Meter clock invalid']);
});
