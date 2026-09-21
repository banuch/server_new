'use strict';

const net = require('net');

const host = process.argv[2] || '127.0.0.1';
const port = Number(process.argv[3] || 5000);

const packet = {
    schema_version: '2.1.0',
    device: {
        device_id: 'ESP32-AMR-001',
        meter_serial: 'TEST-METER-001',
        firmware: 'test-client',
        manufacturer: 'Test',
        mfr_year: 2026,
        utility: null,
    },
    cycle: {
        id: Date.now(),
        ts_utc: new Date().toISOString(),
        ts_ist: new Date().toISOString(),
        mode: 'test',
        meter_clock_valid: true,
    },
    config: { dlms: {}, meter: {} },
    readings: {
        instant: {
            ts: new Date().toISOString(),
            voltage: { l1_v: 230.4, l2_v: 231.1, l3_v: 229.9 },
            current: { l1_a: 4.82, l2_a: 4.75, l3_a: 4.91 },
            power_factor: { l1: 0.99, l2: 0.98, l3: 0.99, system: 0.99 },
            frequency_hz: 50,
            power: { active_import_w: 320, reactive_var: 0, apparent_import_va: 325 },
            counters: {},
        },
        energy: { active_import_wh: 12845730 },
        max_demand: {},
        tou: [],
    },
    billing: { history: [] },
    profiles: {},
    events: {},
    device_health: { modem: {} },
};

const socket = net.createConnection({ host, port }, () => {
    console.log(`Connected to ${host}:${port}`);
    socket.write(`${JSON.stringify(packet)}\n`);
});

socket.setEncoding('utf8');
socket.on('data', (data) => {
    console.log(`Server response: ${data.trim()}`);
    socket.end();
});
socket.on('error', (error) => console.error(`Client error: ${error.message}`));
socket.on('close', () => console.log('Connection closed'));
