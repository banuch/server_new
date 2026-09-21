# AMR DLMS TCP Server

Dependency-free Node.js TCP server for receiving newline-delimited JSON (NDJSON)
packets from ESP32-based AMR devices.

## Protocol

Each packet must be one JSON object followed by a newline (`\n`):

```text
{"deviceId":"ESP32-AMR-001","voltage":230.4}\n
```

The server returns one newline-delimited JSON acknowledgement for every packet.
An acknowledgement is sent only after the packet or error has been written to
disk.

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
- Invalid packets: `logs/errors-YYYY-MM-DD.ndjson`

Every log line includes the server receive time, client address, byte count, and
the complete packet. Dates in filenames and timestamps use UTC.

For schema `2.0.0` packets, the terminal also prints a labeled DLMS summary with
device identity, cycle information, phase measurements, power, energy, maximum
demand, TOU zones, profile counts, event counts, and device/modem health. The
full JSON is printed after the summary and remains unchanged in the packet log.

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
