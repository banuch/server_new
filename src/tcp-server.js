'use strict';

const net = require('net');
const { LineFramer } = require('./line-framer');

function connectionDetails(socket) {
    return {
        clientIp: socket.remoteAddress || null,
        clientPort: socket.remotePort || null,
    };
}

function packetDeviceId(packet) {
    return packet.deviceId
        || packet.meterId
        || packet.device_id
        || packet?.readings?.meta?.device_id
        || null;
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
            let packet;

            try {
                packet = JSON.parse(raw);
                if (packet === null || Array.isArray(packet) || typeof packet !== 'object') {
                    throw new Error('top-level JSON value must be an object');
                }
            } catch (error) {
                await packetLogger.logError({
                    receivedAt,
                    ...client,
                    bytes: event.data.length,
                    reason: error.message,
                    raw,
                });
                output.error(`[TCP] Invalid JSON from ${clientLabel}: ${error.message}`);
                sendJson(socket, { status: 'error', code: 'INVALID_JSON', message: error.message });
                return;
            }

            const deviceId = packetDeviceId(packet);
            await packetLogger.logPacket({
                receivedAt,
                ...client,
                bytes: event.data.length,
                deviceId,
                packet,
            });

            output.log(`\n[PACKET] ${receivedAt} from ${clientLabel} (${event.data.length} bytes)`);
            output.log(JSON.stringify(packet, null, 2));

            sendJson(socket, {
                status: 'success',
                deviceId,
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
