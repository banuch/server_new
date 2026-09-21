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
