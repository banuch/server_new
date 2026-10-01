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
        <section class="panel health" id="health"><span class="skeleton"></span></section>
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

    // Share of the fleet in each communication state; the legend repeats the
    // numbers so the bar is never the only carrier of meaning.
    function healthBar(counts) {
        const parts = [
            ['online', 'Online'], ['delayed', 'Delayed'], ['rejected', 'Last packet rejected'],
            ['offline', 'Offline'], ['never', 'No valid data'],
        ].filter(([key]) => counts[key] > 0);
        const share = Math.round((counts.online / counts.total) * 100);
        return `<div class="health-head"><strong>${share}% online</strong><span class="muted">${int(counts.online)} of ${int(counts.total)} meters reporting on time</span></div>
            <div class="health-bar" role="img" aria-label="${esc(parts.map(([key, label]) => `${label} ${counts[key]}`).join(', '))}">
                ${parts.map(([key, label]) => `<span class="seg ${key}" style="flex-grow:${counts[key]}" title="${esc(label)}: ${counts[key]}"></span>`).join('')}</div>
            <div class="health-legend">${parts.map(([key, label]) => `<a href="#/meters?status=${key}"><span class="dot ${key}"></span>${esc(label)} <b>${int(counts[key])}</b></a>`).join('')}</div>`;
    }

    // Packets per hour since local midnight; rejected packets stack on top.
    function hourBars() {
        const hours = data.packets_by_hour || [];
        const elapsed = Math.floor((new Date(data.generated_at) - new Date(data.day_start)) / 3_600_000);
        const max = Math.max(1, ...hours.map((hour) => hour.packets));
        const startHour = new Date(data.day_start);
        const bars = hours.map((hour, index) => {
            const x = index * 10;
            if (index > elapsed) return `<rect class="future" x="${x}" y="27" width="8" height="1"/>`;
            const total = hour.packets ? Math.max(2, (hour.packets / max) * 28) : 1;
            const bad = hour.rejected ? Math.max(1.5, (hour.rejected / max) * 28) : 0;
            const from = shortTime(new Date(startHour.getTime() + index * 3_600_000)).slice(0, 5);
            const title = `${from} · ${int(hour.packets)} packet${hour.packets === 1 ? '' : 's'}${hour.rejected ? `, ${int(hour.rejected)} rejected` : ''}`;
            return `<g><title>${esc(title)}</title><rect class="${hour.packets ? 'ok' : 'none'}" x="${x}" y="${28 - total}" width="8" height="${total}"/>${bad ? `<rect class="bad" x="${x}" y="${28 - total}" width="8" height="${Math.min(bad, total)}"/>` : ''}</g>`;
        }).join('');
        return `<svg class="hours" viewBox="0 0 238 28" preserveAspectRatio="none" role="img" aria-label="Packets per hour today">${bars}</svg>`;
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
            ? `${agoText(last.received_at)} · ${esc(last.source_device_uid || 'unknown device')}<br>${int(data.packets_today)} packets today${hourBars()}`
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
        root.querySelector('#health').innerHTML = healthBar(counts);

        const attention = data.attention;
        root.querySelector('#attentionCount').textContent = attention.length ? `${attention.length} meter${attention.length === 1 ? '' : 's'}` : '';
        root.querySelector('#attentionBody').innerHTML = attention.length
            ? `<div class="tscroll"><table class="cards"><thead><tr><th>Meter</th><th>Status</th><th>Last valid packet</th><th class="p2">Detail</th></tr></thead><tbody>
                ${attention.map((meter) => `<tr class="row-link" data-href="#/meters/${encodeURIComponent(meter.device_uid)}">
                    <td class="full"><a class="link" href="#/meters/${encodeURIComponent(meter.device_uid)}">${esc(meter.meter_serial || meter.device_uid)}</a><span class="sub">${esc([meter.device_uid, meter.manufacturer].filter(Boolean).join(' · '))}</span></td>
                    <td data-l="Status">${statusBadge(meter.status)}</td>
                    <td data-l="Last valid packet">${timeCell(meter.last_received_at)}</td>
                    <td class="p2 wrap" data-l="Detail">${esc(meter.issues.join(' · ') || '—')}</td>
                </tr>`).join('')}</tbody></table></div>`
            : stateBox({ kind: 'good', title: 'All meters are online', detail: `Every meter sent a valid packet within ${onlineWindow}.` });

        // Zeros are dimmed so non-zero problem counts stand out.
        const cell = (value, tone) => `<td class="num${value ? ` ${tone}` : ' zero'}">${int(value)}</td>`;
        const showNever = counts.never > 0;
        root.querySelector('#manufacturerBody').innerHTML = `<table><thead><tr><th>Manufacturer</th><th class="num">Online</th><th class="num">Delayed</th><th class="num">Offline</th>
            <th class="num" title="Meters whose latest packet was rejected">Rejected now</th>${showNever ? '<th class="num">No data</th>' : ''}<th class="num">Total</th></tr></thead><tbody>
            ${data.by_manufacturer.map((row) => {
                const total = row.online + row.delayed + row.offline + row.rejected + row.never;
                const href = row.manufacturer === 'Unknown' ? '' : `#/meters?manufacturer=${encodeURIComponent(row.manufacturer)}`;
                const name = href ? `<a class="link" href="${href}">${esc(row.manufacturer)}</a>` : esc(row.manufacturer);
                return `<tr${href ? ` class="row-link" data-href="${href}"` : ''}><td>${name}</td>${cell(row.online, '')}${cell(row.delayed, 'warn')}${cell(row.offline, 'bad')}${cell(row.rejected, 'bad')}${showNever ? cell(row.never, '') : ''}<td class="num total">${int(total)}</td></tr>`;
            }).join('')}
            </tbody></table>`;
    }

    return {
        mount(element) {
            root = element;
            context.setCrumb('Home');
            root.innerHTML = LAYOUT;
            root.addEventListener('click', (event) => {
                if (event.target.closest('[data-action=retry]')) context.reload('manual');
                // Whole rows open their target; real links inside keep normal behaviour.
                const row = event.target.closest('tr[data-href]');
                if (row && !event.target.closest('a') && !window.getSelection().toString()) location.hash = row.dataset.href;
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
