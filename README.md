# AMR DLMS TCP Server

Dependency-free Node.js TCP server for receiving and logging newline-delimited
packets from ESP32-based AMR devices.

## Protocol

Each packet must be one line followed by a newline (`\n`):

```text
{"deviceId":"ESP32-AMR-001","voltage":230.4}\n
```

The server treats packet contents as raw text. It does not parse, validate, or
transform JSON. It returns one newline-delimited JSON acknowledgement for every
complete line, only after that raw line has been written to disk. Packet content
is never printed in the server terminal.

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
```

Operating-system environment variables override matching values in `.env`.
The local `.env` is ignored by Git; `.env.example` is the safe configuration
template to commit.

## Logs

- Valid packets: `logs/dlms-YYYY-MM-DD.ndjson`
- Oversized or connection-truncated packets: `logs/errors-YYYY-MM-DD.ndjson`

Every log line includes the server receive time, client address, byte count, and
the complete raw packet in the `raw` property. The terminal displays only a
short confirmation containing the timestamp, client address, and byte count.
Dates in filenames and timestamps use UTC.

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
