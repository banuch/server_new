'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const net = require('net');
const { PacketLogger } = require('../src/packet-logger');
const { createTcpServer } = require('../src/tcp-server');

const quietOutput = { log() {}, error() {} };

function collectLines(socket, expected) {
    return new Promise((resolve, reject) => {
        let buffer = '';
        const lines = [];

        socket.setEncoding('utf8');
        socket.on('data', (chunk) => {
            buffer += chunk;
            let newline;
            while ((newline = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 1);
                if (line) lines.push(JSON.parse(line));
                if (lines.length === expected) resolve(lines);
            }
        });
        socket.on('error', reject);
    });
}

test('logs fragmented and coalesced packets and rejects malformed JSON', async () => {
    const logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'amr-server-'));
    const logger = new PacketLogger(logDir);
    const app = createTcpServer({
        maxPacketBytes: 1024,
        idleTimeoutMs: 5_000,
    }, logger, quietOutput);

    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address();
    const socket = net.createConnection({ host: '127.0.0.1', port: address.port });
    const responsesPromise = collectLines(socket, 3);

    await new Promise((resolve) => socket.once('connect', resolve));
    socket.write('{"deviceId":"ESP');
    socket.write('32-1","value":10}\n{"deviceId":"ESP32-2"}\nnot-json\n');

    const responses = await responsesPromise;
    assert.deepEqual(responses.map((item) => item.status), ['success', 'success', 'error']);
    assert.equal(responses[2].code, 'INVALID_JSON');

    socket.end();
    await new Promise((resolve) => socket.once('close', resolve));
    await app.close();

    const files = await fs.readdir(logDir);
    const packetFile = files.find((file) => file.startsWith('dlms-'));
    const errorFile = files.find((file) => file.startsWith('errors-'));
    const packetLines = (await fs.readFile(path.join(logDir, packetFile), 'utf8')).trim().split('\n');
    const errorLines = (await fs.readFile(path.join(logDir, errorFile), 'utf8')).trim().split('\n');

    assert.equal(packetLines.length, 2);
    assert.equal(JSON.parse(packetLines[0]).packet.deviceId, 'ESP32-1');
    assert.equal(JSON.parse(packetLines[1]).packet.deviceId, 'ESP32-2');
    assert.equal(errorLines.length, 1);
    assert.equal(JSON.parse(errorLines[0]).raw, 'not-json');
});
