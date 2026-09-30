'use strict';

const path = require('path');
const { loadConfig } = require('./config');
const { supervise } = require('./supervisor');

// Runs TCP ingestion and the dashboard as separate processes. Either one can
// crash or restart without affecting the other; `npm run start:ingest` and
// `npm run start:dashboard` run them individually instead.
function main() {
    // Fail fast on invalid settings instead of restarting children forever.
    loadConfig();

    const supervisor = supervise([
        { name: 'ingest', file: path.join(__dirname, 'ingest.js') },
        { name: 'dashboard', file: path.join(__dirname, 'dashboard.js') },
    ]);

    let shuttingDown = false;
    async function shutdown(signal) {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`[SUPERVISOR] ${signal} received; stopping services`);
        await supervisor.stop();
        process.exitCode = 0;
    }

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

try {
    main();
} catch (error) {
    console.error(`[APP] Startup failed: ${error.message}`);
    process.exitCode = 1;
}
