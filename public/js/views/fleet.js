// Fleet overview: communication health of every meter, most urgent first.
import { api } from '../api.js';
import { durationText, shortTime, int } from '../format.js';
import { esc, icon, statusBadge, timeCell, agoText, stateBox, errorBox, skeletonRows } from '../ui.js';

const REFRESH_MS = 30_000;

export function createFleetView(route, context) {
    let root;
    let data = null;
    const { settings } = context;

    const LAYOUT = `
        <div class="kpis">${'<div class="kpi"><span class="skeleton"></span><span class="skeleton block" style="height:44px;margin-top:10px"></span></div>'.repeat(6)}</div>
        <div class="two" style="margin-top:14px">
            <section class="panel"><div class="panel-head"><h3>Needs attention</h3><span class="note" id="attentionCount"></span></div>
                <div id="attentionBody"><table><tbody>${skeletonRows(4, 3)}</tbody></table></div></section>
            <section class="panel"><div class="panel-head"><h3>Status by manufacturer</h3></div>
                <div id="manufacturerBody" class="tscroll"><table><tbody>${skeletonRows(5, 2)}</tbody></table></div></section>
        </div>`;

    function kpi({ tone = '', symbol, label, value, valueClass = '', note, href }) {
        const tag = href ? 'a' : 'div';
        return `<${tag} class="kpi ${tone}"${href ? ` href="${href}"` : ''}>
            <span class="label">${icon(symbol)}${esc(label)}</span>
            <strong class="${valueClass}">${value}</strong><small>${note}</small></${tag}>`;
    }

    function render() {
        const { counts } = data;
        context.setAlertCount(counts);
        if (counts.total === 0) {
            root.innerHTML = `<div class="panel">${stateBox({
                kind: 'info',
                title: 'No meters have reported yet',
                detail: 'A meter appears here after the server stores its first valid packet.',
            })}</div>`;
            return;
        }
        if (!root.querySelector('.kpis')) root.innerHTML = LAYOUT;

        const last = data.last_packet;
        const lastNote = last
            ? `${agoText(last.received_at)} · ${esc(last.source_device_uid || 'unknown device')}<br>${int(data.packets_today)} packets today`
            : 'No packets received';
        const onlineWindow = durationText(settings.onlineAfterSeconds);
        const offlineWindow = durationText(settings.offlineAfterSeconds);

        root.querySelector('.kpis').innerHTML = [
            kpi({ symbol: 'meter', label: 'Total meters', value: int(counts.total), note: counts.never ? `${counts.never} without valid data` : 'Reported at least once', href: '#/meters' }),
            kpi({ tone: 'ok', symbol: 'ok', label: 'Online', value: int(counts.online), note: `Packet within ${onlineWindow}`, href: '#/meters?status=online' }),
            kpi({ tone: counts.delayed ? 'warn' : '', symbol: 'clock', label: 'Delayed', value: int(counts.delayed), note: `${onlineWindow} – ${offlineWindow} since packet`, href: '#/meters?status=delayed' }),
            kpi({ tone: counts.offline ? 'bad' : '', symbol: 'x', label: 'Offline', value: int(counts.offline), note: `No packet for ${offlineWindow}+`, href: '#/meters?status=offline' }),
            kpi({ tone: data.rejected_last_24h ? 'bad' : '', symbol: 'warn', label: 'Rejected packets', value: int(data.rejected_last_24h), note: counts.rejected ? `Last 24 hours · ${counts.rejected} meter(s) affected now` : 'Last 24 hours', href: '#/packets?status=invalid' }),
            kpi({ symbol: 'inbox', label: 'Last packet', value: esc(last ? shortTime(last.received_at) : '—'), valueClass: 'time', note: lastNote }),
        ].join('');

        const attention = data.attention;
        root.querySelector('#attentionCount').textContent = attention.length ? `${attention.length} meter${attention.length === 1 ? '' : 's'}` : '';
        root.querySelector('#attentionBody').innerHTML = attention.length
            ? `<div class="tscroll"><table class="cards"><thead><tr><th>Meter</th><th>Status</th><th>Last valid packet</th><th class="p2">Detail</th></tr></thead><tbody>
                ${attention.map((meter) => `<tr>
                    <td class="full"><a class="link" href="#/meters/${encodeURIComponent(meter.device_uid)}">${esc(meter.meter_serial || meter.device_uid)}</a><span class="sub">${esc(meter.device_uid)}</span></td>
                    <td data-l="Status">${statusBadge(meter.status)}</td>
                    <td data-l="Last valid packet">${timeCell(meter.last_received_at)}</td>
                    <td class="p2 wrap" data-l="Detail">${esc(meter.issues.join(' · ') || '—')}</td>
                </tr>`).join('')}</tbody></table></div>`
            : stateBox({ kind: 'good', title: 'All meters are online', detail: `Every meter sent a valid packet within ${onlineWindow}.` });

        root.querySelector('#manufacturerBody').innerHTML = `<table><thead><tr><th>Manufacturer</th><th class="num">Online</th><th class="num">Delayed</th><th class="num">Offline</th><th class="num">Rejected</th></tr></thead><tbody>
            ${data.by_manufacturer.map((row) => `<tr><td>${esc(row.manufacturer)}</td><td class="num">${int(row.online)}</td><td class="num">${int(row.delayed)}</td><td class="num">${int(row.offline)}</td><td class="num">${int(row.rejected)}</td></tr>`).join('')}
            </tbody></table>`;
    }

    return {
        mount(element) {
            root = element;
            context.setCrumb('Fleet overview');
            root.innerHTML = LAYOUT;
            root.addEventListener('click', (event) => {
                if (event.target.closest('[data-action=retry]')) context.reload('manual');
            });
        },
        async load(signal) {
            data = await api('/api/fleet', { signal });
            render();
        },
        refreshMs: () => REFRESH_MS,
        hasData: () => Boolean(data),
        showError(error) {
            root.innerHTML = `<div class="panel">${errorBox(error)}</div>`;
        },
    };
}
