'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { supervise } = require('../src/supervisor');

const CHILD = `
const fs = require('fs');
const [marker, crashes] = process.argv.slice(2);
const starts = fs.existsSync(marker) ? Number(fs.readFileSync(marker, 'utf8')) + 1 : 1;
fs.writeFileSync(marker, String(starts));
if (starts <= Number(crashes)) process.exit(3);
const keepAlive = setInterval(() => {}, 1000);
process.on('message', (message) => {
    if (message !== 'shutdown') return;
    clearInterval(keepAlive);
    process.disconnect();
});
`;

async function waitFor(check, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline) throw new Error('timed out');
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

test('restarts only the crashed service and stops all services on shutdown', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-supervisor-'));
    const script = path.join(directory, 'child.js');
    fs.writeFileSync(script, CHILD);
    const crashingMarker = path.join(directory, 'crashing');
    const stableMarker = path.join(directory, 'stable');
    const messages = [];

    const supervisor = supervise([
        { name: 'crashing', file: script, args: [crashingMarker, '2'] },
        { name: 'stable', file: script, args: [stableMarker, '0'] },
    ], { minRestartDelayMs: 10, maxRestartDelayMs: 50 }, {
        error: (message) => messages.push(message),
    });

    try {
        await waitFor(() => fs.existsSync(stableMarker) && supervisor.children.has('stable'));
        const stablePid = supervisor.children.get('stable').pid;

        await waitFor(() => fs.existsSync(crashingMarker)
            && fs.readFileSync(crashingMarker, 'utf8') === '3'
            && supervisor.children.has('crashing'));

        assert.equal(messages.filter((message) => message.includes('crashing exited (code 3)')).length, 2);
        assert.equal(supervisor.children.get('stable').pid, stablePid);
        assert.equal(fs.readFileSync(stableMarker, 'utf8'), '1');

        const running = [...supervisor.children.values()];
        await supervisor.stop();
        assert.ok(running.every((child) => child.exitCode === 0));
        assert.equal(supervisor.children.size, 0);
    } finally {
        await supervisor.stop();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
