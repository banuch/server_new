'use strict';

const net = require('net');
const { LineFramer } = require('./line-framer');

function connectionDetails(socket) {
    return {
        clientIp: socket.remoteAddress || null,
        clientPort: socket.remotePort || null,
    };
}

function sendJson(socket, message) {
    if (socket.destroyed || !socket.writable) return;
    socket.write(`${JSON.stringify(message)}\n`);
}

function createTcpServer(config, packetLogger, output = console) {
    const sockets = new Set();

    const server = net.createServer((socket) => {
        sockets.add(socket);

        const client = connectionDetails(socket);
        const clientLabel = `${client.clientIp}:${client.clientPort}`;
        const framer = new LineFramer(config.maxPacketBytes);
        let processing = Promise.resolve();

        output.log(`[TCP] Connected: ${clientLabel}`);
        socket.setKeepAlive(true, 60_000);
        socket.setTimeout(config.idleTimeoutMs);

        async function handleEvent(event) {
            const receivedAt = new Date().toISOString();

            if (event.type === 'oversize') {
                const reason = `packet exceeds ${config.maxPacketBytes} byte limit`;
                await packetLogger.logError({
                    receivedAt,
                    ...client,
                    bytes: event.observedBytes,
                    reason,
                    rawPreview: event.preview,
                });
                output.error(`[TCP] Rejected oversized packet from ${clientLabel}`);
                sendJson(socket, { status: 'error', code: 'PACKET_TOO_LARGE', message: reason });
                return;
            }

            const raw = event.data.toString('utf8');
            await packetLogger.logPacket({
                receivedAt,
                ...client,
                bytes: event.data.length,
                raw,
            });

            output.log(`[PACKET] Logged ${event.data.length} bytes from ${clientLabel} at ${receivedAt}`);

            sendJson(socket, {
                status: 'success',
                receivedAt,
                bytes: event.data.length,
            });
        }

        socket.on('data', (chunk) => {
            // Pause input while file writes complete. This bounds memory usage
            // and prevents overlapping handlers from corrupting shared state.
            socket.pause();
            const events = framer.push(chunk);

            processing = processing
                .then(async () => {
                    for (const event of events) await handleEvent(event);
                })
                .catch((error) => {
                    output.error(`[TCP] Processing failed for ${clientLabel}: ${error.message}`);
                    sendJson(socket, { status: 'error', code: 'LOG_WRITE_FAILED' });
                })
                .finally(() => {
                    if (!socket.destroyed) socket.resume();
                });
        });

        socket.on('timeout', () => {
            output.error(`[TCP] Idle timeout: ${clientLabel}`);
            socket.destroy();
        });

        socket.on('end', () => {
            const incomplete = framer.takeIncompleteFrame();
            if (incomplete) {
                processing = processing
                    .then(() => packetLogger.logError({
                        receivedAt: new Date().toISOString(),
                        ...client,
                        bytes: incomplete.length,
                        reason: 'connection ended before newline delimiter',
                        raw: incomplete.toString('utf8'),
                    }))
                    .catch((error) => output.error(`[TCP] Failed to log incomplete packet: ${error.message}`));
            }
        });

        socket.on('error', (error) => {
            output.error(`[TCP] Socket error for ${clientLabel}: ${error.message}`);
        });

        socket.on('close', () => {
            sockets.delete(socket);
            output.log(`[TCP] Disconnected: ${clientLabel}`);
        });
    });

    server.on('error', (error) => {
        output.error(`[TCP] Server error: ${error.message}`);
    });

    async function close() {
        for (const socket of sockets) socket.end();

        if (server.listening) {
            await new Promise((resolve, reject) => {
                server.close((error) => error ? reject(error) : resolve());
            });
        }

        await packetLogger.flush();
    }

    return { server, close };
}

module.exports = { createTcpServer };
