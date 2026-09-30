#!/usr/bin/env bash

set -Eeuo pipefail

SERVICE_NAME="${SERVICE_NAME:-dashboard-server}"
# One unit, or several separated by spaces (e.g. "amr-ingest amr-dashboard").
read -r -a SERVICES <<< "${SERVICE_NAME}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

echo "[DEPLOY] Repository: ${REPO_DIR}"
echo "[DEPLOY] Service(s): ${SERVICES[*]}"

cd -- "${REPO_DIR}"

echo "[DEPLOY] Pulling latest code..."
git pull --ff-only

echo "[DEPLOY] Installing production dependencies..."
npm ci --omit=dev

echo "[DEPLOY] Reloading systemd and restarting ${SERVICES[*]}..."
sudo systemctl daemon-reload
sudo systemctl restart "${SERVICES[@]}"

echo "[DEPLOY] Service status:"
sudo systemctl --no-pager --full status "${SERVICES[@]}"

if [[ "${1:-}" == "--follow" ]]; then
    echo "[DEPLOY] Following logs; press Ctrl+C to stop viewing."
    sudo journalctl "${SERVICES[@]/#/--unit=}" -f
else
    echo "[DEPLOY] Complete. Follow logs with:"
    echo "sudo journalctl ${SERVICES[*]/#/--unit=} -f"
fi
