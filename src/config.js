'use strict';

const path = require('path');

function positiveInteger(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;

    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer`);
    }

    return value;
}

function loadConfig() {
    const port = positiveInteger('TCP_PORT', 5000);
    if (port > 65_535) throw new Error('TCP_PORT must be between 1 and 65535');

    return {
        host: process.env.TCP_HOST || '0.0.0.0',
        port,
        logDir: path.resolve(process.env.LOG_DIR || path.join(__dirname, '..', 'logs')),
        maxPacketBytes: positiveInteger('MAX_PACKET_BYTES', 256 * 1024),
        idleTimeoutMs: positiveInteger('IDLE_TIMEOUT_MS', 120_000),
    };
}

module.exports = { loadConfig };
