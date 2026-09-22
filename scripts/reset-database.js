'use strict';

const mysql = require('mysql2/promise');
const { loadConfig } = require('../src/config');
const { DATA_TABLES, resetData } = require('../src/database/reset-data');

async function main() {
    if (!process.argv.includes('--confirm-reset')) {
        throw new Error(
            'Reset not confirmed. Run: npm run db:reset -- --confirm-reset',
        );
    }

    const config = loadConfig().mysql;
    if (!/^[A-Za-z0-9_]+$/.test(config.database)) {
        throw new Error('DB_NAME may contain only letters, numbers, and underscores');
    }

    const connection = await mysql.createConnection({
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
        timezone: 'Z',
    });

    try {
        await resetData(connection);
        console.log(
            `[DB] Reset complete: ${config.host}:${config.port}/${config.database} `
            + `(${DATA_TABLES.length} tables cleared; schema preserved)`,
        );
    } finally {
        await connection.end();
    }
}

main().catch((error) => {
    console.error(`[DB] Reset failed: ${error.message}`);
    process.exitCode = 1;
});
