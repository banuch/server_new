'use strict';

const fs = require('fs');
const path = require('path');

const ENV_FILE = path.join(__dirname, '..', '.env');

function loadEnvFile(file = ENV_FILE) {
    let content;
    try {
        content = fs.readFileSync(file, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
    }

    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;

        const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!match) continue;

        const [, key, rawValue] = match;
        let value = rawValue.trim();

        if (
            value.length >= 2
            && ((value.startsWith('"') && value.endsWith('"'))
                || (value.startsWith("'") && value.endsWith("'")))
        ) {
            value = value.slice(1, -1);
        }

        // Values provided by the host environment take precedence over .env.
        if (process.env[key] === undefined) process.env[key] = value;
    }
}

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
    loadEnvFile();

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

module.exports = { loadConfig, loadEnvFile };
