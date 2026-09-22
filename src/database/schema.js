'use strict';

const TABLE_STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS devices (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        device_uid VARCHAR(64) NOT NULL,
        meter_serial VARCHAR(64) NULL,
        firmware VARCHAR(64) NULL,
        manufacturer VARCHAR(128) NULL,
        manufacture_year SMALLINT UNSIGNED NULL,
        utility VARCHAR(128) NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        UNIQUE KEY uq_devices_uid (device_uid),
        KEY idx_devices_meter_serial (meter_serial)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS packet_receipts (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        received_at DATETIME(3) NOT NULL,
        client_ip VARCHAR(64) NULL,
        client_port INT UNSIGNED NULL,
        byte_count INT UNSIGNED NOT NULL,
        payload_sha256 CHAR(64) NOT NULL,
        raw_payload LONGTEXT NOT NULL,
        parse_status VARCHAR(16) NOT NULL,
        parse_error TEXT NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        KEY idx_receipts_received (received_at),
        KEY idx_receipts_hash (payload_sha256),
        KEY idx_receipts_status (parse_status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS measurement_cycles (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        device_id BIGINT UNSIGNED NOT NULL,
        schema_version VARCHAR(16) NOT NULL,
        device_cycle_number BIGINT NOT NULL,
        meter_ts_utc DATETIME(3) NOT NULL,
        timezone_offset_minutes SMALLINT NULL,
        mode VARCHAR(24) NULL,
        meter_clock_valid BOOLEAN NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        UNIQUE KEY uq_cycle_identity (device_id, device_cycle_number, meter_ts_utc),
        KEY idx_cycles_meter_ts (device_id, meter_ts_utc),
        CONSTRAINT fk_cycles_device FOREIGN KEY (device_id) REFERENCES devices(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS packet_cycle_links (
        receipt_id BIGINT UNSIGNED NOT NULL,
        cycle_id BIGINT UNSIGNED NOT NULL,
        PRIMARY KEY (receipt_id),
        KEY idx_packet_cycle_cycle (cycle_id),
        CONSTRAINT fk_packet_cycle_receipt FOREIGN KEY (receipt_id) REFERENCES packet_receipts(id) ON DELETE CASCADE,
        CONSTRAINT fk_packet_cycle_cycle FOREIGN KEY (cycle_id) REFERENCES measurement_cycles(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS cycle_configs (
        cycle_id BIGINT UNSIGNED NOT NULL,
        client_sap INT NULL, server_address INT NULL, auth_mode VARCHAR(24) NULL, baud INT NULL,
        uart_rx INT NULL, uart_tx INT NULL, uart_dtr INT NULL,
        ct_ratio DECIMAL(18,6) NULL, active_meter_constant DECIMAL(24,9) NULL,
        reactive_meter_constant DECIMAL(24,9) NULL, integration_period_seconds INT NULL,
        profile_entry_period_seconds INT NULL, sanction_load_w DECIMAL(24,6) NULL,
        contracted_demand_wh DECIMAL(24,6) NULL, tod_enabled BOOLEAN NULL,
        tod_zones_count INT NULL, tod_schedule JSON NULL, programming_count INT NULL,
        manufacturer_config_a VARCHAR(128) NULL, manufacturer_config_b VARCHAR(128) NULL,
        PRIMARY KEY (cycle_id),
        CONSTRAINT fk_cycle_configs_cycle FOREIGN KEY (cycle_id) REFERENCES measurement_cycles(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS instant_readings (
        cycle_id BIGINT UNSIGNED NOT NULL, reading_ts_utc DATETIME(3) NULL,
        voltage_l1_v DECIMAL(18,6) NULL, voltage_l2_v DECIMAL(18,6) NULL, voltage_l3_v DECIMAL(18,6) NULL,
        current_l1_a DECIMAL(18,6) NULL, current_l2_a DECIMAL(18,6) NULL, current_l3_a DECIMAL(18,6) NULL,
        power_factor_l1 DECIMAL(12,6) NULL, power_factor_l2 DECIMAL(12,6) NULL,
        power_factor_l3 DECIMAL(12,6) NULL, power_factor_system DECIMAL(12,6) NULL,
        frequency_hz DECIMAL(12,6) NULL, active_import_w DECIMAL(24,6) NULL,
        reactive_var DECIMAL(24,6) NULL, apparent_import_va DECIMAL(24,6) NULL,
        power_failure_count BIGINT NULL, power_failure_duration_minutes BIGINT NULL,
        tamper_count BIGINT NULL, billing_count BIGINT NULL, billing_date_utc DATETIME(3) NULL,
        PRIMARY KEY (cycle_id),
        CONSTRAINT fk_instant_cycle FOREIGN KEY (cycle_id) REFERENCES measurement_cycles(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS energy_readings (
        cycle_id BIGINT UNSIGNED NOT NULL, as_of_utc DATETIME(3) NULL,
        active_import_wh DECIMAL(28,6) NULL, reactive_qi_lag_varh DECIMAL(28,6) NULL,
        reactive_qiii_lead_varh DECIMAL(28,6) NULL, apparent_import_vah DECIMAL(28,6) NULL,
        PRIMARY KEY (cycle_id),
        CONSTRAINT fk_energy_cycle FOREIGN KEY (cycle_id) REFERENCES measurement_cycles(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS max_demand_readings (
        cycle_id BIGINT UNSIGNED NOT NULL, demand_type VARCHAR(24) NOT NULL,
        active_demand_w DECIMAL(24,6) NULL, active_demand_ts_utc DATETIME(3) NULL,
        apparent_demand_va DECIMAL(24,6) NULL, apparent_demand_ts_utc DATETIME(3) NULL,
        PRIMARY KEY (cycle_id, demand_type),
        CONSTRAINT fk_max_demand_cycle FOREIGN KEY (cycle_id) REFERENCES measurement_cycles(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS tou_readings (
        cycle_id BIGINT UNSIGNED NOT NULL, zone_number SMALLINT UNSIGNED NOT NULL,
        energy_kwh DECIMAL(28,6) NULL, apparent_energy_kvah DECIMAL(28,6) NULL,
        max_demand_w DECIMAL(24,6) NULL, max_demand_ts_utc DATETIME(3) NULL,
        max_apparent_demand_va DECIMAL(24,6) NULL, max_apparent_demand_ts_utc DATETIME(3) NULL,
        PRIMARY KEY (cycle_id, zone_number),
        CONSTRAINT fk_tou_cycle FOREIGN KEY (cycle_id) REFERENCES measurement_cycles(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS billing_current (
        cycle_id BIGINT UNSIGNED NOT NULL, billing_ts_utc DATETIME(3) NULL,
        system_power_factor DECIMAL(12,6) NULL, active_import_wh DECIMAL(28,6) NULL,
        reactive_qi_lag_varh DECIMAL(28,6) NULL, reactive_qiii_lead_varh DECIMAL(28,6) NULL,
        apparent_import_vah DECIMAL(28,6) NULL, cumulative_duration_minutes BIGINT NULL,
        PRIMARY KEY (cycle_id),
        CONSTRAINT fk_billing_current_cycle FOREIGN KEY (cycle_id) REFERENCES measurement_cycles(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS billing_history (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, device_id BIGINT UNSIGNED NOT NULL,
        billing_cycle_number BIGINT NOT NULL, billing_date_utc DATETIME(3) NOT NULL,
        active_import_wh DECIMAL(28,6) NULL, apparent_import_vah DECIMAL(28,6) NULL,
        reactive_qi_varh DECIMAL(28,6) NULL, reactive_qiii_varh DECIMAL(28,6) NULL,
        system_power_factor DECIMAL(12,6) NULL, cumulative_duration_minutes BIGINT NULL,
        max_demand_w DECIMAL(24,6) NULL, max_apparent_demand_va DECIMAL(24,6) NULL,
        last_seen_cycle_id BIGINT UNSIGNED NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_billing_history (device_id, billing_cycle_number, billing_date_utc),
        CONSTRAINT fk_billing_history_device FOREIGN KEY (device_id) REFERENCES devices(id),
        CONSTRAINT fk_billing_history_seen_cycle FOREIGN KEY (last_seen_cycle_id) REFERENCES measurement_cycles(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS profile_snapshots (
        cycle_id BIGINT UNSIGNED NOT NULL, profile_type VARCHAR(24) NOT NULL, obis VARCHAR(32) NULL,
        entries_in_use BIGINT NULL, profile_capacity BIGINT NULL, rows_returned BIGINT NULL,
        interval_minutes INT NULL, buffer_full BOOLEAN NULL, note TEXT NULL,
        PRIMARY KEY (cycle_id, profile_type),
        CONSTRAINT fk_profile_snapshot_cycle FOREIGN KEY (cycle_id) REFERENCES measurement_cycles(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS block_load_entries (
        device_id BIGINT UNSIGNED NOT NULL, reading_ts_utc DATETIME(3) NOT NULL,
        current_l1_a DECIMAL(18,6) NULL, current_l2_a DECIMAL(18,6) NULL, current_l3_a DECIMAL(18,6) NULL,
        voltage_l1_v DECIMAL(18,6) NULL, voltage_l2_v DECIMAL(18,6) NULL, voltage_l3_v DECIMAL(18,6) NULL,
        active_energy_wh DECIMAL(28,6) NULL, reactive_lag_varh DECIMAL(28,6) NULL,
        reactive_lead_varh DECIMAL(28,6) NULL, apparent_energy_vah DECIMAL(28,6) NULL,
        last_seen_cycle_id BIGINT UNSIGNED NOT NULL,
        PRIMARY KEY (device_id, reading_ts_utc),
        CONSTRAINT fk_block_load_device FOREIGN KEY (device_id) REFERENCES devices(id),
        CONSTRAINT fk_block_load_seen_cycle FOREIGN KEY (last_seen_cycle_id) REFERENCES measurement_cycles(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS daily_load_entries (
        device_id BIGINT UNSIGNED NOT NULL, reading_ts_utc DATETIME(3) NOT NULL,
        active_energy_wh DECIMAL(28,6) NULL, reactive_qi_varh DECIMAL(28,6) NULL,
        reactive_qiii_varh DECIMAL(28,6) NULL, apparent_energy_vah DECIMAL(28,6) NULL,
        on_minutes BIGINT NULL, off_minutes BIGINT NULL, missing_minutes BIGINT NULL,
        last_seen_cycle_id BIGINT UNSIGNED NOT NULL,
        PRIMARY KEY (device_id, reading_ts_utc),
        CONSTRAINT fk_daily_load_device FOREIGN KEY (device_id) REFERENCES devices(id),
        CONSTRAINT fk_daily_load_seen_cycle FOREIGN KEY (last_seen_cycle_id) REFERENCES measurement_cycles(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS event_profile_snapshots (
        cycle_id BIGINT UNSIGNED NOT NULL, event_log_key VARCHAR(32) NOT NULL, obis VARCHAR(32) NULL,
        rows_returned BIGINT NULL, entries_in_use BIGINT NULL, profile_capacity BIGINT NULL,
        PRIMARY KEY (cycle_id, event_log_key),
        CONSTRAINT fk_event_profile_cycle FOREIGN KEY (cycle_id) REFERENCES measurement_cycles(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS meter_events (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, device_id BIGINT UNSIGNED NOT NULL,
        event_log_key VARCHAR(32) NOT NULL, event_ts_utc DATETIME(3) NOT NULL, event_code INT NOT NULL,
        last_seen_cycle_id BIGINT UNSIGNED NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_meter_event (device_id, event_log_key, event_ts_utc, event_code),
        CONSTRAINT fk_meter_event_device FOREIGN KEY (device_id) REFERENCES devices(id),
        CONSTRAINT fk_meter_event_seen_cycle FOREIGN KEY (last_seen_cycle_id) REFERENCES measurement_cycles(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS event_measurements (
        event_id BIGINT UNSIGNED NOT NULL,
        current_l1_a DECIMAL(18,6) NULL, current_l2_a DECIMAL(18,6) NULL, current_l3_a DECIMAL(18,6) NULL,
        voltage_l1_v DECIMAL(18,6) NULL, voltage_l2_v DECIMAL(18,6) NULL, voltage_l3_v DECIMAL(18,6) NULL,
        power_factor_l1 DECIMAL(12,6) NULL, power_factor_l2 DECIMAL(12,6) NULL, power_factor_l3 DECIMAL(12,6) NULL,
        active_import_wh DECIMAL(28,6) NULL, apparent_import_vah DECIMAL(28,6) NULL,
        PRIMARY KEY (event_id),
        CONSTRAINT fk_event_measurement_event FOREIGN KEY (event_id) REFERENCES meter_events(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS device_health (
        cycle_id BIGINT UNSIGNED NOT NULL, health_ts_utc DATETIME(3) NULL, firmware VARCHAR(64) NULL,
        heap_free_bytes BIGINT UNSIGNED NULL, psram_free_bytes BIGINT UNSIGNED NULL,
        total_objects_read BIGINT UNSIGNED NULL, total_errors BIGINT UNSIGNED NULL,
        reconnects BIGINT UNSIGNED NULL, dlms_cycles BIGINT UNSIGNED NULL,
        PRIMARY KEY (cycle_id),
        CONSTRAINT fk_device_health_cycle FOREIGN KEY (cycle_id) REFERENCES measurement_cycles(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS modem_health (
        cycle_id BIGINT UNSIGNED NOT NULL, firmware VARCHAR(64) NULL, sim_status VARCHAR(32) NULL,
        csq INT NULL, network_attached BOOLEAN NULL, registration_status VARCHAR(32) NULL,
        last_send_success_seconds BIGINT NULL, server_configured BOOLEAN NULL,
        PRIMARY KEY (cycle_id),
        CONSTRAINT fk_modem_health_cycle FOREIGN KEY (cycle_id) REFERENCES measurement_cycles(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

const MIGRATIONS = [
    { version: 1, statements: TABLE_STATEMENTS },
    {
        version: 2,
        statements: [
            `CREATE TABLE IF NOT EXISTS profile_units (
                cycle_id BIGINT UNSIGNED NOT NULL,
                profile_type VARCHAR(24) NOT NULL,
                measurement_key VARCHAR(64) NOT NULL,
                unit_symbol VARCHAR(32) NOT NULL,
                PRIMARY KEY (cycle_id, profile_type, measurement_key),
                CONSTRAINT fk_profile_unit_snapshot
                    FOREIGN KEY (cycle_id, profile_type)
                    REFERENCES profile_snapshots(cycle_id, profile_type)
                    ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
        ],
    },
    {
        version: 3,
        statements: [
            `ALTER TABLE packet_receipts
             ADD COLUMN source_device_uid VARCHAR(64) NULL AFTER parse_error,
             ADD KEY idx_receipts_source_device (source_device_uid)`,
        ],
    },
    {
        version: 4,
        statements: [
            'ALTER TABLE billing_history ADD KEY idx_billing_device_date (device_id, billing_date_utc)',
            'ALTER TABLE meter_events ADD KEY idx_events_device_time (device_id, event_ts_utc)',
        ],
    },
];

module.exports = { MIGRATIONS };
