'use strict';

const MAX_PAGE_SIZE = 200;

function integer(value, fallback, minimum, maximum) {
    if (value === undefined || value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
        throw new RangeError(`value must be an integer from ${minimum} to ${maximum}`);
    }
    return parsed;
}

function dateValue(value, name) {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new RangeError(`${name} must be a valid date`);
    return date;
}

function deviceValue(value) {
    const deviceId = String(value || '').trim();
    if (!deviceId) throw new RangeError('deviceId is required');
    return deviceId;
}

function rangeValues(input = {}) {
    const from = dateValue(input.from, 'from');
    const to = dateValue(input.to, 'to');
    if (from && to && from > to) throw new RangeError('from must be earlier than to');
    return { from, to };
}

function pageValues(input = {}) {
    return {
        page: integer(input.page, 1, 1, Number.MAX_SAFE_INTEGER),
        pageSize: integer(input.pageSize, 25, 1, MAX_PAGE_SIZE),
    };
}

function addDateRange(sql, values, range, column) {
    let result = sql;
    if (range.from) {
        result += ` AND ${column} >= ?`;
        values.push(range.from);
    }
    if (range.to) {
        result += ` AND ${column} <= ?`;
        values.push(range.to);
    }
    return result;
}

function addFilters(query, values, filters, alias = 'pr') {
    const clauses = [];
    if (filters.deviceId) {
        clauses.push('COALESCE(d.device_uid, pr.source_device_uid) = ?');
        values.push(filters.deviceId);
    }
    if (filters.meterSerial) {
        clauses.push('d.meter_serial = ?');
        values.push(filters.meterSerial);
    }
    if (filters.from) {
        clauses.push(`${alias}.received_at >= ?`);
        values.push(filters.from);
    }
    if (filters.to) {
        clauses.push(`${alias}.received_at <= ?`);
        values.push(filters.to);
    }
    if (filters.search) {
        const term = `%${filters.search}%`;
        clauses.push(`(
            CAST(${alias}.id AS CHAR) LIKE ? OR COALESCE(d.device_uid, pr.source_device_uid) LIKE ? OR d.meter_serial LIKE ?
            OR ${alias}.client_ip LIKE ? OR ${alias}.parse_status LIKE ? OR ${alias}.parse_error LIKE ?
        )`);
        values.push(term, term, term, term, term, term);
    }
    return `${query}${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''}`;
}

class DashboardRepository {
    constructor(database) {
        this.database = database;
    }

    async getPackets(input = {}) {
        const page = integer(input.page, 1, 1, Number.MAX_SAFE_INTEGER);
        const pageSize = integer(input.pageSize, 25, 1, MAX_PAGE_SIZE);
        const filters = {
            deviceId: String(input.deviceId || '').trim(),
            meterSerial: String(input.meterSerial || '').trim(),
            search: String(input.search || '').trim().slice(0, 200),
            from: dateValue(input.from, 'from'),
            to: dateValue(input.to, 'to'),
        };
        if (filters.from && filters.to && filters.from > filters.to) {
            throw new RangeError('from must be earlier than to');
        }

        const countValues = [];
        const countSql = addFilters(
            `SELECT COUNT(*) AS total
             FROM packet_receipts pr
             LEFT JOIN packet_cycle_links pcl ON pcl.receipt_id = pr.id
             LEFT JOIN measurement_cycles mc ON mc.id = pcl.cycle_id
             LEFT JOIN devices d ON d.id = mc.device_id`,
            countValues,
            filters,
        );
        const [countRows] = await this.database.execute(countSql, countValues);
        const total = Number(countRows[0]?.total || 0);

        const values = [];
        let sql = addFilters(
            `SELECT pr.id, pr.received_at, pr.client_ip, pr.client_port, pr.byte_count,
                    pr.parse_status, pr.parse_error,
                    COALESCE(d.device_uid, pr.source_device_uid) AS device_uid, d.meter_serial,
                    mc.device_cycle_number, mc.meter_ts_utc, mc.mode,
                    ir.voltage_l1_v, ir.current_l1_a, ir.active_import_w,
                    er.active_import_wh
             FROM packet_receipts pr
             LEFT JOIN packet_cycle_links pcl ON pcl.receipt_id = pr.id
             LEFT JOIN measurement_cycles mc ON mc.id = pcl.cycle_id
             LEFT JOIN devices d ON d.id = mc.device_id
             LEFT JOIN instant_readings ir ON ir.cycle_id = mc.id
             LEFT JOIN energy_readings er ON er.cycle_id = mc.id`,
            values,
            filters,
        );
        sql += ' ORDER BY pr.received_at DESC, pr.id DESC LIMIT ? OFFSET ?';
        values.push(pageSize, (page - 1) * pageSize);
        const [rows] = await this.database.execute(sql, values);

        return {
            rows,
            pagination: {
                page,
                pageSize,
                total,
                totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
            },
        };
    }

    async getPacket(id) {
        const packetId = integer(id, null, 1, Number.MAX_SAFE_INTEGER);
        const [rows] = await this.database.execute(
            `SELECT pr.id, pr.received_at, pr.client_ip, pr.client_port, pr.byte_count,
                    pr.parse_status, pr.parse_error, pr.raw_payload,
                    COALESCE(d.device_uid, pr.source_device_uid) AS device_uid,
                    d.meter_serial, mc.device_cycle_number, mc.meter_ts_utc
             FROM packet_receipts pr
             LEFT JOIN packet_cycle_links pcl ON pcl.receipt_id = pr.id
             LEFT JOIN measurement_cycles mc ON mc.id = pcl.cycle_id
             LEFT JOIN devices d ON d.id = mc.device_id
             WHERE pr.id = ?`,
            [packetId],
        );
        return rows[0] || null;
    }

    async getDevices() {
        const [rows] = await this.database.execute(
            `SELECT d.device_uid, d.meter_serial, d.firmware,
                    COUNT(mc.id) AS packet_count, MAX(mc.meter_ts_utc) AS last_meter_time,
                    MAX(pr.received_at) AS last_received_at
             FROM devices d
             LEFT JOIN measurement_cycles mc ON mc.device_id = d.id
             LEFT JOIN packet_cycle_links pcl ON pcl.cycle_id = mc.id
             LEFT JOIN packet_receipts pr ON pr.id = pcl.receipt_id
             GROUP BY d.id, d.device_uid, d.meter_serial, d.firmware
             ORDER BY d.device_uid`,
        );
        return rows;
    }

    async getDeviceOverview(deviceIdInput) {
        const deviceId = deviceValue(deviceIdInput);
        const [rows] = await this.database.execute(
            `SELECT d.device_uid, d.meter_serial, d.firmware, d.manufacturer,
                    d.manufacture_year, d.utility,
                    mc.device_cycle_number, mc.meter_ts_utc, mc.timezone_offset_minutes,
                    mc.mode, mc.meter_clock_valid, pr.received_at, pr.parse_status,
                    ir.reading_ts_utc, ir.voltage_l1_v, ir.voltage_l2_v, ir.voltage_l3_v,
                    ir.current_l1_a, ir.current_l2_a, ir.current_l3_a,
                    ir.power_factor_l1, ir.power_factor_l2, ir.power_factor_l3,
                    ir.power_factor_system, ir.frequency_hz, ir.active_import_w,
                    ir.reactive_var, ir.apparent_import_va, ir.power_failure_count,
                    ir.power_failure_duration_minutes, ir.tamper_count, ir.billing_count,
                    ir.billing_date_utc,
                    er.as_of_utc, er.active_import_wh, er.reactive_qi_lag_varh,
                    er.reactive_qiii_lead_varh, er.apparent_import_vah,
                    dh.health_ts_utc, dh.heap_free_bytes, dh.psram_free_bytes,
                    dh.total_objects_read, dh.total_errors, dh.reconnects, dh.dlms_cycles,
                    mh.csq, mh.network_attached, mh.registration_status,
                    mh.last_send_success_seconds, mh.server_configured
             FROM devices d
             LEFT JOIN measurement_cycles mc ON mc.device_id = d.id
             LEFT JOIN packet_cycle_links pcl ON pcl.cycle_id = mc.id
             LEFT JOIN packet_receipts pr ON pr.id = pcl.receipt_id
             LEFT JOIN instant_readings ir ON ir.cycle_id = mc.id
             LEFT JOIN energy_readings er ON er.cycle_id = mc.id
             LEFT JOIN device_health dh ON dh.cycle_id = mc.id
             LEFT JOIN modem_health mh ON mh.cycle_id = mc.id
             WHERE d.device_uid = ?
             ORDER BY pr.received_at DESC, mc.id DESC
             LIMIT 1`,
            [deviceId],
        );
        if (!rows[0]) return null;

        const [configRows] = await this.database.execute(
            `SELECT cc.ct_ratio, cc.active_meter_constant, cc.reactive_meter_constant,
                    cc.integration_period_seconds, cc.profile_entry_period_seconds,
                    cc.sanction_load_w, cc.contracted_demand_wh, cc.tod_enabled,
                    cc.tod_zones_count
             FROM cycle_configs cc
             JOIN measurement_cycles mc ON mc.id = cc.cycle_id
             JOIN devices d ON d.id = mc.device_id
             WHERE d.device_uid = ?
             ORDER BY mc.meter_ts_utc DESC, mc.id DESC
             LIMIT 1`,
            [deviceId],
        );
        return { ...rows[0], ...(configRows[0] || {}) };
    }

    async getBlockLoad(deviceIdInput, input = {}) {
        return this.#getLoadProfile('block', deviceIdInput, input);
    }

    async getDailyLoad(deviceIdInput, input = {}) {
        return this.#getLoadProfile('daily', deviceIdInput, input);
    }

    async #getLoadProfile(type, deviceIdInput, input) {
        const deviceId = deviceValue(deviceIdInput);
        const range = rangeValues(input);
        const { page, pageSize } = pageValues(input);
        const table = type === 'block' ? 'block_load_entries' : 'daily_load_entries';

        const countValues = [deviceId];
        let countSql = `SELECT COUNT(*) AS total FROM ${table} lp
                        JOIN devices d ON d.id = lp.device_id
                        WHERE d.device_uid = ?`;
        countSql = addDateRange(countSql, countValues, range, 'lp.reading_ts_utc');
        const [countRows] = await this.database.execute(countSql, countValues);

        const values = [deviceId];
        const columns = type === 'block'
            ? `lp.reading_ts_utc, lp.current_l1_a, lp.current_l2_a, lp.current_l3_a,
               lp.voltage_l1_v, lp.voltage_l2_v, lp.voltage_l3_v,
               lp.active_energy_wh, lp.reactive_lag_varh, lp.reactive_lead_varh,
               lp.apparent_energy_vah`
            : `lp.reading_ts_utc, lp.active_energy_wh, lp.reactive_qi_varh,
               lp.reactive_qiii_varh, lp.apparent_energy_vah,
               lp.on_minutes, lp.off_minutes, lp.missing_minutes`;
        let sql = `SELECT ${columns} FROM ${table} lp
                   JOIN devices d ON d.id = lp.device_id
                   WHERE d.device_uid = ?`;
        sql = addDateRange(sql, values, range, 'lp.reading_ts_utc');
        sql += ' ORDER BY lp.reading_ts_utc DESC LIMIT ? OFFSET ?';
        values.push(pageSize, (page - 1) * pageSize);
        const [rows] = await this.database.execute(sql, values);
        const total = Number(countRows[0]?.total || 0);
        return { rows, pagination: { page, pageSize, total, totalPages: total ? Math.ceil(total / pageSize) : 0 } };
    }

    async getBilling(deviceIdInput, input = {}) {
        const deviceId = deviceValue(deviceIdInput);
        const range = rangeValues(input);
        const { page, pageSize } = pageValues(input);
        const [currentRows] = await this.database.execute(
            `SELECT bc.billing_ts_utc, bc.system_power_factor, bc.active_import_wh,
                    bc.reactive_qi_lag_varh, bc.reactive_qiii_lead_varh,
                    bc.apparent_import_vah, bc.cumulative_duration_minutes
             FROM billing_current bc
             JOIN measurement_cycles mc ON mc.id = bc.cycle_id
             JOIN devices d ON d.id = mc.device_id
             WHERE d.device_uid = ?
             ORDER BY mc.meter_ts_utc DESC LIMIT 1`,
            [deviceId],
        );

        const countValues = [deviceId];
        let countSql = `SELECT COUNT(*) AS total FROM billing_history bh
                        JOIN devices d ON d.id = bh.device_id WHERE d.device_uid = ?`;
        countSql = addDateRange(countSql, countValues, range, 'bh.billing_date_utc');
        const [countRows] = await this.database.execute(countSql, countValues);

        const values = [deviceId];
        let sql = `SELECT bh.billing_cycle_number, bh.billing_date_utc, bh.active_import_wh,
                          bh.apparent_import_vah, bh.reactive_qi_varh, bh.reactive_qiii_varh,
                          bh.system_power_factor, bh.cumulative_duration_minutes,
                          bh.max_demand_w, bh.max_apparent_demand_va
                   FROM billing_history bh JOIN devices d ON d.id = bh.device_id
                   WHERE d.device_uid = ?`;
        sql = addDateRange(sql, values, range, 'bh.billing_date_utc');
        sql += ' ORDER BY bh.billing_date_utc DESC LIMIT ? OFFSET ?';
        values.push(pageSize, (page - 1) * pageSize);
        const [history] = await this.database.execute(sql, values);
        const total = Number(countRows[0]?.total || 0);
        return {
            current: currentRows[0] || null,
            history,
            pagination: { page, pageSize, total, totalPages: total ? Math.ceil(total / pageSize) : 0 },
        };
    }

    async getEvents(deviceIdInput, input = {}) {
        const deviceId = deviceValue(deviceIdInput);
        const range = rangeValues(input);
        const { page, pageSize } = pageValues(input);
        const eventLog = String(input.eventLog || '').trim();
        const eventCode = input.eventCode === undefined || input.eventCode === ''
            ? null : integer(input.eventCode, null, -2147483648, 2147483647);

        const filter = (values) => {
            let sql = '';
            if (eventLog) { sql += ' AND me.event_log_key = ?'; values.push(eventLog); }
            if (eventCode !== null) { sql += ' AND me.event_code = ?'; values.push(eventCode); }
            return addDateRange(sql, values, range, 'me.event_ts_utc');
        };

        const countValues = [deviceId];
        const [countRows] = await this.database.execute(
            `SELECT COUNT(*) AS total FROM meter_events me
             JOIN devices d ON d.id = me.device_id
             WHERE d.device_uid = ?${filter(countValues)}`,
            countValues,
        );

        const values = [deviceId];
        const sql = `SELECT me.event_log_key, me.event_ts_utc, me.event_code,
                            ecl.event_category, ecl.description AS event_description,
                            em.current_l1_a, em.current_l2_a, em.current_l3_a,
                            em.voltage_l1_v, em.voltage_l2_v, em.voltage_l3_v,
                            em.power_factor_l1, em.power_factor_l2, em.power_factor_l3,
                            em.active_import_wh, em.apparent_import_vah
                     FROM meter_events me
                     JOIN devices d ON d.id = me.device_id
                     LEFT JOIN event_code_lookup ecl ON ecl.event_code = me.event_code
                     LEFT JOIN event_measurements em ON em.event_id = me.id
                     WHERE d.device_uid = ?${filter(values)}
                     ORDER BY me.event_ts_utc DESC LIMIT ? OFFSET ?`;
        values.push(pageSize, (page - 1) * pageSize);
        const [rows] = await this.database.execute(sql, values);
        const total = Number(countRows[0]?.total || 0);
        return { rows, pagination: { page, pageSize, total, totalPages: total ? Math.ceil(total / pageSize) : 0 } };
    }

    async getSummary() {
        const [rows] = await this.database.execute(
            `SELECT
                (SELECT COUNT(*) FROM packet_receipts WHERE received_at >= UTC_DATE()) AS total_packets_today,
                (SELECT COUNT(DISTINCT mc.device_id)
                   FROM measurement_cycles mc
                   JOIN packet_cycle_links pcl ON pcl.cycle_id = mc.id
                   JOIN packet_receipts pr ON pr.id = pcl.receipt_id
                  WHERE pr.received_at >= UTC_TIMESTAMP() - INTERVAL 1 HOUR) AS active_devices_last_hour,
                (SELECT MAX(received_at) FROM packet_receipts) AS last_packet_received_at`,
        );
        return rows[0];
    }

    async getStats(input = {}) {
        const aggregate = input.aggregate === 'sum' ? 'SUM' : 'AVG';
        const interval = input.interval === 'day' ? 'day' : 'hour';
        const to = dateValue(input.to, 'to') || new Date();
        const from = dateValue(input.from, 'from')
            || new Date(to.getTime() - (interval === 'day' ? 30 : 24) * 60 * 60 * 1000);
        if (from > to) throw new RangeError('from must be earlier than to');

        const summary = await this.getSummary();

        const bucket = interval === 'day'
            ? "DATE_FORMAT(pr.received_at, '%Y-%m-%dT00:00:00.000Z')"
            : "DATE_FORMAT(pr.received_at, '%Y-%m-%dT%H:00:00.000Z')";
        const values = [from, to];
        let deviceClause = '';
        if (input.deviceId) {
            deviceClause = ' AND d.device_uid = ?';
            values.push(String(input.deviceId));
        }

        const [series] = await this.database.execute(
            `SELECT ${bucket} AS bucket,
                    ${aggregate}(ir.voltage_l1_v) AS voltage_v,
                    ${aggregate}(ir.current_l1_a) AS current_a,
                    ${aggregate}(ir.active_import_w) AS active_power_w,
                    ${aggregate}(er.active_import_wh) / 1000 AS energy_kwh,
                    COUNT(*) AS sample_count
             FROM measurement_cycles mc
             JOIN devices d ON d.id = mc.device_id
             JOIN packet_cycle_links pcl ON pcl.cycle_id = mc.id
             JOIN packet_receipts pr ON pr.id = pcl.receipt_id
             LEFT JOIN instant_readings ir ON ir.cycle_id = mc.id
             LEFT JOIN energy_readings er ON er.cycle_id = mc.id
             WHERE pr.received_at >= ? AND pr.received_at <= ?${deviceClause}
             GROUP BY bucket
             ORDER BY bucket`,
            values,
        );

        return {
            summary,
            chart: { interval, aggregate: aggregate.toLowerCase(), from, to, series },
        };
    }
}

module.exports = { DashboardRepository, MAX_PAGE_SIZE };
