'use strict';

const { loadConfig } = require('./config');
const { PacketLogger } = require('./packet-logger');
const { createTcpServer } = require('./tcp-server');

async function main() {
    const config = loadConfig();
    const packetLogger = new PacketLogger(config.logDir);
    const app = createTcpServer(config, packetLogger);

    await new Promise((resolve, reject) => {
        app.server.once('error', reject);
        app.server.listen(config.port, config.host, resolve);
    });

    console.log(`[APP] AMR TCP server listening on ${config.host}:${config.port}`);
    console.log(`[APP] Packet logs: ${config.logDir}`);
    console.log(`[APP] Protocol: one raw packet per line`);

    let shuttingDown = false;
    async function shutdown(signal) {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`[APP] ${signal} received; shutting down`);

        try {
            await app.close();
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
