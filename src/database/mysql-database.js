'use strict';

const mysql = require('mysql2/promise');
const { MIGRATIONS } = require('./schema');

class MysqlDatabase {
    constructor(config, output = console) {
        this.config = config;
        this.output = output;
        this.pool = null;
    }

    async initialize() {
        if (!/^[A-Za-z0-9_]+$/.test(this.config.database)) {
            throw new Error('DB_NAME may contain only letters, numbers, and underscores');
        }

        const bootstrap = await mysql.createConnection({
            host: this.config.host,
            port: this.config.port,
            user: this.config.user,
            password: this.config.password,
        });

        try {
            await bootstrap.query(
                `CREATE DATABASE IF NOT EXISTS \`${this.config.database}\` `
                + 'CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci',
            );
        } finally {
            await bootstrap.end();
        }

        this.pool = mysql.createPool({
            host: this.config.host,
            port: this.config.port,
            user: this.config.user,
            password: this.config.password,
            database: this.config.database,
            waitForConnections: true,
            connectionLimit: this.config.connectionLimit,
            queueLimit: 0,
            timezone: 'Z',
        });

        await this.pool.query('SELECT 1');
        await this.#migrate();
        this.output.log(`[DB] Ready: ${this.config.host}:${this.config.port}/${this.config.database}`);
    }

    async #migrate() {
        await this.pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
            version INT UNSIGNED NOT NULL,
            applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            PRIMARY KEY (version)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

        for (const migration of MIGRATIONS) {
            const [rows] = await this.pool.execute(
                'SELECT version FROM schema_migrations WHERE version = ?',
                [migration.version],
            );
            if (rows.length > 0) continue;

            for (const statement of migration.statements) await this.pool.query(statement);
            await this.pool.execute(
                'INSERT INTO schema_migrations (version) VALUES (?)',
                [migration.version],
            );
            this.output.log(`[DB] Applied schema migration ${migration.version}`);
        }
    }

    getConnection() {
        if (!this.pool) throw new Error('database is not initialized');
        return this.pool.getConnection();
    }

    execute(sql, values = []) {
        if (!this.pool) throw new Error('database is not initialized');
        return this.pool.execute(sql, values);
    }

    async close() {
        if (!this.pool) return;
        await this.pool.end();
        this.pool = null;
    }
}

module.exports = { MysqlDatabase };
