'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const net = require('net');
const { PacketLogger } = require('../src/packet-logger');
const { createTcpServer } = require('../src/tcp-server');

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

test('logs fragmented and coalesced lines without parsing their contents', async () => {
    const logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'amr-server-'));
    const logger = new PacketLogger(logDir);
    const terminalLines = [];
    const output = {
        log(message) { terminalLines.push(message); },
        error(message) { terminalLines.push(message); },
    };
    const app = createTcpServer({
        maxPacketBytes: 1024,
        idleTimeoutMs: 5_000,
    }, logger, output);

    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address();
    const socket = net.createConnection({ host: '127.0.0.1', port: address.port });
    const responsesPromise = collectLines(socket, 3);

    await new Promise((resolve) => socket.once('connect', resolve));
    socket.write('{"deviceId":"ESP');
    socket.write('32-1","value":10}\n{"deviceId":"ESP32-2"}\nnot-json\n');

    const responses = await responsesPromise;
    assert.deepEqual(responses.map((item) => item.status), ['success', 'success', 'success']);

    socket.end();
    await new Promise((resolve) => socket.once('close', resolve));
    await app.close();

    const files = await fs.readdir(logDir);
    const packetFile = files.find((file) => file.startsWith('dlms-'));
    const packetLines = (await fs.readFile(path.join(logDir, packetFile), 'utf8')).trim().split('\n');

    assert.equal(packetLines.length, 3);
    assert.equal(JSON.parse(packetLines[0]).raw, '{"deviceId":"ESP32-1","value":10}');
    assert.equal(JSON.parse(packetLines[1]).raw, '{"deviceId":"ESP32-2"}');
    assert.equal(JSON.parse(packetLines[2]).raw, 'not-json');
    assert.equal(files.some((file) => file.startsWith('errors-')), false);
    assert.equal(terminalLines.some((line) => line.includes('[PACKET] Logged')), true);
    assert.equal(terminalLines.some((line) => line.includes('ESP32-1')), false);
    assert.equal(terminalLines.some((line) => line.includes('not-json')), false);
});
