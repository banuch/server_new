'use strict';

const DEFAULT_THRESHOLDS = { onlineAfterSeconds: 600, offlineAfterSeconds: 1800 };

function ageSeconds(value, now) {
    if (!value) return null;
    const time = new Date(value).getTime();
    if (Number.isNaN(time)) return null;
    return Math.max(0, Math.round((now.getTime() - time) / 1000));
}

// Communication status of one meter, derived only from what the server has
// received. The server never talks to a meter, so it cannot distinguish
// association or authentication failures; those appear as missing packets.
//   online   last valid packet within onlineAfterSeconds
//   delayed  last valid packet within offlineAfterSeconds
//   offline  older than that
//   never    no valid packet stored
//   rejected the newest packet failed validation and is itself recent,
//            so the device is talking but its data cannot be stored
function meterStatus(meter, now = new Date(), thresholds = DEFAULT_THRESHOLDS) {
    const lastValidAge = ageSeconds(meter.last_received_at, now);
    const newestAge = ageSeconds(meter.newest_received_at, now);

    let status;
    if (lastValidAge === null) status = 'never';
    else if (lastValidAge <= thresholds.onlineAfterSeconds) status = 'online';
    else if (lastValidAge <= thresholds.offlineAfterSeconds) status = 'delayed';
    else status = 'offline';

    if (meter.newest_parse_status === 'invalid' && newestAge !== null
        && newestAge <= thresholds.offlineAfterSeconds) {
        status = 'rejected';
    }

    const issues = [];
    if (status === 'offline' || status === 'delayed') issues.push('No packet received');
    if (status === 'never') issues.push('No valid packet stored');
    if (status === 'rejected') issues.push(meter.newest_parse_error || 'Latest packet failed validation');
    if (meter.meter_clock_valid === 0 || meter.meter_clock_valid === false) issues.push('Meter clock invalid');

    return { status, ageSeconds: lastValidAge, issues };
}

module.exports = { meterStatus, DEFAULT_THRESHOLDS };
