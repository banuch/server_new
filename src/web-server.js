'use strict';

const http = require('http');
const path = require('path');
const express = require('express');

function asyncRoute(handler) {
    return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}

function createWebServer(repository, output = console) {
    const app = express();
    const publicDir = path.join(__dirname, '..', 'public');
    const chartPath = path.join(__dirname, '..', 'node_modules', 'chart.js', 'dist', 'chart.umd.js');

    app.disable('x-powered-by');
    app.use(express.json({ limit: '64kb' }));
    app.get('/vendor/chart.js', (request, response) => response.sendFile(chartPath));

    app.get('/api/packets', asyncRoute(async (request, response) => {
        response.json(await repository.getPackets(request.query));
    }));

    app.get('/api/packets/stats', asyncRoute(async (request, response) => {
        response.json(await repository.getStats(request.query));
    }));

    app.get('/api/packets/:id', asyncRoute(async (request, response) => {
        const packet = await repository.getPacket(request.params.id);
        if (!packet) return response.status(404).json({ error: 'Packet not found' });
        return response.json(packet);
    }));

    app.get('/api/devices', asyncRoute(async (request, response) => {
        response.json({ devices: await repository.getDevices() });
    }));

    app.get('/api/health', (request, response) => response.json({ status: 'ok' }));
    app.use(express.static(publicDir));

    app.use('/api', (request, response) => {
        response.status(404).json({ error: 'API endpoint not found' });
    });

    app.use((error, request, response, next) => {
        if (response.headersSent) return next(error);
        const clientError = error instanceof RangeError;
        output.error(`[WEB] ${request.method} ${request.originalUrl}: ${error.message}`);
        return response.status(clientError ? 400 : 503).json({
            error: clientError ? error.message : 'Database request failed. Check the server log and connection.',
        });
    });

    const server = http.createServer(app);
    return {
        app,
        server,
        close: () => new Promise((resolve, reject) => {
            if (!server.listening) return resolve();
            return server.close((error) => (error ? reject(error) : resolve()));
        }),
    };
}

module.exports = { createWebServer };
