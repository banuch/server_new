#!/usr/bin/env bash
# Diagnoses the AMR ingestion and dashboard services on a Linux server.
#
#   ./scripts/diagnose.sh          report only; changes nothing
#   ./scripts/diagnose.sh --fix    also repair the systemd units and restart
#
# Run it as the account that owns this project folder (not with sudo); it asks
# for sudo itself where root is needed. --fix sets User, WorkingDirectory, and
# the node path in /etc/systemd/system/amr-{ingest,dashboard}.service, stops
# the old single dashboard-server unit if it is running (meter connections
# drop for a few seconds), and restarts both services.

set -u

FIX=0
[[ "${1:-}" == "--fix" ]] && FIX=1

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
cd -- "${REPO_DIR}" || exit 1

SERVICES=(amr-ingest amr-dashboard)
OLD_SERVICE=dashboard-server
UNIT_DIR=/etc/systemd/system
PROBLEMS=()

ok()      { echo "  [OK]   $*"; }
warn()    { echo "  [WARN] $*"; }
bad()     { echo "  [FAIL] $*"; PROBLEMS+=("$*"); }
info()    { echo "         $*"; }
section() { echo; echo "== $* =="; }

# Value from the environment, else from .env, else the default.
setting() {
    local key="$1" fallback="$2" value="${!1:-}"
    if [[ -z "${value}" && -f .env ]]; then
        value="$(grep -E "^${key}=" .env | tail -n 1 | cut -d= -f2- | tr -d '"\r')"
    fi
    echo "${value:-${fallback}}"
}

TCP_PORT="$(setting TCP_PORT 5000)"
WEB_PORT="$(setting WEB_PORT 3000)"
USER_NAME="$(whoami)"
NODE_BIN="$(command -v node || true)"

section "1. Account and project"
info "User:    ${USER_NAME}"
info "Project: ${REPO_DIR}"
if [[ "${USER_NAME}" == "root" ]]; then
    warn "Running as root. Run as the project owner so the services get the right user."
fi
if [[ -z "${NODE_BIN}" ]]; then
    bad "node is not on PATH for ${USER_NAME}"
else
    NODE_VERSION="$("${NODE_BIN}" -v)"
    NODE_MAJOR="${NODE_VERSION#v}"
    NODE_MAJOR="${NODE_MAJOR%%.*}"
    if (( NODE_MAJOR < 18 )); then
        bad "node ${NODE_VERSION} is older than 18"
    else
        ok "node ${NODE_VERSION} at ${NODE_BIN}"
    fi
fi
[[ -d node_modules ]] && ok "node_modules installed" || bad "node_modules missing; run: npm ci --omit=dev"
[[ -f .env ]] && ok ".env present (TCP_PORT=${TCP_PORT}, WEB_PORT=${WEB_PORT})" || bad ".env missing; copy .env.example to .env and set the MySQL account"

section "2. Code version"
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
info "Checked out: ${BRANCH} at $(git log --oneline -1 2>/dev/null)"
if git fetch -q origin 2>/dev/null; then
    for ref in origin/master origin/dashboard-redesign; do
        git rev-parse -q --verify "${ref}" >/dev/null && info "${ref}: $(git log --oneline -1 "${ref}")"
    done
    BEHIND="$(git rev-list --count HEAD..@{u} 2>/dev/null || echo 0)"
    (( BEHIND > 0 )) && warn "${BRANCH} is ${BEHIND} commit(s) behind its remote; run git pull --ff-only"
else
    warn "git fetch failed; remote branches not checked"
fi
if [[ -f public/js/main.js ]]; then
    ok "New dashboard files are checked out"
else
    bad "Old dashboard code is checked out. The redesign is on branch dashboard-redesign: merge it into master, or run: git checkout dashboard-redesign"
fi
CHANGED="$(git status --porcelain 2>/dev/null | wc -l)"
(( CHANGED > 0 )) && warn "${CHANGED} locally modified file(s); git pull --ff-only may refuse to update"

section "3. systemd services"
for svc in "${SERVICES[@]}"; do
    unit="${UNIT_DIR}/${svc}.service"
    echo "  -- ${svc}"
    if [[ ! -f "${unit}" ]]; then
        bad "${unit} is not installed"
        continue
    fi
    unit_user="$(grep -E '^User=' "${unit}" | cut -d= -f2-)"
    unit_dir="$(grep -E '^WorkingDirectory=' "${unit}" | cut -d= -f2-)"
    unit_exec="$(grep -E '^ExecStart=' "${unit}" | cut -d= -f2-)"
    if id "${unit_user}" >/dev/null 2>&1; then ok "User=${unit_user}"; else bad "${svc}: User=${unit_user} does not exist on this server"; fi
    if [[ -d "${unit_dir}" ]]; then
        ok "WorkingDirectory=${unit_dir}"
        [[ "${unit_dir}" != "${REPO_DIR}" ]] && warn "${svc} runs from ${unit_dir}, not from this folder (${REPO_DIR})"
    else
        bad "${svc}: WorkingDirectory=${unit_dir} does not exist"
    fi
    exec_bin="${unit_exec%% *}"
    if [[ "${exec_bin}" == "/usr/bin/env" ]]; then
        if [[ -x /usr/bin/node || -x /usr/local/bin/node ]]; then
            ok "ExecStart=${unit_exec}"
        else
            bad "${svc}: ExecStart uses /usr/bin/env node, but node is not in /usr/bin or /usr/local/bin (nvm install?)"
        fi
    elif [[ -x "${exec_bin}" ]]; then
        ok "ExecStart=${unit_exec}"
    else
        bad "${svc}: ExecStart program ${exec_bin} does not exist"
    fi
    state="$(systemctl is-active "${svc}" 2>/dev/null)"
    enabled="$(systemctl is-enabled "${svc}" 2>/dev/null)"
    restarts="$(systemctl show -p NRestarts --value "${svc}" 2>/dev/null)"
    result="$(systemctl show -p Result --value "${svc}" 2>/dev/null)"
    if [[ "${state}" == "active" ]]; then
        ok "${svc} is running (${enabled}; restarts: ${restarts:-0})"
        (( ${restarts:-0} > 5 )) && warn "${svc} has restarted ${restarts} times; check its log below"
    else
        bad "${svc} is ${state:-unknown} (${enabled}; result: ${result:-?}; restarts: ${restarts:-0})"
    fi
done
echo "  -- ${OLD_SERVICE} (old single-process unit)"
if [[ "$(systemctl is-active "${OLD_SERVICE}" 2>/dev/null)" == "active" ]]; then
    warn "${OLD_SERVICE} is still running; it serves the old code and holds ports ${TCP_PORT}/${WEB_PORT}"
    PROBLEMS+=("${OLD_SERVICE} is still running alongside the new units")
else
    ok "${OLD_SERVICE} is not running"
fi

section "4. Listening ports"
LISTENERS="$(sudo ss -ltnpH 2>/dev/null)"
for entry in "ingestion:${TCP_PORT}" "dashboard:${WEB_PORT}"; do
    name="${entry%%:*}" port="${entry##*:}"
    line="$(grep -E ":${port}\b" <<<"${LISTENERS}" | head -n 1)"
    if [[ -z "${line}" ]]; then
        bad "Nothing is listening on port ${port} (${name})"
        continue
    fi
    pid="$(grep -oE 'pid=[0-9]+' <<<"${line}" | head -n 1 | cut -d= -f2)"
    owner="$(grep -oE '[^/]+\.service' "/proc/${pid}/cgroup" 2>/dev/null | head -n 1)"
    ok "Port ${port} (${name}): pid ${pid:-?} from ${owner:-not a systemd service}"
    [[ "${owner}" == "${OLD_SERVICE}.service" ]] && bad "Port ${port} is held by the old ${OLD_SERVICE} unit"
done

section "5. Dashboard over HTTP"
BASE="http://127.0.0.1:${WEB_PORT}"
if curl -fsS -m 5 "${BASE}/api/health" >/dev/null 2>&1; then
    ok "${BASE}/api/health answers"
    title="$(curl -fsS -m 5 "${BASE}/" | grep -oE '<title>[^<]*</title>' | head -n 1)"
    info "Page title: ${title:-none}"
    code="$(curl -s -o /dev/null -w '%{http_code}' -m 5 "${BASE}/api/config")"
    if [[ "${code}" == "200" ]]; then
        ok "New dashboard is running (/api/config answers)"
    else
        bad "Old dashboard is running (/api/config returned ${code}); restart amr-dashboard after updating the code"
    fi
else
    bad "Dashboard does not answer on ${BASE}"
fi

section "6. Database (read-only)"
if [[ -n "${NODE_BIN}" && -d node_modules ]]; then
    timeout 20 "${NODE_BIN}" -e '
        const { loadConfig } = require("./src/config");
        const mysql = require("mysql2/promise");
        (async () => {
            const c = loadConfig().mysql;
            const db = await mysql.createConnection({ host: c.host, port: c.port, user: c.user,
                password: c.password, database: c.database, timezone: "Z" });
            const [[m]] = await db.query("SELECT MAX(version) AS v FROM schema_migrations");
            const [[s]] = await db.query(`SELECT (SELECT COUNT(*) FROM devices) AS meters,
                (SELECT MAX(received_at) FROM packet_receipts) AS last_packet,
                (SELECT COUNT(*) FROM packet_receipts WHERE received_at >= UTC_TIMESTAMP() - INTERVAL 1 HOUR) AS last_hour,
                (SELECT COUNT(*) FROM packet_receipts WHERE parse_status = "invalid"
                   AND received_at >= UTC_TIMESTAMP() - INTERVAL 1 HOUR) AS rejected_last_hour`);
            console.log(`  [OK]   Connected to ${c.host}:${c.port}/${c.database} (schema version ${m.v})`);
            console.log(`         Meters: ${s.meters}; last packet: ${s.last_packet ? s.last_packet.toISOString() : "none"} (UTC)`);
            console.log(`         Packets in the last hour: ${s.last_hour} (${s.rejected_last_hour} rejected)`);
            if (!s.last_hour) console.log("  [WARN] No packets in the last hour: check that amr-ingest is running and meters can reach it");
            await db.end();
        })().catch((error) => { console.log(`  [FAIL] Database check failed: ${error.message}`); process.exit(1); });
    ' || PROBLEMS+=("Database check failed (see section 6)")
else
    warn "Skipped: node or node_modules missing"
fi

section "7. Recent service logs"
sudo journalctl -u amr-ingest -u amr-dashboard -n 20 --no-pager 2>/dev/null | sed 's/^/  /'

if (( FIX )); then
    section "8. Applying fixes"
    if [[ -z "${NODE_BIN}" ]]; then
        echo "  Cannot fix: node is not on PATH for ${USER_NAME}."
        exit 1
    fi
    if [[ "${USER_NAME}" == "root" ]]; then
        echo "  Refusing to fix as root: run this as the project owner so the services do not run as root."
        exit 1
    fi
    for svc in "${SERVICES[@]}"; do
        unit="${UNIT_DIR}/${svc}.service"
        if [[ ! -f "${unit}" ]]; then
            sudo cp "deploy/systemd/${svc}.service" "${unit}" && echo "  Installed ${unit}"
        fi
        sudo sed -i -E \
            -e "s|^User=.*|User=${USER_NAME}|" \
            -e "s|^WorkingDirectory=.*|WorkingDirectory=${REPO_DIR}|" \
            -e "s#^ExecStart=(/usr/bin/env node|[^ ]*/node) #ExecStart=${NODE_BIN} #" \
            "${unit}" && echo "  Updated ${unit}: User=${USER_NAME}, WorkingDirectory=${REPO_DIR}, node=${NODE_BIN}"
    done
    if [[ "$(systemctl is-active "${OLD_SERVICE}" 2>/dev/null)" == "active" ]]; then
        echo "  Stopping and disabling ${OLD_SERVICE} (meter connections drop for a few seconds)"
        sudo systemctl disable --now "${OLD_SERVICE}"
    fi
    sudo systemctl daemon-reload
    sudo systemctl enable "${SERVICES[@]}" >/dev/null 2>&1
    sudo systemctl restart "${SERVICES[@]}"
    sleep 5
    for svc in "${SERVICES[@]}"; do
        echo "  ${svc}: $(systemctl is-active "${svc}")"
    done
    echo "  Run ./scripts/diagnose.sh again to confirm."
    exit 0
fi

section "Summary"
if (( ${#PROBLEMS[@]} == 0 )); then
    echo "  No problems found. If the browser still shows the old page, press Ctrl+Shift+R."
else
    echo "  ${#PROBLEMS[@]} problem(s):"
    for problem in "${PROBLEMS[@]}"; do echo "   - ${problem}"; done
    echo
    echo "  Service and unit problems can be repaired with: ./scripts/diagnose.sh --fix"
    echo "  An old code version needs the redesign merged or checked out first (section 2)."
fi
