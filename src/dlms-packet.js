'use strict';

function requiredObject(value, name) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${name} must be an object`);
    }
    return value;
}

function requiredValue(value, name) {
    if (value === undefined || value === null || value === '') {
        throw new Error(`${name} is required`);
    }
    return value;
}

function parseDlmsPacket(raw) {
    const outer = JSON.parse(raw);
    requiredObject(outer, 'packet');

    // Accept the direct schema packet and the optional METER_DATA envelope used
    // by some firmware revisions.
    const payload = outer.schema_version
        ? outer
        : (outer.readings && outer.readings.schema_version ? outer.readings : null);

    if (!payload) throw new Error('unsupported packet: schema_version not found');

    requiredValue(payload.schema_version, 'schema_version');
    const device = requiredObject(payload.device, 'device');
    const cycle = requiredObject(payload.cycle, 'cycle');
    requiredValue(device.device_id, 'device.device_id');
    requiredValue(cycle.id, 'cycle.id');
    requiredValue(cycle.ts_utc, 'cycle.ts_utc');

    return { outer, payload };
}

function mysqlDate(isoValue) {
    if (!isoValue) return null;
    const date = new Date(isoValue);
    if (Number.isNaN(date.getTime())) throw new Error(`invalid timestamp: ${isoValue}`);
    return date.toISOString().slice(0, 23).replace('T', ' ');
}

function timezoneOffsetMinutes(isoValue) {
    if (!isoValue || typeof isoValue !== 'string') return null;
    if (isoValue.endsWith('Z')) return 0;
    const match = isoValue.match(/([+-])(\d{2}):(\d{2})$/);
    if (!match) return null;
    const minutes = Number(match[2]) * 60 + Number(match[3]);
    return match[1] === '-' ? -minutes : minutes;
}

function nullable(value) {
    return value === undefined ? null : value;
}

module.exports = { parseDlmsPacket, mysqlDate, timezoneOffsetMinutes, nullable };
