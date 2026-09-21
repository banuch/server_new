'use strict';

const net = require('net');

const host = process.argv[2] || '127.0.0.1';
const port = Number(process.argv[3] || 5000);

const packet = {
    deviceId: 'ESP32-AMR-001',
    packetType: 'dlms-reading',
    meterTimestamp: new Date().toISOString(),
    readings: {
        voltage: 230.4,
        current: 4.82,
        activeEnergyKwh: 12845.73,
    },
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
