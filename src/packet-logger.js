'use strict';

const fs = require('fs');
const path = require('path');

class PacketLogger {
    constructor(logDir) {
        this.logDir = logDir;
        fs.mkdirSync(logDir, { recursive: true });
        // One append stream per daily file. Writes from every connection are
        // buffered and ordered by the stream instead of reopening the file.
        this.streams = new Map();
        this.closing = new Set();
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
        const stream = this.#stream(prefix, path.join(this.logDir, `${prefix}-${date}.ndjson`));
        const line = `${JSON.stringify(record)}\n`;

        return new Promise((resolve, reject) => {
            stream.write(line, 'utf8', (error) => (error ? reject(error) : resolve()));
        });
    }

    #stream(prefix, file) {
        const existing = this.streams.get(prefix);
        if (existing && existing.file === file && !existing.stream.destroyed) return existing.stream;

        // The day rolled over (or the old stream failed): retire the previous file.
        if (existing) this.#close(existing.stream);

        const stream = fs.createWriteStream(file, { flags: 'a' });
        // A failed write is reported to its caller through the write callback.
        // Drop the broken stream so the next write reopens the file.
        stream.on('error', () => {
            if (this.streams.get(prefix)?.stream === stream) this.streams.delete(prefix);
        });
        this.streams.set(prefix, { file, stream });
        return stream;
    }

    #close(stream) {
        const closed = new Promise((resolve) => {
            if (stream.destroyed) return resolve();
            stream.once('close', resolve);
            stream.end();
        });
        this.closing.add(closed);
        closed.then(() => this.closing.delete(closed));
        return closed;
    }

    async flush() {
        const streams = [...this.streams.values()];
        this.streams.clear();
        await Promise.all([...streams.map(({ stream }) => this.#close(stream)), ...this.closing]);
    }
}

module.exports = { PacketLogger };
