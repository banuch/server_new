#!/usr/bin/env bash

set -Eeuo pipefail

SERVICE_NAME="${SERVICE_NAME:-dashboard-server}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

echo "[DEPLOY] Repository: ${REPO_DIR}"
echo "[DEPLOY] Service: ${SERVICE_NAME}"

cd -- "${REPO_DIR}"

echo "[DEPLOY] Pulling latest code..."
git pull --ff-only

echo "[DEPLOY] Installing production dependencies..."
npm ci --omit=dev

echo "[DEPLOY] Reloading systemd and restarting ${SERVICE_NAME}..."
sudo systemctl daemon-reload
sudo systemctl restart "${SERVICE_NAME}"

echo "[DEPLOY] Service status:"
sudo systemctl --no-pager --full status "${SERVICE_NAME}"

if [[ "${1:-}" == "--follow" ]]; then
    echo "[DEPLOY] Following logs; press Ctrl+C to stop viewing."
    sudo journalctl -u "${SERVICE_NAME}" -f
else
    echo "[DEPLOY] Complete. Follow logs with:"
    echo "sudo journalctl -u ${SERVICE_NAME} -f"
fi
