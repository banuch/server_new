'use strict';

const { loadConfig } = require('./config');
const { PacketLogger } = require('./packet-logger');
const { createTcpServer } = require('./tcp-server');
const { MysqlDatabase } = require('./database/mysql-database');
const { PacketRepository } = require('./database/packet-repository');
const { listen, runService } = require('./service');

// TCP packet ingestion: receives, logs, and stores device packets.
async function startIngest(config = loadConfig(), output = console) {
    const packetLogger = new PacketLogger(config.logDir);
    const database = new MysqlDatabase(config.mysql);
    await database.initialize();
    const tcpApp = createTcpServer(config, packetLogger, new PacketRepository(database));

    await listen(tcpApp.server, config.port, config.host);
    output.log(`[INGEST] AMR TCP server listening on ${config.host}:${config.port}`);
    output.log(`[INGEST] Packet logs: ${config.logDir}`);
    output.log('[INGEST] Protocol: one schema 2.1.0 JSON packet per line');

    return {
        async close() {
            await tcpApp.close();
            await database.close();
        },
    };
}

if (require.main === module) runService('INGEST', () => startIngest());

module.exports = { startIngest };
