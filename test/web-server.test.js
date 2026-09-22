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
        assert.match(await page.text(), /AMR Meter Operations/);

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
