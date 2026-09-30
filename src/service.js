'use strict';

function listen(server, port, host) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
    });
}

// Starts one service and closes it once on SIGINT, SIGTERM, or a 'shutdown'
// message from the supervisor. The message is needed because Windows cannot
// deliver SIGTERM to a child process.
function runService(name, start, output = console) {
    const started = start();
    started.catch((error) => {
        output.error(`[${name}] Startup failed: ${error.message}`);
        process.exit(1);
    });

    let stopping = false;
    async function stop(reason) {
        if (stopping) return;
        stopping = true;
        output.log(`[${name}] ${reason} received; shutting down`);

        try {
            const service = await started;
            await service.close();
            process.exitCode = 0;
        } catch (error) {
            output.error(`[${name}] Shutdown failed: ${error.message}`);
            process.exitCode = 1;
        }
        if (process.connected) process.disconnect();
    }

    process.on('SIGINT', () => stop('SIGINT'));
    process.on('SIGTERM', () => stop('SIGTERM'));
    process.on('message', (message) => {
        if (message === 'shutdown') stop('shutdown');
    });
}

module.exports = { listen, runService };
