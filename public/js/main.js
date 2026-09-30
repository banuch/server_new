// Application shell: hash router, one refresh timer for the visible view,
// global meter search, and the "last updated" indicator.
import { api, query, isAbort, serverNow } from './api.js';
import { setTimeZone, zoneLabel, clockTime, ago, durationText } from './format.js';
import { byId, esc, icon, toast, debounce, statusBadge } from './ui.js';
import { createFleetView } from './views/fleet.js';
import { createMetersView } from './views/meters.js';
import { createMeterView } from './views/meter.js';
import { createPacketsView } from './views/packets.js';

const VIEWS = { fleet: createFleetView, meters: createMetersView, meter: createMeterView, packets: createPacketsView };
const settings = { timeZone: 'Asia/Kolkata', onlineAfterSeconds: 600, offlineAfterSeconds: 1800 };

let view = null;
let loadController = null;
let refreshTimer = null;
let lastSuccessAt = null;

const context = {
    settings,
    setCrumb(html) { byId('crumb').innerHTML = html; },
    setAlertCount(counts) {
        const alerts = (counts?.offline || 0) + (counts?.rejected || 0);
        byId('navAlert').textContent = String(alerts);
        byId('navAlert').classList.toggle('hidden', alerts === 0);
    },
    reload: (reason = 'manual') => runLoad(reason),
};

function parseRoute() {
    const hash = location.hash.replace(/^#/, '') || '/fleet';
    const [path, search = ''] = hash.split('?');
    const parts = path.split('/').filter(Boolean).map((part) => {
        try { return decodeURIComponent(part); } catch { return part; }
    });
    const params = new URLSearchParams(search);
    if (parts[0] === 'meters' && parts[1]) return { name: 'meter', id: parts[1], tab: parts[2] || 'instant', params };
    if (parts[0] === 'meters') return { name: 'meters', params };
    if (parts[0] === 'packets') return { name: 'packets', params };
    return { name: 'fleet', params };
}

function setUpdated(state, detail = '') {
    const box = byId('updated');
    box.classList.toggle('failed', state === 'failed');
    if (state === 'loading') {
        box.innerHTML = `<span class="spinner" aria-hidden="true"></span><span class="long">Updating…</span>`;
    } else if (state === 'failed') {
        box.innerHTML = `${icon('warn')}<span><span class="long">Update failed · </span>${esc(detail)}</span>`;
        box.title = 'The latest refresh failed; the page shows the data from the time given.';
    } else {
        box.innerHTML = `${icon('clock')}<span><span class="long">Updated </span>${esc(clockTime(new Date(serverNow())))}</span>`;
        box.title = `Data loaded at this time (${zoneLabel()}).`;
    }
}

function schedule() {
    clearTimeout(refreshTimer);
    const ms = view?.refreshMs?.();
    if (ms && !document.hidden) refreshTimer = setTimeout(() => runLoad('auto'), ms);
}

async function runLoad(reason) {
    if (!view) return;
    clearTimeout(refreshTimer);
    loadController?.abort();
    const controller = new AbortController();
    loadController = controller;
    const button = byId('refreshButton');
    if (reason === 'manual') button.classList.add('busy');
    setUpdated('loading');
    try {
        await view.load(controller.signal, reason);
        if (controller !== loadController) return;
        lastSuccessAt = Date.now();
        setUpdated('ok');
        updateOutdated();
    } catch (error) {
        if (isAbort(error) || controller !== loadController) return;
        const since = lastSuccessAt ? `data from ${clockTime(new Date(lastSuccessAt))}` : 'no data';
        setUpdated('failed', since);
        updateOutdated();
        if (view.hasData?.()) {
            if (reason !== 'auto') toast(`${error.message} Showing ${since}.`, 'warn');
        } else {
            view.showError(error);
        }
    } finally {
        if (controller === loadController) {
            button.classList.remove('busy');
            schedule();
        }
    }
}

function setNav(name) {
    const section = name === 'meter' ? 'meters' : name;
    document.querySelectorAll('[data-nav]').forEach((link) => {
        const active = link.dataset.nav === section;
        link.classList.toggle('active', active);
        if (active) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
    });
}

function route() {
    const next = parseRoute();
    closeNav();
    setNav(next.name);
    if (view && view.routeName === next.name && view.update?.(next)) {
        runLoad('route');
        return;
    }
    loadController?.abort();
    clearTimeout(refreshTimer);
    view?.destroy?.();
    lastSuccessAt = null;
    updateOutdated();
    view = VIEWS[next.name](next, context);
    view.routeName = next.name;
    const root = byId('view');
    root.innerHTML = '';
    view.mount(root);
    window.scrollTo(0, 0);
    runLoad('initial');
}

function closeNav() {
    byId('shell').classList.remove('nav-open');
    byId('menuButton').setAttribute('aria-expanded', 'false');
}

function initNav() {
    byId('menuButton').addEventListener('click', () => {
        const open = byId('shell').classList.toggle('nav-open');
        byId('menuButton').setAttribute('aria-expanded', String(open));
    });
    byId('scrim').addEventListener('click', closeNav);
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeNav(); });
    byId('refreshButton').addEventListener('click', () => runLoad('manual'));
    byId('closeDialog').addEventListener('click', () => byId('packetDialog').close());
}

function initSearch() {
    const input = byId('globalSearchInput');
    const results = byId('searchResults');
    let controller = null;
    let active = -1;

    const hide = () => {
        results.classList.add('hidden');
        input.setAttribute('aria-expanded', 'false');
        active = -1;
    };
    const links = () => [...results.querySelectorAll('a')];
    const highlight = (index) => {
        const items = links();
        active = Math.max(-1, Math.min(index, items.length - 1));
        items.forEach((item, i) => item.classList.toggle('active', i === active));
    };

    const lookup = debounce(async () => {
        const term = input.value.trim();
        if (!term) return hide();
        controller?.abort();
        controller = new AbortController();
        try {
            const data = await api(`/api/meters${query({ search: term, pageSize: 8, sort: 'meter' })}`, { signal: controller.signal });
            results.innerHTML = data.rows.length
                ? data.rows.map((meter) => `<a href="#/meters/${encodeURIComponent(meter.device_uid)}" role="option">
                    <span><b>${esc(meter.meter_serial || meter.device_uid)}</b><small>${esc(meter.device_uid)}${meter.manufacturer ? ` · ${esc(meter.manufacturer)}` : ''}</small></span>
                    ${statusBadge(meter.status)}</a>`).join('')
                  + (data.pagination.total > data.rows.length ? `<a href="#/meters?search=${encodeURIComponent(term)}"><span>Show all ${data.pagination.total} matches</span></a>` : '')
                : '<div class="none">No meter matches this search.</div>';
            results.classList.remove('hidden');
            input.setAttribute('aria-expanded', 'true');
            active = -1;
        } catch (error) {
            if (!isAbort(error)) {
                results.innerHTML = `<div class="none">${esc(error.message)}</div>`;
                results.classList.remove('hidden');
            }
        }
    }, 250);

    input.addEventListener('input', lookup);
    input.addEventListener('focus', () => { if (input.value.trim()) lookup(); });
    input.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown') { event.preventDefault(); highlight(active + 1); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); highlight(active - 1); }
        else if (event.key === 'Escape') { hide(); input.blur(); }
        else if (event.key === 'Enter') {
            event.preventDefault();
            const items = links();
            const target = items[active] || (items.length === 1 ? items[0] : null);
            location.hash = target ? target.getAttribute('href') : `#/meters?search=${encodeURIComponent(input.value.trim())}`;
            hide();
            input.blur();
        }
    });
    results.addEventListener('click', (event) => {
        if (event.target.closest('a')) {
            hide();
            input.value = '';
        }
    });
    document.addEventListener('click', (event) => { if (!byId('globalSearch').contains(event.target)) hide(); });
}

// Warns when refreshes have been failing for more than two intervals: the
// statuses on screen were computed at the last successful load.
function updateOutdated() {
    const ms = view?.refreshMs?.();
    const outdated = Boolean(ms && lastSuccessAt && !document.hidden && Date.now() - lastSuccessAt > 2 * ms);
    document.body.classList.toggle('data-outdated', outdated);
    const banner = byId('outdated');
    banner.classList.toggle('hidden', !outdated);
    if (outdated) {
        banner.innerHTML = `${icon('warn')}<span>The dashboard has not refreshed for ${esc(durationText((Date.now() - lastSuccessAt) / 1000))}.
            Statuses and values below are from ${esc(clockTime(new Date(lastSuccessAt)))} and may no longer be current.</span>`;
    }
}

// Keeps every "… ago" text on the page current between data refreshes.
function startTicker() {
    setInterval(() => {
        document.querySelectorAll('[data-ago]').forEach((element) => { element.textContent = ago(element.dataset.ago); });
        updateOutdated();
    }, 15_000);
}

async function initialize() {
    initNav();
    initSearch();
    startTicker();
    try {
        Object.assign(settings, await api('/api/config'));
    } catch {
        // Defaults above match the server defaults.
    }
    setTimeZone(settings.timeZone);
    byId('navFoot').innerHTML = `Online = packet within ${esc(durationText(settings.onlineAfterSeconds))}<br>
        Offline after ${esc(durationText(settings.offlineAfterSeconds))}<br>Times in ${esc(zoneLabel())} (${esc(settings.timeZone)})`;

    document.addEventListener('visibilitychange', () => {
        updateOutdated();
        if (document.hidden) {
            clearTimeout(refreshTimer);
            return;
        }
        const ms = view?.refreshMs?.();
        if (ms && (!lastSuccessAt || Date.now() - lastSuccessAt >= ms)) runLoad('auto');
        else schedule();
    });
    window.addEventListener('hashchange', route);
    route();

    // The meters badge in the sidebar needs fleet counts on every page.
    if (parseRoute().name !== 'fleet' && parseRoute().name !== 'meters') {
        api('/api/fleet').then((fleet) => context.setAlertCount(fleet.counts)).catch(() => {});
    }
}

initialize();
