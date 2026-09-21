'use strict';

const fs = require('fs/promises');
const path = require('path');

class PacketLogger {
    constructor(logDir) {
        this.logDir = logDir;
        this.ready = fs.mkdir(logDir, { recursive: true });
        this.writeQueue = Promise.resolve();
    }

    logPacket(record) {
        return this.#append('dlms', record.receivedAt, {
            type: 'packet',
            ...record,
        });
    }

    logError(record) {
        return this.#append('errors', record.receivedAt, {
            type: 'error',
            ...record,
        });
    }

    #append(prefix, timestamp, record) {
        const date = timestamp.slice(0, 10);
        const file = path.join(this.logDir, `${prefix}-${date}.ndjson`);
        const line = `${JSON.stringify(record)}\n`;

        const operation = this.writeQueue.then(async () => {
            await this.ready;
            await fs.appendFile(file, line, 'utf8');
        });

        // A failed write is reported to the caller but must not poison all
        // future writes in the queue.
        this.writeQueue = operation.catch(() => {});
        return operation;
    }

    async flush() {
        await this.writeQueue;
    }
}

module.exports = { PacketLogger };
