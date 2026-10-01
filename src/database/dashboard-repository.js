'use strict';

const { meterStatus, DEFAULT_THRESHOLDS } = require('../meter-status');

const MAX_PAGE_SIZE = 200;
// Upper bound on load-profile points returned for one chart request.
const MAX_SERIES_POINTS = 5000;
const METER_STATUSES = ['online', 'delayed', 'offline', 'rejected', 'never'];
// Most urgent first when sorting by status or listing meters that need attention.
const STATUS_SEVERITY = { offline: 0, rejected: 1, delayed: 2, never: 3, online: 4 };
const METER_SORTS = ['meter', 'status', 'last', 'power', 'energy', 'manufacturer'];

const PROFILE_COLUMNS = {
    block: `lp.reading_ts_utc, lp.current_l1_a, lp.current_l2_a, lp.current_l3_a,
            lp.voltage_l1_v, lp.voltage_l2_v, lp.voltage_l3_v,
            lp.active_energy_wh, lp.reactive_lag_varh, lp.reactive_lead_varh,
            lp.apparent_energy_vah`,
    daily: `lp.reading_ts_utc, lp.active_energy_wh, lp.reactive_qi_varh,
            lp.reactive_qiii_varh, lp.apparent_energy_vah,
            lp.on_minutes, lp.off_minutes, lp.missing_minutes`,
};
const PROFILE_TABLES = { block: 'block_load_entries', daily: 'daily_load_entries' };

// UTC instant of the most recent local midnight in timeZone.
function startOfDay(timeZone, now = new Date()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(now).map((part) => [part.type, Number(part.value)]));
    const wholeSeconds = Math.floor(now.getTime() / 1000) * 1000;
    const offset = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
        - wholeSeconds;
    return new Date(Date.UTC(parts.year, parts.month - 1, parts.day) - offset);
}

function numberOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function compareMeters(sort, a, b) {
    const text = (value) => String(value ?? '').toLowerCase();
    switch (sort) {
    case 'status':
        return STATUS_SEVERITY[a.status] - STATUS_SEVERITY[b.status]
            || (b.status_age_seconds ?? -1) - (a.status_age_seconds ?? -1);
    case 'last':
        return (new Date(a.last_received_at || 0)) - (new Date(b.last_received_at || 0));
    case 'power':
        return (numberOrNull(a.active_import_w) ?? -Infinity) - (numberOrNull(b.active_import_w) ?? -Infinity);
    case 'energy':
        return (numberOrNull(a.active_import_wh) ?? -Infinity) - (numberOrNull(b.active_import_wh) ?? -Infinity);
    case 'manufacturer':
        return text(a.manufacturer).localeCompare(text(b.manufacturer));
    default:
        return text(a.meter_serial || a.device_uid).localeCompare(text(b.meter_serial || b.device_uid));
    }
}

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

// Filters reference packet_receipts only, so counting and paging never need
// the cycle and device joins. source_device_uid holds the same id as the
// linked device (backfilled by migration 6), and a meter serial is resolved
// through the small devices table.
function addFilters(query, values, filters) {
    const clauses = [];
    if (filters.deviceId) {
        clauses.push('pr.source_device_uid = ?');
        values.push(filters.deviceId);
    }
    if (filters.meterSerial) {
        clauses.push('pr.source_device_uid IN (SELECT device_uid FROM devices WHERE meter_serial = ?)');
        values.push(filters.meterSerial);
    }
    if (filters.status) {
        clauses.push('pr.parse_status = ?');
        values.push(filters.status);
    }
    if (filters.from) {
        clauses.push('pr.received_at >= ?');
        values.push(filters.from);
    }
    if (filters.to) {
        clauses.push('pr.received_at <= ?');
        values.push(filters.to);
    }
    if (filters.search) {
        const term = `%${filters.search}%`;
        clauses.push(`(
            CAST(pr.id AS CHAR) LIKE ? OR pr.source_device_uid LIKE ?
            OR pr.source_device_uid IN (SELECT device_uid FROM devices WHERE meter_serial LIKE ?)
            OR pr.client_ip LIKE ? OR pr.parse_status LIKE ? OR pr.parse_error LIKE ?
        )`);
        values.push(term, term, term, term, term, term);
    }
    return `${query}${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''}`;
}

class DashboardRepository {
    constructor(database, options = {}) {
        this.database = database;
        this.thresholds = {
            onlineAfterSeconds: options.onlineAfterSeconds ?? DEFAULT_THRESHOLDS.onlineAfterSeconds,
            offlineAfterSeconds: options.offlineAfterSeconds ?? DEFAULT_THRESHOLDS.offlineAfterSeconds,
        };
        this.timeZone = options.timeZone || 'Asia/Kolkata';
        this.now = options.now || (() => new Date());
    }

    async getPackets(input = {}) {
        const page = integer(input.page, 1, 1, Number.MAX_SAFE_INTEGER);
        const pageSize = integer(input.pageSize, 25, 1, MAX_PAGE_SIZE);
        const filters = {
            deviceId: String(input.deviceId || '').trim(),
            meterSerial: String(input.meterSerial || '').trim(),
            search: String(input.search || '').trim().slice(0, 200),
            status: ['valid', 'invalid'].includes(input.status) ? input.status : '',
            from: dateValue(input.from, 'from'),
            to: dateValue(input.to, 'to'),
        };
        if (filters.from && filters.to && filters.from > filters.to) {
            throw new RangeError('from must be earlier than to');
        }

        const countValues = [];
        const countSql = addFilters('SELECT COUNT(*) AS total FROM packet_receipts pr', countValues, filters);
        const [countRows] = await this.database.execute(countSql, countValues);
        const total = Number(countRows[0]?.total || 0);

        // Pick the page's receipt ids first, then join details for those rows
        // only, so skipped rows of deep pages are never joined.
        const values = [];
        const pageSql = addFilters('SELECT pr.id FROM packet_receipts pr', values, filters)
            + ' ORDER BY pr.received_at DESC, pr.id DESC LIMIT ? OFFSET ?';
        values.push(pageSize, (page - 1) * pageSize);
        const [rows] = (page - 1) * pageSize >= total ? [[]] : await this.database.execute(
            `SELECT pr.id, pr.received_at, pr.client_ip, pr.client_port, pr.byte_count,
                    pr.parse_status, pr.parse_error,
                    COALESCE(d.device_uid, pr.source_device_uid) AS device_uid, d.meter_serial,
                    mc.device_cycle_number, mc.meter_ts_utc, mc.mode,
                    ir.voltage_l1_v, ir.current_l1_a, ir.active_import_w,
                    er.active_import_wh
             FROM (${pageSql}) page
             JOIN packet_receipts pr ON pr.id = page.id
             LEFT JOIN packet_cycle_links pcl ON pcl.receipt_id = pr.id
             LEFT JOIN measurement_cycles mc ON mc.id = pcl.cycle_id
             LEFT JOIN devices d ON d.id = mc.device_id
             LEFT JOIN instant_readings ir ON ir.cycle_id = mc.id
             LEFT JOIN energy_readings er ON er.cycle_id = mc.id
             ORDER BY pr.received_at DESC, pr.id DESC`,
            values,
        );

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
            // Per-device index lookups instead of joining every stored cycle.
            `SELECT d.device_uid, d.meter_serial, d.firmware,
                    (SELECT COUNT(*) FROM measurement_cycles mc
                       JOIN packet_cycle_links pcl ON pcl.cycle_id = mc.id
                      WHERE mc.device_id = d.id) AS packet_count,
                    (SELECT MAX(mc.meter_ts_utc) FROM measurement_cycles mc
                      WHERE mc.device_id = d.id) AS last_meter_time,
                    (SELECT pr.received_at FROM packet_receipts pr
                      WHERE pr.source_device_uid = d.device_uid AND pr.parse_status = 'valid'
                      ORDER BY pr.received_at DESC LIMIT 1) AS last_received_at
             FROM devices d
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
                    mh.last_send_success_seconds, mh.server_configured,
                    mh.sim_status, mh.firmware AS modem_firmware, pr.client_ip
             FROM devices d
             LEFT JOIN packet_receipts pr ON pr.id = (
                SELECT latest.id FROM packet_receipts latest
                WHERE latest.source_device_uid = d.device_uid AND latest.parse_status = 'valid'
                ORDER BY latest.received_at DESC, latest.id DESC
                LIMIT 1
             )
             LEFT JOIN packet_cycle_links pcl ON pcl.receipt_id = pr.id
             LEFT JOIN measurement_cycles mc ON mc.id = pcl.cycle_id
             LEFT JOIN instant_readings ir ON ir.cycle_id = mc.id
             LEFT JOIN energy_readings er ON er.cycle_id = mc.id
             LEFT JOIN device_health dh ON dh.cycle_id = mc.id
             LEFT JOIN modem_health mh ON mh.cycle_id = mc.id
             WHERE d.device_uid = ?`,
            [deviceId],
        );
        if (!rows[0]) return null;

        const [configRows] = await this.database.execute(
            `SELECT cc.ct_ratio, cc.active_meter_constant, cc.reactive_meter_constant,
                    cc.integration_period_seconds, cc.profile_entry_period_seconds,
                    cc.sanction_load_w, cc.contracted_demand_wh, cc.tod_enabled,
                    cc.tod_zones_count, cc.client_sap, cc.server_address, cc.auth_mode, cc.baud,
                    mc.meter_ts_utc AS config_ts_utc
             FROM cycle_configs cc
             JOIN measurement_cycles mc ON mc.id = cc.cycle_id
             JOIN devices d ON d.id = mc.device_id
             WHERE d.device_uid = ?
             ORDER BY mc.meter_ts_utc DESC, mc.id DESC
             LIMIT 1`,
            [deviceId],
        );

        const [newestRows] = await this.database.execute(
            `SELECT received_at AS newest_received_at, parse_status AS newest_parse_status,
                    parse_error AS newest_parse_error
             FROM packet_receipts
             WHERE source_device_uid = ?
             ORDER BY received_at DESC, id DESC
             LIMIT 1`,
            [deviceId],
        );

        // Buffer usage of each profile as reported by its most recent cycle.
        const [profileRows] = await this.database.execute(
            `SELECT ps.profile_type, ps.obis, ps.entries_in_use, ps.profile_capacity,
                    ps.buffer_full, ps.interval_minutes
             FROM profile_snapshots ps
             JOIN measurement_cycles mc ON mc.id = ps.cycle_id
             JOIN devices d ON d.id = mc.device_id
             WHERE d.device_uid = ?
             ORDER BY mc.meter_ts_utc DESC, mc.id DESC
             LIMIT 20`,
            [deviceId],
        );
        const profiles = [];
        for (const row of profileRows) {
            if (row.profile_type && !profiles.some((item) => item.profile_type === row.profile_type)) {
                profiles.push(row);
            }
        }

        const now = this.now();
        const overview = { ...rows[0], ...(configRows[0] || {}), ...(newestRows[0] || {}) };
        const { status, ageSeconds, issues } = meterStatus(
            { ...overview, last_received_at: overview.received_at },
            now,
            this.thresholds,
        );
        return {
            ...overview,
            profiles,
            status,
            status_age_seconds: ageSeconds,
            issues,
            generated_at: now.toISOString(),
        };
    }

    // Latest reading of every meter in one query. Meter counts are expected
    // to be in the tens or hundreds, so filtering and sorting happen in memory.
    async #meterSnapshots() {
        const [rows] = await this.database.execute(
            `SELECT d.device_uid, d.meter_serial, d.manufacturer, d.firmware,
                    lr.received_at AS last_received_at, lr.client_ip,
                    nr.received_at AS newest_received_at, nr.parse_status AS newest_parse_status,
                    nr.parse_error AS newest_parse_error,
                    mc.meter_ts_utc, mc.meter_clock_valid, mc.mode,
                    ir.voltage_l1_v, ir.voltage_l2_v, ir.voltage_l3_v,
                    ir.current_l1_a, ir.current_l2_a, ir.current_l3_a,
                    ir.active_import_w, ir.power_factor_system,
                    er.active_import_wh, mh.csq
             FROM devices d
             LEFT JOIN packet_receipts lr ON lr.id = (
                SELECT latest.id FROM packet_receipts latest
                WHERE latest.source_device_uid = d.device_uid AND latest.parse_status = 'valid'
                ORDER BY latest.received_at DESC, latest.id DESC
                LIMIT 1
             )
             LEFT JOIN packet_receipts nr ON nr.id = (
                SELECT newest.id FROM packet_receipts newest
                WHERE newest.source_device_uid = d.device_uid
                ORDER BY newest.received_at DESC, newest.id DESC
                LIMIT 1
             )
             LEFT JOIN packet_cycle_links pcl ON pcl.receipt_id = lr.id
             LEFT JOIN measurement_cycles mc ON mc.id = pcl.cycle_id
             LEFT JOIN instant_readings ir ON ir.cycle_id = mc.id
             LEFT JOIN energy_readings er ON er.cycle_id = mc.id
             LEFT JOIN modem_health mh ON mh.cycle_id = mc.id`,
        );
        const now = this.now();
        return {
            now,
            meters: rows.map((row) => {
                const { status, ageSeconds, issues } = meterStatus(row, now, this.thresholds);
                return { ...row, status, status_age_seconds: ageSeconds, issues };
            }),
        };
    }

    async getMeters(input = {}) {
        const { page, pageSize } = pageValues(input);
        const search = String(input.search || '').trim().toLowerCase().slice(0, 100);
        const status = String(input.status || '').trim();
        if (status && !METER_STATUSES.includes(status)) {
            throw new RangeError(`status must be one of ${METER_STATUSES.join(', ')}`);
        }
        const manufacturer = String(input.manufacturer || '').trim();
        const sort = METER_SORTS.includes(input.sort) ? input.sort : 'meter';
        const direction = input.dir === 'desc' ? -1 : 1;

        const { now, meters } = await this.#meterSnapshots();
        const counts = Object.fromEntries(METER_STATUSES.map((key) => [key, 0]));
        const manufacturers = new Set();
        for (const meter of meters) {
            counts[meter.status] += 1;
            if (meter.manufacturer) manufacturers.add(meter.manufacturer);
        }

        const matches = meters.filter((meter) => {
            if (status && meter.status !== status) return false;
            if (manufacturer && meter.manufacturer !== manufacturer) return false;
            if (!search) return true;
            return [meter.device_uid, meter.meter_serial, meter.manufacturer, meter.firmware, meter.client_ip]
                .some((value) => String(value ?? '').toLowerCase().includes(search));
        });
        matches.sort((a, b) => direction * compareMeters(sort, a, b)
            || compareMeters('meter', a, b));

        const total = matches.length;
        return {
            generated_at: now.toISOString(),
            rows: matches.slice((page - 1) * pageSize, page * pageSize),
            counts: { total: meters.length, ...counts },
            manufacturers: [...manufacturers].sort(),
            pagination: { page, pageSize, total, totalPages: total ? Math.ceil(total / pageSize) : 0 },
        };
    }

    async getFleet() {
        const { now, meters } = await this.#meterSnapshots();
        const counts = Object.fromEntries(METER_STATUSES.map((key) => [key, 0]));
        const byManufacturer = new Map();
        for (const meter of meters) {
            counts[meter.status] += 1;
            const name = meter.manufacturer || 'Unknown';
            if (!byManufacturer.has(name)) {
                byManufacturer.set(name, { manufacturer: name, ...Object.fromEntries(METER_STATUSES.map((key) => [key, 0])) });
            }
            byManufacturer.get(name)[meter.status] += 1;
        }

        const dayStart = startOfDay(this.timeZone, now);
        const [[packetRow]] = await this.database.execute(
            `SELECT
                (SELECT COUNT(*) FROM packet_receipts WHERE parse_status = 'invalid' AND received_at >= ?)
                    AS rejected_last_24h,
                (SELECT COUNT(*) FROM packet_receipts WHERE received_at >= ?) AS packets_today`,
            [new Date(now.getTime() - 24 * 60 * 60 * 1000), dayStart],
        );
        const [lastRows] = await this.database.execute(
            `SELECT received_at, source_device_uid, parse_status
             FROM packet_receipts ORDER BY received_at DESC, id DESC LIMIT 1`,
        );
        // Packets per hour since local midnight, for the Home page activity bars.
        const [hourRows] = await this.database.execute(
            `SELECT FLOOR(TIMESTAMPDIFF(SECOND, ?, received_at) / 3600) AS hour_index,
                    COUNT(*) AS packets, SUM(parse_status = 'invalid') AS rejected
             FROM packet_receipts WHERE received_at >= ? GROUP BY hour_index`,
            [dayStart, dayStart],
        );
        const packetsByHour = Array.from({ length: 24 }, () => ({ packets: 0, rejected: 0 }));
        for (const row of hourRows) {
            const slot = packetsByHour[Number(row.hour_index)];
            if (!slot) continue;
            slot.packets = Number(row.packets || 0);
            slot.rejected = Number(row.rejected || 0);
        }

        const attention = meters
            .filter((meter) => meter.status !== 'online' || meter.issues.length > 0)
            .sort((a, b) => compareMeters('status', a, b))
            .map((meter) => ({
                device_uid: meter.device_uid,
                meter_serial: meter.meter_serial,
                manufacturer: meter.manufacturer,
                status: meter.status,
                status_age_seconds: meter.status_age_seconds,
                last_received_at: meter.last_received_at,
                issues: meter.issues,
            }));

        return {
            generated_at: now.toISOString(),
            counts: { total: meters.length, ...counts },
            rejected_last_24h: Number(packetRow?.rejected_last_24h || 0),
            packets_today: Number(packetRow?.packets_today || 0),
            packets_by_hour: packetsByHour,
            day_start: dayStart.toISOString(),
            last_packet: lastRows[0] || null,
            attention,
            by_manufacturer: [...byManufacturer.values()].sort((a, b) => a.manufacturer.localeCompare(b.manufacturer)),
        };
    }

    // Maximum demand and time-of-day zones. Billing-derived values are omitted
    // from delta packets, so each comes from the latest cycle that carried it.
    async getEnergy(deviceIdInput) {
        const deviceId = deviceValue(deviceIdInput);
        const maxDemand = {};
        for (const type of ['billing_cycle', 'live']) {
            const [rows] = await this.database.execute(
                `SELECT md.active_demand_w, md.active_demand_ts_utc, md.apparent_demand_va,
                        md.apparent_demand_ts_utc, mc.meter_ts_utc AS captured_at
                 FROM max_demand_readings md
                 JOIN measurement_cycles mc ON mc.id = md.cycle_id
                 JOIN devices d ON d.id = mc.device_id
                 WHERE d.device_uid = ? AND md.demand_type = ?
                 ORDER BY mc.meter_ts_utc DESC, mc.id DESC
                 LIMIT 1`,
                [deviceId, type],
            );
            maxDemand[type] = rows[0] || null;
        }

        const [tou] = await this.database.execute(
            `SELECT tr.zone_number, tr.energy_kwh, tr.apparent_energy_kvah, tr.max_demand_w,
                    tr.max_demand_ts_utc, tr.max_apparent_demand_va, tr.max_apparent_demand_ts_utc,
                    mc.meter_ts_utc AS captured_at
             FROM tou_readings tr
             JOIN measurement_cycles mc ON mc.id = tr.cycle_id
             WHERE tr.cycle_id = (
                SELECT latest.cycle_id FROM tou_readings latest
                JOIN measurement_cycles lmc ON lmc.id = latest.cycle_id
                JOIN devices d ON d.id = lmc.device_id
                WHERE d.device_uid = ?
                ORDER BY lmc.meter_ts_utc DESC, lmc.id DESC
                LIMIT 1
             )
             ORDER BY tr.zone_number`,
            [deviceId],
        );
        return { maxDemand, tou };
    }

    async getEventLogs(deviceIdInput) {
        const deviceId = deviceValue(deviceIdInput);
        const [rows] = await this.database.execute(
            `SELECT DISTINCT me.event_log_key
             FROM meter_events me
             JOIN devices d ON d.id = me.device_id
             WHERE d.device_uid = ?
             ORDER BY me.event_log_key`,
            [deviceId],
        );
        return rows.map((row) => row.event_log_key);
    }

    // Chart data for a whole date range, oldest first, bounded to
    // MAX_SERIES_POINTS newest entries so a wide range cannot flood the browser.
    async getLoadProfileSeries(type, deviceIdInput, input = {}) {
        if (!PROFILE_TABLES[type]) throw new RangeError('profile type must be block or daily');
        const deviceId = deviceValue(deviceIdInput);
        const range = rangeValues(input);
        const values = [deviceId];
        let sql = `SELECT ${PROFILE_COLUMNS[type]} FROM ${PROFILE_TABLES[type]} lp
                   JOIN devices d ON d.id = lp.device_id
                   WHERE d.device_uid = ?`;
        sql = addDateRange(sql, values, range, 'lp.reading_ts_utc');
        sql += ' ORDER BY lp.reading_ts_utc DESC LIMIT ?';
        values.push(MAX_SERIES_POINTS + 1);
        const [rows] = await this.database.execute(sql, values);
        const truncated = rows.length > MAX_SERIES_POINTS;
        return { rows: rows.slice(0, MAX_SERIES_POINTS).reverse(), truncated, limit: MAX_SERIES_POINTS };
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
        const table = PROFILE_TABLES[type];

        const countValues = [deviceId];
        let countSql = `SELECT COUNT(*) AS total FROM ${table} lp
                        JOIN devices d ON d.id = lp.device_id
                        WHERE d.device_uid = ?`;
        countSql = addDateRange(countSql, countValues, range, 'lp.reading_ts_utc');
        const [countRows] = await this.database.execute(countSql, countValues);

        const values = [deviceId];
        let sql = `SELECT ${PROFILE_COLUMNS[type]} FROM ${table} lp
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
        const eventCategory = String(input.eventCategory || '').trim();
        const eventCode = input.eventCode === undefined || input.eventCode === ''
            ? null : integer(input.eventCode, null, -2147483648, 2147483647);

        const filter = (values) => {
            let sql = '';
            if (eventLog) { sql += ' AND me.event_log_key = ?'; values.push(eventLog); }
            if (eventCode !== null) { sql += ' AND me.event_code = ?'; values.push(eventCode); }
            if (eventCategory) { sql += ' AND ecl.event_category = ?'; values.push(eventCategory); }
            return addDateRange(sql, values, range, 'me.event_ts_utc');
        };

        const countValues = [deviceId];
        const [countRows] = await this.database.execute(
            `SELECT COUNT(*) AS total FROM meter_events me
             JOIN devices d ON d.id = me.device_id
             LEFT JOIN event_code_lookup ecl ON ecl.event_code = me.event_code
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

module.exports = { DashboardRepository, MAX_PAGE_SIZE, MAX_SERIES_POINTS, startOfDay };
