# AMR DLMS TCP Server

Single Node.js application for receiving, logging, parsing, and persistently
storing newline-delimited schema `2.1.0` packets from ESP32-based AMR devices.
It also provides a read-only web dashboard and REST API for the stored data.

## Dashboard

After startup, open `http://localhost:3000`. The dashboard includes:

- summary cards for today's packet count, devices active during the last hour,
  and the most recently received packet;
- hourly or daily charts for voltage, current, active power, and energy;
- per-device chart selection and average/sum aggregation;
- a paginated packet ledger with device, meter serial, date-range, and text
  filters;
- a raw JSON viewer for each receipt; and
- optional automatic refresh every 30 seconds.

The dashboard reads the existing normalized tables and never modifies packet
data. Chart.js is served locally with the application, so the dashboard does
not depend on a public CDN.

## Protocol

Each packet must be one line followed by a newline (`\n`):

```text
{"deviceId":"ESP32-AMR-001","voltage":230.4}\n
```

The server writes the raw line to disk, validates the JSON packet, and stores its
data in normalized MySQL tables. It returns a success acknowledgement only after
both the file write and MySQL transaction complete. Successful packet content is
not printed in the terminal. Rejected payloads are printed with their validation
error to help diagnose malformed device JSON.

## Run

Node.js 18 or newer is required.

```powershell
npm start
```

Defaults:

- TCP address: `0.0.0.0:5000`
- Maximum packet size: 256 KiB
- Idle connection timeout: 120 seconds
- Logs: `./logs`

Configuration is read from the local `.env` file. To use another port, edit:

```dotenv
TCP_PORT=5000
WEB_PORT=3000
```

The available settings are:

```dotenv
TCP_HOST=0.0.0.0
TCP_PORT=5000
MAX_PACKET_BYTES=262144
IDLE_TIMEOUT_MS=120000
# LOG_DIR=C:\amr-logs

WEB_HOST=0.0.0.0
WEB_PORT=3000

DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=
DB_NAME=amr_tcp_server
DB_CONNECTION_LIMIT=10
```

Operating-system environment variables override matching values in `.env`.
The local `.env` is ignored by Git; `.env.example` is the safe configuration
template to commit.

Install and run the complete app with:

```powershell
npm install
# Copy .env.example to .env and enter the MySQL credentials.
npm start
```

TCP ingestion and the HTTP dashboard run in the same process. They use separate
ports so existing ESP32 devices can keep connecting to `TCP_PORT`.

## REST API

- `GET /api/packets?page=1&pageSize=25` — packet list; optional filters are
  `deviceId`, `meterSerial`, `search`, `from`, and `to`.
- `GET /api/packets/:id` — complete raw payload for the JSON viewer.
- `GET /api/packets/stats` — summary and chart series; optional filters are
  `deviceId`, `from`, `to`, `interval=hour|day`, and `aggregate=avg|sum`.
- `GET /api/devices` — known devices and last-seen information.
- `GET /api/health` — lightweight HTTP health check.

All user-supplied values are passed to MySQL as prepared-statement parameters.
The existing indexes on receipt time, device identity, meter serial, and cycle
time support the dashboard filters.

## Logs

- Valid packets: `logs/dlms-YYYY-MM-DD.ndjson`
- Oversized or connection-truncated packets: `logs/errors-YYYY-MM-DD.ndjson`

Every log line includes the server receive time, client address, byte count, and
the complete raw packet in the `raw` property. The terminal displays only a
short confirmation for successful packets. For rejected packets, it displays the
error and complete rejected payload. Dates in filenames and timestamps use UTC.

## MySQL startup and storage

The configured MySQL account must have permission to create `DB_NAME`. Before
opening the TCP port, the application:

1. connects to the MySQL server;
2. creates the database if it does not exist;
3. applies missing schema migrations and creates missing tables;
4. verifies the connection; and
5. starts accepting device connections.

If MySQL setup fails, the TCP server does not start. Valid packets are stored in
one transaction across normalized device, cycle, configuration, measurement,
billing, profile, event, and health tables. Raw payloads and parse failures are
retained in `packet_receipts`. Repeated profile entries and events are upserted
through natural unique keys.

## Test

Run automated tests:

```powershell
npm test
```

With the server running, send a sample packet from another terminal:

```powershell
node scripts/test-client.js
```

An ESP32 must send the serialized JSON and delimiter in the same logical write:

```cpp
client.print(jsonPayload);
client.print("\n");
```
