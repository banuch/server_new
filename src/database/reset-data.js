'use strict';

// Application-owned data tables only. schema_migrations is deliberately kept
// so the existing database structure remains ready for the next test run.
const DATA_TABLES = [
    'event_measurements',
    'meter_events',
    'event_profile_snapshots',
    'profile_units',
    'block_load_entries',
    'daily_load_entries',
    'profile_snapshots',
    'billing_history',
    'billing_current',
    'tou_readings',
    'max_demand_readings',
    'energy_readings',
    'instant_readings',
    'modem_health',
    'device_health',
    'cycle_configs',
    'packet_cycle_links',
    'measurement_cycles',
    'packet_receipts',
    'devices',
];

async function resetData(connection) {
    await connection.query('SET FOREIGN_KEY_CHECKS = 0');
    try {
        for (const table of DATA_TABLES) {
            await connection.query(`TRUNCATE TABLE \`${table}\``);
        }
    } finally {
        await connection.query('SET FOREIGN_KEY_CHECKS = 1');
    }
}

module.exports = { DATA_TABLES, resetData };
