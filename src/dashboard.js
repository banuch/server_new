'use strict';

const { loadConfig } = require('./config');
const { MysqlDatabase } = require('./database/mysql-database');
const { DashboardRepository } = require('./database/dashboard-repository');
const { createWebServer } = require('./web-server');
const { listen, runService } = require('./service');

// HTTP dashboard and REST API. Runs apart from ingestion so restarting or
// crashing it never drops device connections.
async function startDashboard(config = loadConfig(), output = console) {
    const database = new MysqlDatabase({
        ...config.mysql,
        connectionLimit: config.mysql.webConnectionLimit,
    });
    await database.initialize();
    const webApp = createWebServer(new DashboardRepository(database, config.dashboard), output, config.dashboard);

    await listen(webApp.server, config.webPort, config.webHost);
    output.log(`[WEB] Dashboard: http://${config.webHost}:${config.webPort}`);

    return {
        async close() {
            await webApp.close();
            await database.close();
        },
    };
}

if (require.main === module) runService('WEB', () => startDashboard());

module.exports = { startDashboard };
