'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PacketRepository } = require('../src/database/packet-repository');

test('stores malformed JSON as an invalid packet receipt', async () => {
    const calls = [];
    const connection = {
        async beginTransaction() { calls.push('begin'); },
        async execute(sql, values) {
            calls.push({ sql, values });
            return [{ insertId: 44 }];
        },
        async commit() { calls.push('commit'); },
        async rollback() { calls.push('rollback'); },
        release() { calls.push('release'); },
    };
    const database = { async getConnection() { return connection; } };
    const repository = new PacketRepository(database);

    const result = await repository.savePacket({
        receivedAt: '2026-09-21T12:00:00.000Z',
        clientIp: '127.0.0.1',
        clientPort: 1234,
        bytes: 8,
        raw: 'not-json',
    });

    assert.equal(result.status, 'invalid');
    assert.equal(result.receiptId, 44);
    assert.equal(calls[0], 'begin');
    assert.equal(calls.at(-2), 'commit');
    assert.equal(calls.at(-1), 'release');
    assert.equal(calls.includes('rollback'), false);
    assert.equal(calls[1].values[6], 'invalid');
    assert.match(calls[1].values[7], /Unexpected token/);
});

test('rolls back and releases the connection when receipt storage fails', async () => {
    const calls = [];
    const connection = {
        async beginTransaction() { calls.push('begin'); },
        async execute() { throw new Error('database write failed'); },
        async commit() { calls.push('commit'); },
        async rollback() { calls.push('rollback'); },
        release() { calls.push('release'); },
    };
    const database = { async getConnection() { return connection; } };
    const repository = new PacketRepository(database);

    await assert.rejects(
        repository.savePacket({
            receivedAt: '2026-09-21T12:00:00.000Z',
            clientIp: '127.0.0.1',
            clientPort: 1234,
            bytes: 8,
            raw: 'not-json',
        }),
        /database write failed/,
    );

    assert.deepEqual(calls, ['begin', 'rollback', 'release']);
});
