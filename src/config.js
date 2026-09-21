'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const ENV_FILE = path.join(__dirname, '..', '.env');

function loadEnvFile(file = ENV_FILE) {
    if (!fs.existsSync(file)) return;
    const result = dotenv.config({ path: file, override: false, quiet: true });
    if (result.error) throw result.error;
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
    const webPort = positiveInteger('WEB_PORT', 3000);
    if (webPort > 65_535) throw new Error('WEB_PORT must be between 1 and 65535');

    return {
        host: process.env.TCP_HOST || '0.0.0.0',
        port,
        webHost: process.env.WEB_HOST || '0.0.0.0',
        webPort,
        logDir: path.resolve(process.env.LOG_DIR || path.join(__dirname, '..', 'logs')),
        maxPacketBytes: positiveInteger('MAX_PACKET_BYTES', 256 * 1024),
        idleTimeoutMs: positiveInteger('IDLE_TIMEOUT_MS', 120_000),
        mysql: {
            host: process.env.DB_HOST || '127.0.0.1',
            port: positiveInteger('DB_PORT', 3306),
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            database: process.env.DB_NAME || 'amr_tcp_server',
            connectionLimit: positiveInteger('DB_CONNECTION_LIMIT', 10),
        },
    };
}

module.exports = { loadConfig, loadEnvFile };
