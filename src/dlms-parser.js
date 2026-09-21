'use strict';

function valueOrNull(value) {
    return value === undefined ? null : value;
}

function extractDlmsSummary(packet) {
    if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return null;

    const device = packet.device || {};
    const cycle = packet.cycle || {};
    const readings = packet.readings || {};
    const instant = readings.instant || {};

    // This parser targets the AMR schema supplied by the device. Other valid
    // JSON objects are still accepted and logged by the TCP server.
    if (!packet.schema_version && !packet.device && !readings.instant) return null;

    const voltage = instant.voltage || {};
    const current = instant.current || {};
    const powerFactor = instant.power_factor || {};
    const power = instant.power || {};
    const energy = readings.energy || {};
    const maxDemand = readings.max_demand || {};
    const profiles = packet.profiles || {};
    const blockLoad = profiles.block_load || {};
    const dailyLoad = profiles.daily_load || {};
    const billing = packet.billing || {};
    const health = packet.device_health || {};
    const modem = health.modem || {};

    const eventGroups = Object.entries(packet.events || {}).map(([name, group]) => ({
        name,
        obis: valueOrNull(group && group.obis),
        count: valueOrNull(group && group.count),
        latestEntries: Array.isArray(group && group.latest_10) ? group.latest_10.length : 0,
    }));

    return {
        schemaVersion: valueOrNull(packet.schema_version),
        device: {
            id: valueOrNull(device.device_id),
            meterSerial: valueOrNull(device.meter_serial),
            firmware: valueOrNull(device.firmware),
            manufacturer: valueOrNull(device.manufacturer),
            manufactureYear: valueOrNull(device.mfr_year),
            utility: valueOrNull(device.utility),
        },
        cycle: {
            id: valueOrNull(cycle.id),
            mode: valueOrNull(cycle.mode),
            timestampUtc: valueOrNull(cycle.ts_utc),
            timestampIst: valueOrNull(cycle.ts_ist),
            meterClockValid: valueOrNull(cycle.meter_clock_valid),
        },
        instant: {
            timestamp: valueOrNull(instant.ts),
            voltageV: {
                l1: valueOrNull(voltage.l1_v),
                l2: valueOrNull(voltage.l2_v),
                l3: valueOrNull(voltage.l3_v),
            },
            currentA: {
                l1: valueOrNull(current.l1_a),
                l2: valueOrNull(current.l2_a),
                l3: valueOrNull(current.l3_a),
            },
            powerFactor: {
                l1: valueOrNull(powerFactor.l1),
                l2: valueOrNull(powerFactor.l2),
                l3: valueOrNull(powerFactor.l3),
                system: valueOrNull(powerFactor.system),
            },
            frequencyHz: valueOrNull(instant.frequency_hz),
            activePowerW: valueOrNull(power.active_import_w),
            reactivePowerVar: valueOrNull(power.reactive_q1q2_var),
            apparentPowerVa: valueOrNull(power.apparent_import_va),
        },
        energy: {
            asOf: valueOrNull(energy.as_of),
            activeImportWh: valueOrNull(energy.active_import_wh),
            reactiveLagVarh: valueOrNull(energy.reactive_qi_lag_varh),
            reactiveLeadVarh: valueOrNull(energy.reactive_qiii_lead_varh),
            apparentImportVah: valueOrNull(energy.apparent_import_vah),
        },
        maxDemand: {
            live: maxDemand.live || null,
            billingCycle: maxDemand.billing_cycle || null,
        },
        tou: Array.isArray(readings.tou) ? readings.tou : [],
        billing: {
            current: billing.current || null,
            historyEntries: Array.isArray(billing.history) ? billing.history.length : 0,
        },
        profiles: {
            blockLoad: {
                obis: valueOrNull(blockLoad.obis),
                totalEntries: valueOrNull(blockLoad.total_entries),
                intervalMinutes: valueOrNull(blockLoad.interval_min),
                latestEntries: Array.isArray(blockLoad.latest_10) ? blockLoad.latest_10.length : 0,
            },
            dailyLoad: {
                obis: valueOrNull(dailyLoad.obis),
                totalEntries: valueOrNull(dailyLoad.total_entries),
                latestEntries: Array.isArray(dailyLoad.latest_10) ? dailyLoad.latest_10.length : 0,
            },
        },
        events: eventGroups,
        health: {
            timestamp: valueOrNull(health.ts),
            firmware: valueOrNull(health.fw_version),
            heapFreeBytes: valueOrNull(health.heap_free_bytes),
            psramFreeBytes: valueOrNull(health.psram_free_bytes),
            objectsRead: valueOrNull(health.total_objects_read),
            errors: valueOrNull(health.total_errors),
            reconnects: valueOrNull(health.reconnects),
            dlmsCycles: valueOrNull(health.dlms_cycles),
            modem: {
                firmware: valueOrNull(modem.firmware),
                simStatus: valueOrNull(modem.sim_status),
                csq: valueOrNull(modem.csq),
                networkAttached: valueOrNull(modem.network_attached),
                registration: valueOrNull(modem.cereg),
            },
        },
    };
}

function show(value) {
    return value === null || value === undefined ? 'N/A' : String(value);
}

function formatDlmsSummary(summary) {
    if (!summary) return [];

    const lines = [];
    const { device, cycle, instant, energy, maxDemand, profiles, health } = summary;

    lines.push('[DLMS VALUES]');
    lines.push(`  Schema: ${show(summary.schemaVersion)}`);
    lines.push(`  Device: ${show(device.id)} | Meter: ${show(device.meterSerial)} | Firmware: ${show(device.firmware)}`);
    lines.push(`  Manufacturer: ${show(device.manufacturer)} | Year: ${show(device.manufactureYear)}`);
    lines.push(`  Cycle: ${show(cycle.id)} | Mode: ${show(cycle.mode)} | Meter time: ${show(cycle.timestampIst)}`);
    lines.push(`  Meter clock valid: ${show(cycle.meterClockValid)}`);
    lines.push('  Instantaneous:');
    lines.push(`    Voltage (V): L1=${show(instant.voltageV.l1)}  L2=${show(instant.voltageV.l2)}  L3=${show(instant.voltageV.l3)}`);
    lines.push(`    Current (A): L1=${show(instant.currentA.l1)}  L2=${show(instant.currentA.l2)}  L3=${show(instant.currentA.l3)}`);
    lines.push(`    Power factor: L1=${show(instant.powerFactor.l1)}  L2=${show(instant.powerFactor.l2)}  L3=${show(instant.powerFactor.l3)}  System=${show(instant.powerFactor.system)}`);
    lines.push(`    Frequency: ${show(instant.frequencyHz)} Hz`);
    lines.push(`    Power: active=${show(instant.activePowerW)} W  reactive=${show(instant.reactivePowerVar)} var  apparent=${show(instant.apparentPowerVa)} VA`);
    lines.push('  Cumulative energy:');
    lines.push(`    Active=${show(energy.activeImportWh)} Wh  Reactive lag=${show(energy.reactiveLagVarh)} varh`);
    lines.push(`    Reactive lead=${show(energy.reactiveLeadVarh)} varh  Apparent=${show(energy.apparentImportVah)} VAh`);

    if (maxDemand.live) {
        lines.push(`  Live maximum demand: active=${show(maxDemand.live.active_kw_w)} W @ ${show(maxDemand.live.active_kw_ts)}`);
        lines.push(`                       apparent=${show(maxDemand.live.apparent_kva_va)} VA @ ${show(maxDemand.live.apparent_kva_ts)}`);
    }

    if (summary.tou.length > 0) {
        lines.push(`  TOU zones (${summary.tou.length}):`);
        for (const zone of summary.tou) {
            lines.push(`    Zone ${show(zone.zone)}: kWh=${show(zone.kwh)}  kVAh=${show(zone.kvah)}  MD W=${show(zone.md_kw_w)}  MD VA=${show(zone.md_kva_va)}`);
        }
    }

    lines.push(`  Billing history entries: ${summary.billing.historyEntries}`);
    lines.push(`  Block-load profile: total=${show(profiles.blockLoad.totalEntries)}  latest=${profiles.blockLoad.latestEntries}  interval=${show(profiles.blockLoad.intervalMinutes)} min`);
    lines.push(`  Daily-load profile: total=${show(profiles.dailyLoad.totalEntries)}  latest=${profiles.dailyLoad.latestEntries}`);

    if (summary.events.length > 0) {
        lines.push('  Event groups:');
        for (const event of summary.events) {
            lines.push(`    ${event.name}: count=${show(event.count)}  received=${event.latestEntries}  OBIS=${show(event.obis)}`);
        }
    }

    lines.push('  Device health:');
    lines.push(`    FW=${show(health.firmware)}  heap=${show(health.heapFreeBytes)} B  PSRAM=${show(health.psramFreeBytes)} B`);
    lines.push(`    Objects=${show(health.objectsRead)}  errors=${show(health.errors)}  reconnects=${show(health.reconnects)}  cycles=${show(health.dlmsCycles)}`);
    lines.push(`    Modem=${show(health.modem.firmware)}  SIM=${show(health.modem.simStatus)}  CSQ=${show(health.modem.csq)}  attached=${show(health.modem.networkAttached)}  CEREG=${show(health.modem.registration)}`);

    return lines;
}

module.exports = { extractDlmsSummary, formatDlmsSummary };
