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

function addFilters(query, values, filters, alias = 'pr') {
    const clauses = [];
    if (filters.deviceId) {
        clauses.push('d.device_uid = ?');
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
            CAST(${alias}.id AS CHAR) LIKE ? OR d.device_uid LIKE ? OR d.meter_serial LIKE ?
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
                    pr.parse_status, pr.parse_error, d.device_uid, d.meter_serial,
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
                    d.device_uid, d.meter_serial, mc.device_cycle_number, mc.meter_ts_utc
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

    async getStats(input = {}) {
        const aggregate = input.aggregate === 'sum' ? 'SUM' : 'AVG';
        const interval = input.interval === 'day' ? 'day' : 'hour';
        const to = dateValue(input.to, 'to') || new Date();
        const from = dateValue(input.from, 'from')
            || new Date(to.getTime() - (interval === 'day' ? 30 : 24) * 60 * 60 * 1000);
        if (from > to) throw new RangeError('from must be earlier than to');

        const [summaryRows] = await this.database.execute(
            `SELECT
                (SELECT COUNT(*) FROM packet_receipts WHERE received_at >= UTC_DATE()) AS total_packets_today,
                (SELECT COUNT(DISTINCT mc.device_id)
                   FROM measurement_cycles mc
                   JOIN packet_cycle_links pcl ON pcl.cycle_id = mc.id
                   JOIN packet_receipts pr ON pr.id = pcl.receipt_id
                  WHERE pr.received_at >= UTC_TIMESTAMP() - INTERVAL 1 HOUR) AS active_devices_last_hour,
                (SELECT MAX(received_at) FROM packet_receipts) AS last_packet_received_at`,
        );

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
            summary: summaryRows[0],
            chart: { interval, aggregate: aggregate.toLowerCase(), from, to, series },
        };
    }
}

module.exports = { DashboardRepository, MAX_PAGE_SIZE };
