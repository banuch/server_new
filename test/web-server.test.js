'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWebServer } = require('../src/web-server');

async function start(repository) {
    const output = { log() {}, error() {} };
    const web = createWebServer(repository, output);
    await new Promise((resolve) => web.server.listen(0, '127.0.0.1', resolve));
    const { port } = web.server.address();
    return { web, baseUrl: `http://127.0.0.1:${port}` };
}

test('serves the dashboard and REST packet results', async () => {
    const repository = {
        async getPackets() { return { rows: [{ id: 1 }], pagination: { total: 1 } }; },
        async getStats() { return { summary: {}, chart: { series: [] } }; },
        async getSummary() { return { total_packets_today: 4 }; },
        async getPacket() { return { id: 1, raw_payload: '{}' }; },
        async getDevices() { return [{ device_uid: 'MRI-001' }]; },
        async getDeviceOverview() { return { device_uid: 'MRI-001', voltage_l1_v: 230 }; },
        async getBlockLoad() { return { rows: [], pagination: { total: 0 } }; },
        async getDailyLoad() { return { rows: [], pagination: { total: 0 } }; },
        async getBilling() { return { current: null, history: [], pagination: { total: 0 } }; },
        async getEvents() { return { rows: [], pagination: { total: 0 } }; },
    };
    const { web, baseUrl } = await start(repository);
    try {
        const page = await fetch(baseUrl);
        assert.equal(page.status, 200);
        assert.match(await page.text(), /AMR Meter Monitoring/);

        const script = await fetch(`${baseUrl}/js/main.js`);
        assert.equal(script.status, 200);
        assert.match(script.headers.get('content-type'), /javascript/);

        const packets = await fetch(`${baseUrl}/api/packets`).then((response) => response.json());
        assert.equal(packets.rows[0].id, 1);

        const summary = await fetch(`${baseUrl}/api/summary`).then((response) => response.json());
        assert.equal(summary.total_packets_today, 4);

        const overview = await fetch(`${baseUrl}/api/devices/MRI-001/overview`).then((response) => response.json());
        assert.equal(overview.voltage_l1_v, 230);

        const events = await fetch(`${baseUrl}/api/devices/MRI-001/events`).then((response) => response.json());
        assert.deepEqual(events.rows, []);
    } finally {
        await web.close();
    }
});

test('serves fleet, meter list, energy, and chart series without caching', async () => {
    const calls = [];
    const repository = {
        async getFleet() { return { counts: { total: 2 } }; },
        async getMeters(input) { calls.push(['meters', input]); return { rows: [], counts: {} }; },
        async getEnergy(id) { calls.push(['energy', id]); return { maxDemand: {}, tou: [] }; },
        async getEventLogs() { return ['event_log_1']; },
        async getLoadProfileSeries(type, id) { calls.push(['series', type, id]); return { rows: [] }; },
    };
    const output = { log() {}, error() {} };
    const web = createWebServer(repository, output, { timeZone: 'UTC', onlineAfterSeconds: 600, offlineAfterSeconds: 1800 });
    await new Promise((resolve) => web.server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${web.server.address().port}`;
    try {
        const fleet = await fetch(`${baseUrl}/api/fleet`);
        assert.equal(fleet.headers.get('cache-control'), 'no-store');
        assert.equal((await fleet.json()).counts.total, 2);

        const config = await fetch(`${baseUrl}/api/config`).then((response) => response.json());
        assert.deepEqual(config, { timeZone: 'UTC', onlineAfterSeconds: 600, offlineAfterSeconds: 1800 });

        await fetch(`${baseUrl}/api/meters?status=offline`);
        await fetch(`${baseUrl}/api/devices/MRI-001/energy`);
        await fetch(`${baseUrl}/api/devices/MRI-001/daily-load/series`);
        const logs = await fetch(`${baseUrl}/api/devices/MRI-001/event-logs`).then((response) => response.json());

        assert.equal(calls[0][1].status, 'offline');
        assert.deepEqual(calls[1], ['energy', 'MRI-001']);
        assert.deepEqual(calls[2], ['series', 'daily', 'MRI-001']);
        assert.deepEqual(logs, { logs: ['event_log_1'] });
    } finally {
        await web.close();
    }
});

test('returns clear JSON errors for validation and missing packets', async () => {
    const repository = {
        async getPackets() { throw new RangeError('page is invalid'); },
        async getStats() { return {}; },
        async getSummary() { return {}; },
        async getPacket() { return null; },
        async getDevices() { return []; },
        async getDeviceOverview() { return null; },
    };
    const { web, baseUrl } = await start(repository);
    try {
        const invalid = await fetch(`${baseUrl}/api/packets`);
        assert.equal(invalid.status, 400);
        assert.deepEqual(await invalid.json(), { error: 'page is invalid' });

        const missing = await fetch(`${baseUrl}/api/packets/99`);
        assert.equal(missing.status, 404);

        const missingDevice = await fetch(`${baseUrl}/api/devices/unknown/overview`);
        assert.equal(missingDevice.status, 404);
    } finally {
        await web.close();
    }
});
