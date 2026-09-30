'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { PacketLogger } = require('../src/packet-logger');

async function readLines(file) {
    return (await fs.readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
}

test('appends concurrent writes in order and splits files by day', async () => {
    const logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'amr-logger-'));
    const logger = new PacketLogger(logDir);

    await Promise.all(Array.from({ length: 200 }, (_, n) => logger.logPacket({
        receivedAt: '2026-09-21T23:59:59.000Z', n,
    })));
    await logger.logError({ receivedAt: '2026-09-21T23:59:59.500Z', reason: 'bad' });
    await logger.logPacket({ receivedAt: '2026-09-22T00:00:00.000Z', n: 200 });
    await logger.flush();

    const day1 = await readLines(path.join(logDir, 'dlms-2026-09-21.ndjson'));
    assert.deepEqual(day1.map((line) => line.n), Array.from({ length: 200 }, (_, n) => n));
    assert.equal(day1[0].type, 'packet');
    const day2 = await readLines(path.join(logDir, 'dlms-2026-09-22.ndjson'));
    assert.deepEqual(day2.map((line) => line.n), [200]);
    const errors = await readLines(path.join(logDir, 'errors-2026-09-21.ndjson'));
    assert.deepEqual(errors.map((line) => [line.type, line.reason]), [['error', 'bad']]);
});

test('reopens the file for writes after a flush', async () => {
    const logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'amr-logger-'));
    const logger = new PacketLogger(logDir);

    await logger.logPacket({ receivedAt: '2026-09-21T10:00:00.000Z', n: 1 });
    await logger.flush();
    await logger.logPacket({ receivedAt: '2026-09-21T10:00:01.000Z', n: 2 });
    await logger.flush();

    const lines = await readLines(path.join(logDir, 'dlms-2026-09-21.ndjson'));
    assert.deepEqual(lines.map((line) => line.n), [1, 2]);
});
