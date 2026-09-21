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
        async getPacket() { return { id: 1, raw_payload: '{}' }; },
        async getDevices() { return [{ device_uid: 'MRI-001' }]; },
    };
    const { web, baseUrl } = await start(repository);
    try {
        const page = await fetch(baseUrl);
        assert.equal(page.status, 200);
        assert.match(await page.text(), /AMR Grid Monitor/);

        const packets = await fetch(`${baseUrl}/api/packets`).then((response) => response.json());
        assert.equal(packets.rows[0].id, 1);
    } finally {
        await web.close();
    }
});

test('returns clear JSON errors for validation and missing packets', async () => {
    const repository = {
        async getPackets() { throw new RangeError('page is invalid'); },
        async getStats() { return {}; },
        async getPacket() { return null; },
        async getDevices() { return []; },
    };
    const { web, baseUrl } = await start(repository);
    try {
        const invalid = await fetch(`${baseUrl}/api/packets`);
        assert.equal(invalid.status, 400);
        assert.deepEqual(await invalid.json(), { error: 'page is invalid' });

        const missing = await fetch(`${baseUrl}/api/packets/99`);
        assert.equal(missing.status, 404);
    } finally {
        await web.close();
    }
});
