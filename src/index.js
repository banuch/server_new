'use strict';

const { loadConfig } = require('./config');
const { PacketLogger } = require('./packet-logger');
const { createTcpServer } = require('./tcp-server');
const { MysqlDatabase } = require('./database/mysql-database');
const { PacketRepository } = require('./database/packet-repository');
const { DashboardRepository } = require('./database/dashboard-repository');
const { createWebServer } = require('./web-server');

function listen(server, port, host) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
    });
}

async function main() {
    const config = loadConfig();
    const packetLogger = new PacketLogger(config.logDir);
    const database = new MysqlDatabase(config.mysql);
    await database.initialize();
    const packetStore = new PacketRepository(database);
    const dashboardStore = new DashboardRepository(database);
    const tcpApp = createTcpServer(config, packetLogger, packetStore);
    const webApp = createWebServer(dashboardStore);

    await listen(tcpApp.server, config.port, config.host);
    await listen(webApp.server, config.webPort, config.webHost);

    console.log(`[APP] AMR TCP server listening on ${config.host}:${config.port}`);
    console.log(`[APP] Packet logs: ${config.logDir}`);
    console.log(`[APP] Protocol: one schema 2.1.0 JSON packet per line`);
    console.log(`[WEB] Dashboard: http://${config.webHost}:${config.webPort}`);

    let shuttingDown = false;
    async function shutdown(signal) {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`[APP] ${signal} received; shutting down`);

        try {
            await Promise.all([tcpApp.close(), webApp.close()]);
            await database.close();
            process.exitCode = 0;
        } catch (error) {
            console.error(`[APP] Shutdown failed: ${error.message}`);
            process.exitCode = 1;
        }
    }

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
    console.error(`[APP] Startup failed: ${error.message}`);
    process.exitCode = 1;
});
