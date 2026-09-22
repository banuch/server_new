'use strict';

const crypto = require('crypto');
const { parseDlmsPacket, mysqlDate, timezoneOffsetMinutes, nullable } = require('../dlms-packet');

function eventCode(entry) {
    if (entry.event_code !== undefined && entry.event_code !== null) return entry.event_code;
    const legacyKey = Object.keys(entry).find((key) => key.endsWith('_event_count'));
    return legacyKey ? entry[legacyKey] : -1;
}

function transportDeviceId(record) {
    if (record.deviceId) return record.deviceId;
    if (!record.clientIp) return null;
    const address = String(record.clientIp).replace(/^::ffff:/, '');
    return `tcp:${address}`;
}

class PacketRepository {
    constructor(database) {
        this.database = database;
    }

    async savePacket(record) {
        let parsed;
        let parseError = null;
        try {
            parsed = parseDlmsPacket(record.raw, { deviceId: transportDeviceId(record) });
        } catch (error) {
            parseError = error;
        }

        const connection = await this.database.getConnection();
        try {
            await connection.beginTransaction();
            const receiptId = await this.#insertReceipt(connection, record, parseError);

            if (parseError) {
                await connection.commit();
                return { status: 'invalid', receiptId, error: parseError.message };
            }

            const payload = parsed.payload;
            const deviceId = await this.#upsertDevice(connection, payload.device);
            const cycleId = await this.#upsertCycle(connection, deviceId, payload);

            await connection.execute(
                'INSERT INTO packet_cycle_links (receipt_id, cycle_id) VALUES (?, ?)',
                [receiptId, cycleId],
            );

            await this.#saveConfig(connection, cycleId, payload.config || {});
            await this.#saveReadings(connection, cycleId, payload.readings || {});
            await this.#saveBilling(connection, deviceId, cycleId, payload.billing || {});
            await this.#saveProfiles(connection, deviceId, cycleId, payload.profiles || {});
            await this.#saveEvents(connection, deviceId, cycleId, payload.events || {});
            await this.#saveHealth(connection, cycleId, payload.device_health || {});

            await connection.commit();
            return {
                status: 'success',
                receiptId,
                cycleId,
                deviceId: payload.device.device_id,
                deviceCycleId: payload.cycle.id,
            };
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    async #insertReceipt(connection, record, parseError) {
        const hash = crypto.createHash('sha256').update(record.raw, 'utf8').digest('hex');
        const [result] = await connection.execute(
            `INSERT INTO packet_receipts
                (received_at, client_ip, client_port, byte_count, payload_sha256,
                 raw_payload, parse_status, parse_error)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                mysqlDate(record.receivedAt), nullable(record.clientIp), nullable(record.clientPort),
                record.bytes, hash, record.raw, parseError ? 'invalid' : 'valid',
                parseError ? parseError.message : null,
            ],
        );
        return result.insertId;
    }

    async #upsertDevice(connection, device) {
        const [result] = await connection.execute(
            `INSERT INTO devices
                (device_uid, meter_serial, firmware, manufacturer, manufacture_year, utility)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                id = LAST_INSERT_ID(id), meter_serial = VALUES(meter_serial),
                firmware = VALUES(firmware), manufacturer = VALUES(manufacturer),
                manufacture_year = VALUES(manufacture_year), utility = VALUES(utility)`,
            [device.device_id, nullable(device.meter_serial), nullable(device.firmware),
                nullable(device.manufacturer), nullable(device.mfr_year), nullable(device.utility)],
        );
        return result.insertId;
    }

    async #upsertCycle(connection, deviceId, payload) {
        const cycle = payload.cycle;
        const [result] = await connection.execute(
            `INSERT INTO measurement_cycles
                (device_id, schema_version, device_cycle_number, meter_ts_utc,
                 timezone_offset_minutes, mode, meter_clock_valid)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                id = LAST_INSERT_ID(id), schema_version = VALUES(schema_version),
                timezone_offset_minutes = VALUES(timezone_offset_minutes), mode = VALUES(mode),
                meter_clock_valid = VALUES(meter_clock_valid)`,
            [deviceId, payload.schema_version, cycle.id, mysqlDate(cycle.ts_utc),
                timezoneOffsetMinutes(cycle.ts_ist), nullable(cycle.mode), nullable(cycle.meter_clock_valid)],
        );
        return result.insertId;
    }

    async #saveConfig(connection, cycleId, config) {
        const dlms = config.dlms || {};
        const meter = config.meter || {};
        await connection.execute(
            `INSERT INTO cycle_configs
                (cycle_id, client_sap, server_address, auth_mode, baud, uart_rx, uart_tx, uart_dtr,
                 ct_ratio, active_meter_constant, reactive_meter_constant, integration_period_seconds,
                 profile_entry_period_seconds, sanction_load_w, contracted_demand_wh, tod_enabled,
                 tod_zones_count, tod_schedule, programming_count, manufacturer_config_a, manufacturer_config_b)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                client_sap=VALUES(client_sap), server_address=VALUES(server_address), auth_mode=VALUES(auth_mode),
                baud=VALUES(baud), uart_rx=VALUES(uart_rx), uart_tx=VALUES(uart_tx), uart_dtr=VALUES(uart_dtr),
                ct_ratio=VALUES(ct_ratio), active_meter_constant=VALUES(active_meter_constant),
                reactive_meter_constant=VALUES(reactive_meter_constant),
                integration_period_seconds=VALUES(integration_period_seconds),
                profile_entry_period_seconds=VALUES(profile_entry_period_seconds), sanction_load_w=VALUES(sanction_load_w),
                contracted_demand_wh=VALUES(contracted_demand_wh), tod_enabled=VALUES(tod_enabled),
                tod_zones_count=VALUES(tod_zones_count), tod_schedule=VALUES(tod_schedule),
                programming_count=VALUES(programming_count), manufacturer_config_a=VALUES(manufacturer_config_a),
                manufacturer_config_b=VALUES(manufacturer_config_b)`,
            [cycleId, nullable(dlms.client_sap), nullable(dlms.server_addr), nullable(dlms.auth_mode),
                nullable(dlms.baud), nullable(dlms.uart_rx), nullable(dlms.uart_tx), nullable(dlms.uart_dtr),
                nullable(meter.ct_ratio), nullable(meter.active_meter_constant), nullable(meter.reactive_meter_constant),
                nullable(meter.integration_period_s), nullable(meter.profile_entry_period_s), nullable(meter.sanction_load_w),
                nullable(meter.contracted_demand_wh), nullable(meter.tod_enabled), nullable(meter.tod_zones_count),
                meter.tod_schedule == null ? null : JSON.stringify(meter.tod_schedule), nullable(meter.programming_count),
                nullable(meter.mfr_config_a), nullable(meter.mfr_config_b)],
        );
    }

    async #saveReadings(connection, cycleId, readings) {
        const instant = readings.instant || {};
        const voltage = instant.voltage || {};
        const current = instant.current || {};
        const pf = instant.power_factor || {};
        const power = instant.power || {};
        const counters = instant.counters || {};

        await connection.execute(
            `INSERT INTO instant_readings
                (cycle_id, reading_ts_utc, voltage_l1_v, voltage_l2_v, voltage_l3_v,
                 current_l1_a, current_l2_a, current_l3_a, power_factor_l1, power_factor_l2,
                 power_factor_l3, power_factor_system, frequency_hz, active_import_w, reactive_var,
                 apparent_import_va, power_failure_count, power_failure_duration_minutes,
                 tamper_count, billing_count, billing_date_utc)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                reading_ts_utc=VALUES(reading_ts_utc), voltage_l1_v=VALUES(voltage_l1_v),
                voltage_l2_v=VALUES(voltage_l2_v), voltage_l3_v=VALUES(voltage_l3_v),
                current_l1_a=VALUES(current_l1_a), current_l2_a=VALUES(current_l2_a), current_l3_a=VALUES(current_l3_a),
                power_factor_l1=VALUES(power_factor_l1), power_factor_l2=VALUES(power_factor_l2),
                power_factor_l3=VALUES(power_factor_l3), power_factor_system=VALUES(power_factor_system),
                frequency_hz=VALUES(frequency_hz), active_import_w=VALUES(active_import_w),
                reactive_var=VALUES(reactive_var), apparent_import_va=VALUES(apparent_import_va),
                power_failure_count=VALUES(power_failure_count),
                power_failure_duration_minutes=VALUES(power_failure_duration_minutes),
                tamper_count=VALUES(tamper_count), billing_count=VALUES(billing_count), billing_date_utc=VALUES(billing_date_utc)`,
            [cycleId, mysqlDate(instant.ts), nullable(voltage.l1_v), nullable(voltage.l2_v), nullable(voltage.l3_v),
                nullable(current.l1_a), nullable(current.l2_a), nullable(current.l3_a), nullable(pf.l1), nullable(pf.l2),
                nullable(pf.l3), nullable(pf.system), nullable(instant.frequency_hz), nullable(power.active_import_w),
                nullable(power.reactive_var ?? power.reactive_q1q2_var), nullable(power.apparent_import_va),
                nullable(counters.power_failure_count), nullable(counters.power_failure_duration_min),
                nullable(counters.tamper_count), nullable(counters.billing_count), mysqlDate(counters.billing_date)],
        );

        const energy = readings.energy || {};
        await connection.execute(
            `INSERT INTO energy_readings
                (cycle_id, as_of_utc, active_import_wh, reactive_qi_lag_varh,
                 reactive_qiii_lead_varh, apparent_import_vah)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE as_of_utc=VALUES(as_of_utc), active_import_wh=VALUES(active_import_wh),
                reactive_qi_lag_varh=VALUES(reactive_qi_lag_varh),
                reactive_qiii_lead_varh=VALUES(reactive_qiii_lead_varh), apparent_import_vah=VALUES(apparent_import_vah)`,
            [cycleId, mysqlDate(energy.as_of), nullable(energy.active_import_wh), nullable(energy.reactive_qi_lag_varh),
                nullable(energy.reactive_qiii_lead_varh), nullable(energy.apparent_import_vah)],
        );

        const maxDemand = readings.max_demand || {};
        for (const [type, source] of [['live', maxDemand.live], ['billing_cycle', maxDemand.billing_cycle]]) {
            if (!source) continue;
            await connection.execute(
                `INSERT INTO max_demand_readings
                    (cycle_id, demand_type, active_demand_w, active_demand_ts_utc,
                     apparent_demand_va, apparent_demand_ts_utc)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE active_demand_w=VALUES(active_demand_w),
                    active_demand_ts_utc=VALUES(active_demand_ts_utc), apparent_demand_va=VALUES(apparent_demand_va),
                    apparent_demand_ts_utc=VALUES(apparent_demand_ts_utc)`,
                [cycleId, type, nullable(source.active_kw_w), mysqlDate(source.active_kw_ts),
                    nullable(source.apparent_kva_va), mysqlDate(source.apparent_kva_ts)],
            );
        }

        for (const zone of Array.isArray(readings.tou) ? readings.tou : []) {
            await connection.execute(
                `INSERT INTO tou_readings
                    (cycle_id, zone_number, energy_kwh, apparent_energy_kvah, max_demand_w,
                     max_demand_ts_utc, max_apparent_demand_va, max_apparent_demand_ts_utc)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE energy_kwh=VALUES(energy_kwh), apparent_energy_kvah=VALUES(apparent_energy_kvah),
                    max_demand_w=VALUES(max_demand_w), max_demand_ts_utc=VALUES(max_demand_ts_utc),
                    max_apparent_demand_va=VALUES(max_apparent_demand_va),
                    max_apparent_demand_ts_utc=VALUES(max_apparent_demand_ts_utc)`,
                [cycleId, zone.zone, nullable(zone.kwh), nullable(zone.kvah), nullable(zone.md_kw_w),
                    mysqlDate(zone.md_kw_ts), nullable(zone.md_kva_va), mysqlDate(zone.md_kva_ts)],
            );
        }
    }

    async #saveBilling(connection, deviceId, cycleId, billing) {
        const current = billing.current;
        if (current) {
            const energy = current.energy_snapshot || {};
            await connection.execute(
                `INSERT INTO billing_current
                    (cycle_id, billing_ts_utc, system_power_factor, active_import_wh,
                     reactive_qi_lag_varh, reactive_qiii_lead_varh, apparent_import_vah,
                     cumulative_duration_minutes)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE billing_ts_utc=VALUES(billing_ts_utc),
                    system_power_factor=VALUES(system_power_factor), active_import_wh=VALUES(active_import_wh),
                    reactive_qi_lag_varh=VALUES(reactive_qi_lag_varh),
                    reactive_qiii_lead_varh=VALUES(reactive_qiii_lead_varh),
                    apparent_import_vah=VALUES(apparent_import_vah),
                    cumulative_duration_minutes=VALUES(cumulative_duration_minutes)`,
                [cycleId, mysqlDate(current.ts), current.system_pf_x1000 == null ? null : current.system_pf_x1000 / 1000,
                    nullable(energy.active_import_wh), nullable(energy.reactive_qi_lag_varh),
                    nullable(energy.reactive_qiii_lead_varh), nullable(energy.apparent_import_vah),
                    nullable(current.cumulative_duration_min)],
            );
        }

        for (const item of Array.isArray(billing.history) ? billing.history : []) {
            if (item.billing_date == null || item.cycle == null) continue;
            await connection.execute(
                `INSERT INTO billing_history
                    (device_id, billing_cycle_number, billing_date_utc, active_import_wh,
                     apparent_import_vah, reactive_qi_varh, reactive_qiii_varh, system_power_factor,
                     cumulative_duration_minutes, max_demand_w, max_apparent_demand_va, last_seen_cycle_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE active_import_wh=VALUES(active_import_wh),
                    apparent_import_vah=VALUES(apparent_import_vah), reactive_qi_varh=VALUES(reactive_qi_varh),
                    reactive_qiii_varh=VALUES(reactive_qiii_varh), system_power_factor=VALUES(system_power_factor),
                    cumulative_duration_minutes=VALUES(cumulative_duration_minutes), max_demand_w=VALUES(max_demand_w),
                    max_apparent_demand_va=VALUES(max_apparent_demand_va), last_seen_cycle_id=VALUES(last_seen_cycle_id)`,
                [deviceId, item.cycle, mysqlDate(item.billing_date), nullable(item.active_import_wh),
                    nullable(item.apparent_import_vah), nullable(item.reactive_qi_varh), nullable(item.reactive_qiii_varh),
                    item.system_pf_x1000 == null ? null : item.system_pf_x1000 / 1000,
                    nullable(item.cumulative_duration_min), nullable(item.md_kw_w), nullable(item.md_kva_va), cycleId],
            );
        }
    }

    async #saveProfiles(connection, deviceId, cycleId, profiles) {
        for (const [profileType, profile] of Object.entries(profiles)) {
            if (!profile || typeof profile !== 'object') continue;
            await connection.execute(
                `INSERT INTO profile_snapshots
                    (cycle_id, profile_type, obis, entries_in_use, profile_capacity,
                     rows_returned, interval_minutes, buffer_full, note)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE obis=VALUES(obis), entries_in_use=VALUES(entries_in_use),
                    profile_capacity=VALUES(profile_capacity), rows_returned=VALUES(rows_returned),
                    interval_minutes=VALUES(interval_minutes), buffer_full=VALUES(buffer_full), note=VALUES(note)`,
                [cycleId, profileType, nullable(profile.obis), nullable(profile.entries_in_use),
                    nullable(profile.profile_capacity), nullable(profile.rows_returned), nullable(profile.interval_min),
                    nullable(profile.buffer_full), nullable(profile.note)],
            );

            for (const [measurementKey, unitSymbol] of Object.entries(profile.units || {})) {
                await connection.execute(
                    `INSERT INTO profile_units
                        (cycle_id, profile_type, measurement_key, unit_symbol)
                     VALUES (?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE unit_symbol=VALUES(unit_symbol)`,
                    [cycleId, profileType, measurementKey, String(unitSymbol)],
                );
            }
        }

        for (const entry of profiles.block_load?.latest_10 || []) {
            if (!entry.ts) continue;
            await connection.execute(
                `INSERT INTO block_load_entries
                    (device_id, reading_ts_utc, current_l1_a, current_l2_a, current_l3_a,
                     voltage_l1_v, voltage_l2_v, voltage_l3_v, active_energy_wh, reactive_lag_varh,
                     reactive_lead_varh, apparent_energy_vah, last_seen_cycle_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE current_l1_a=VALUES(current_l1_a), current_l2_a=VALUES(current_l2_a),
                    current_l3_a=VALUES(current_l3_a), voltage_l1_v=VALUES(voltage_l1_v),
                    voltage_l2_v=VALUES(voltage_l2_v), voltage_l3_v=VALUES(voltage_l3_v),
                    active_energy_wh=VALUES(active_energy_wh), reactive_lag_varh=VALUES(reactive_lag_varh),
                    reactive_lead_varh=VALUES(reactive_lead_varh), apparent_energy_vah=VALUES(apparent_energy_vah),
                    last_seen_cycle_id=VALUES(last_seen_cycle_id)`,
                [deviceId, mysqlDate(entry.ts), nullable(entry.i_l1_a), nullable(entry.i_l2_a), nullable(entry.i_l3_a),
                    nullable(entry.v_l1_v), nullable(entry.v_l2_v), nullable(entry.v_l3_v), nullable(entry.kwh_wh),
                    nullable(entry.kvarh_lag_varh), nullable(entry.kvarh_lead_varh), nullable(entry.kvah_vah), cycleId],
            );
        }

        for (const entry of profiles.daily_load?.latest_10 || []) {
            if (!entry.ts) continue;
            await connection.execute(
                `INSERT INTO daily_load_entries
                    (device_id, reading_ts_utc, active_energy_wh, reactive_qi_varh,
                     reactive_qiii_varh, apparent_energy_vah, on_minutes, off_minutes,
                     missing_minutes, last_seen_cycle_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE active_energy_wh=VALUES(active_energy_wh),
                    reactive_qi_varh=VALUES(reactive_qi_varh), reactive_qiii_varh=VALUES(reactive_qiii_varh),
                    apparent_energy_vah=VALUES(apparent_energy_vah), on_minutes=VALUES(on_minutes),
                    off_minutes=VALUES(off_minutes), missing_minutes=VALUES(missing_minutes),
                    last_seen_cycle_id=VALUES(last_seen_cycle_id)`,
                [deviceId, mysqlDate(entry.ts), nullable(entry.active_wh), nullable(entry.react_qi_varh),
                    nullable(entry.react_qiii_varh), nullable(entry.apparent_vah), nullable(entry.on_min),
                    nullable(entry.off_min), nullable(entry.missing_min), cycleId],
            );
        }
    }

    async #saveEvents(connection, deviceId, cycleId, events) {
        for (const [logKey, eventLog] of Object.entries(events)) {
            if (!eventLog || typeof eventLog !== 'object') continue;
            await connection.execute(
                `INSERT INTO event_profile_snapshots
                    (cycle_id, event_log_key, obis, rows_returned, entries_in_use, profile_capacity)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE obis=VALUES(obis), rows_returned=VALUES(rows_returned),
                    entries_in_use=VALUES(entries_in_use), profile_capacity=VALUES(profile_capacity)`,
                [cycleId, logKey, nullable(eventLog.obis), nullable(eventLog.rows_returned),
                    nullable(eventLog.entries_in_use), nullable(eventLog.profile_capacity)],
            );

            for (const entry of eventLog.latest_10 || []) {
                if (!entry.ts) continue;
                const [result] = await connection.execute(
                    `INSERT INTO meter_events
                        (device_id, event_log_key, event_ts_utc, event_code, last_seen_cycle_id)
                     VALUES (?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id), last_seen_cycle_id=VALUES(last_seen_cycle_id)`,
                    [deviceId, logKey, mysqlDate(entry.ts), eventCode(entry), cycleId],
                );

                if (!entry.snapshot) continue;
                const s = entry.snapshot;
                await connection.execute(
                    `INSERT INTO event_measurements
                        (event_id, current_l1_a, current_l2_a, current_l3_a,
                         voltage_l1_v, voltage_l2_v, voltage_l3_v, power_factor_l1,
                         power_factor_l2, power_factor_l3, active_import_wh, apparent_import_vah)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE current_l1_a=VALUES(current_l1_a), current_l2_a=VALUES(current_l2_a),
                        current_l3_a=VALUES(current_l3_a), voltage_l1_v=VALUES(voltage_l1_v),
                        voltage_l2_v=VALUES(voltage_l2_v), voltage_l3_v=VALUES(voltage_l3_v),
                        power_factor_l1=VALUES(power_factor_l1), power_factor_l2=VALUES(power_factor_l2),
                        power_factor_l3=VALUES(power_factor_l3), active_import_wh=VALUES(active_import_wh),
                        apparent_import_vah=VALUES(apparent_import_vah)`,
                    [result.insertId, nullable(s.current_l1_a), nullable(s.current_l2_a), nullable(s.current_l3_a),
                        nullable(s.voltage_l1_v), nullable(s.voltage_l2_v), nullable(s.voltage_l3_v),
                        nullable(s.power_factor_l1), nullable(s.power_factor_l2), nullable(s.power_factor_l3),
                        nullable(s.active_import_wh), nullable(s.apparent_import_vah)],
                );
            }
        }
    }

    async #saveHealth(connection, cycleId, health) {
        await connection.execute(
            `INSERT INTO device_health
                (cycle_id, health_ts_utc, firmware, heap_free_bytes, psram_free_bytes,
                 total_objects_read, total_errors, reconnects, dlms_cycles)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE health_ts_utc=VALUES(health_ts_utc), firmware=VALUES(firmware),
                heap_free_bytes=VALUES(heap_free_bytes), psram_free_bytes=VALUES(psram_free_bytes),
                total_objects_read=VALUES(total_objects_read), total_errors=VALUES(total_errors),
                reconnects=VALUES(reconnects), dlms_cycles=VALUES(dlms_cycles)`,
            [cycleId, mysqlDate(health.ts), nullable(health.fw_version), nullable(health.heap_free_bytes),
                nullable(health.psram_free_bytes), nullable(health.total_objects_read), nullable(health.total_errors),
                nullable(health.reconnects), nullable(health.dlms_cycles)],
        );

        const modem = health.modem || {};
        await connection.execute(
            `INSERT INTO modem_health
                (cycle_id, firmware, sim_status, csq, network_attached,
                 registration_status, last_send_success_seconds, server_configured)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE firmware=VALUES(firmware), sim_status=VALUES(sim_status),
                csq=VALUES(csq), network_attached=VALUES(network_attached),
                registration_status=VALUES(registration_status),
                last_send_success_seconds=VALUES(last_send_success_seconds),
                server_configured=VALUES(server_configured)`,
            [cycleId, nullable(modem.firmware), nullable(modem.sim_status), nullable(modem.csq),
                nullable(modem.network_attached), nullable(modem.cereg), nullable(modem.last_send_success_s_ago),
                nullable(modem.server_configured)],
        );
    }
}

module.exports = { PacketRepository };
