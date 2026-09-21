# AMR DLMS TCP Server

Node.js TCP server for receiving, logging, parsing, and persistently storing
newline-delimited schema `2.1.0` packets from ESP32-based AMR devices.

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
```

The available settings are:

```dotenv
TCP_HOST=0.0.0.0
TCP_PORT=5000
MAX_PACKET_BYTES=262144
IDLE_TIMEOUT_MS=120000
# LOG_DIR=C:\amr-logs

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
