'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadEnvFile } = require('../src/config');

test('loads values from an env file without replacing host environment values', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-env-'));
    const file = path.join(directory, '.env');
    const keys = ['AMR_TEST_PORT', 'AMR_TEST_HOST', 'AMR_TEST_OVERRIDE'];

    fs.writeFileSync(file, [
        '# comment',
        'AMR_TEST_PORT=7000',
        'AMR_TEST_HOST="127.0.0.1"',
        'AMR_TEST_OVERRIDE=from-file',
    ].join('\n'));

    process.env.AMR_TEST_OVERRIDE = 'from-host';

    try {
        loadEnvFile(file);
        assert.equal(process.env.AMR_TEST_PORT, '7000');
        assert.equal(process.env.AMR_TEST_HOST, '127.0.0.1');
        assert.equal(process.env.AMR_TEST_OVERRIDE, 'from-host');
    } finally {
        for (const key of keys) delete process.env[key];
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('sizes the ingestion and dashboard database pools separately', () => {
    const keys = ['DB_CONNECTION_LIMIT', 'DB_WEB_CONNECTION_LIMIT'];
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    const { loadConfig } = require('../src/config');

    try {
        process.env.DB_CONNECTION_LIMIT = '12';
        process.env.DB_WEB_CONNECTION_LIMIT = '3';
        const { mysql } = loadConfig();
        assert.equal(mysql.connectionLimit, 12);
        assert.equal(mysql.webConnectionLimit, 3);

        process.env.DB_WEB_CONNECTION_LIMIT = '0';
        assert.throws(() => loadConfig(), /DB_WEB_CONNECTION_LIMIT must be a positive integer/);
    } finally {
        for (const key of keys) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
    }
});
