'use strict';

const { fork } = require('child_process');

const DEFAULT_OPTIONS = {
    minRestartDelayMs: 1_000,
    maxRestartDelayMs: 30_000,
    // A child that stayed up this long is treated as healthy again, so its
    // next crash restarts quickly instead of continuing the backoff.
    healthyAfterMs: 60_000,
    shutdownTimeoutMs: 15_000,
};

// Runs each service script as its own child process and restarts any child
// that exits unexpectedly, leaving the others untouched.
function supervise(services, options = {}, output = console) {
    const settings = { ...DEFAULT_OPTIONS, ...options };
    const children = new Map();
    const restartTimers = new Set();
    let stopping = false;

    function start(service, restartDelayMs) {
        const startedAt = Date.now();
        const child = fork(service.file, service.args || [], { stdio: 'inherit' });
        children.set(service.name, child);

        child.once('exit', (code, signal) => {
            children.delete(service.name);
            if (stopping) return;

            const healthy = Date.now() - startedAt >= settings.healthyAfterMs;
            const delay = healthy ? settings.minRestartDelayMs : restartDelayMs;
            output.error(
                `[SUPERVISOR] ${service.name} exited (${signal || `code ${code}`}); restarting in ${delay} ms`,
            );
            const timer = setTimeout(() => {
                restartTimers.delete(timer);
                start(service, Math.min(delay * 2, settings.maxRestartDelayMs));
            }, delay);
            restartTimers.add(timer);
        });
    }

    for (const service of services) start(service, settings.minRestartDelayMs);

    async function stop() {
        stopping = true;
        for (const timer of restartTimers) clearTimeout(timer);
        restartTimers.clear();
        await Promise.all([...children.values()].map((child) => new Promise((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) return resolve();
            const timer = setTimeout(() => child.kill('SIGKILL'), settings.shutdownTimeoutMs);
            child.once('exit', () => {
                clearTimeout(timer);
                resolve();
            });
            if (child.connected) child.send('shutdown');
            else child.kill('SIGTERM');
        })));
    }

    return { children, stop };
}

module.exports = { supervise };
