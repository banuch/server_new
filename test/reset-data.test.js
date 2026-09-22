'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DATA_TABLES, resetData } = require('../src/database/reset-data');

test('reset truncates every application data table and preserves migration history', async () => {
    const queries = [];
    const connection = { async query(sql) { queries.push(sql); } };

    await resetData(connection);

    assert.equal(queries[0], 'SET FOREIGN_KEY_CHECKS = 0');
    assert.equal(queries.at(-1), 'SET FOREIGN_KEY_CHECKS = 1');
    assert.equal(queries.length, DATA_TABLES.length + 2);
    assert.equal(queries.some((sql) => sql.includes('schema_migrations')), false);
    for (const table of DATA_TABLES) {
        assert.equal(queries.includes(`TRUNCATE TABLE \`${table}\``), true);
    }
});

test('reset restores foreign key checks when a truncate fails', async () => {
    const queries = [];
    const connection = {
        async query(sql) {
            queries.push(sql);
            if (sql === 'TRUNCATE TABLE `meter_events`') throw new Error('truncate failed');
        },
    };

    await assert.rejects(resetData(connection), /truncate failed/);
    assert.equal(queries.at(-1), 'SET FOREIGN_KEY_CHECKS = 1');
});
