// Small SVG charts for the Overview page (no chart library: two chart types don't justify ~200KB).
// Colours are set as SVG attributes and positions through element.style, both allowed by the dashboard CSP.

const SVG_NS = 'http://www.w3.org/2000/svg';
const HEIGHT = 190;
const PAD = { top: 10, right: 6, bottom: 24, left: 40 };
const MAX_BAR = 24;     // Bars never fill their slot; the leftover is air
const RADIUS = 4;       // Rounded data end, square at the baseline
const GAP = 2;          // Surface-coloured gap between stacked segments

// Colours come from theme.css (--chart-*); it loads before any module script runs
const theme = getComputedStyle(document.documentElement);
const themeColor = (name) => theme.getPropertyValue(name).trim();
const GRID = themeColor('--chart-grid');
const AXIS_TEXT = themeColor('--chart-axis');
const HOVER_BAND = themeColor('--chart-hover');
export const SERIES_COLORS = ['--chart-series-1', '--chart-series-2', '--chart-series-3'].map(themeColor);

const dayLabel = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const dayLong = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

function svg(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
    return node;
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

/** Local date from 'YYYY-MM-DD' (new Date('2026-11-04') would be UTC midnight, the day before in the Americas). */
function parseDay(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d);
}

/** Clean axis maximum (1, 2, 2.5, 5 × 10^n); even for counts so the midpoint tick is a whole number. */
function niceMax(value, integer) {
    if (value <= 0) return integer ? 2 : 1;
    const magnitude = 10 ** Math.floor(Math.log10(value));
    const step = [1, 2, 2.5, 5, 10].find((s) => s * magnitude >= value) * magnitude;
    if (!integer) return step;
    const whole = Math.max(2, Math.ceil(step));
    return whole % 2 ? whole + 1 : whole;
}

/** Rectangle with only the top corners rounded. */
function columnPath(x, y, width, height, round) {
    const r = round ? Math.min(RADIUS, height, width / 2) : 0;
    return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
}

/**
 * Daily column chart; several series stack in the given order.
 * series: [{ label, values, color }], plus optional { tooltipOnly: true } rows shown in the tooltip but not drawn.
 * The legend only appears for two or more drawn series (one series is named by the card title).
 */
export function columnChart({ days, series, format = (v) => v.toLocaleString(), integer = true, label }) {
    const drawn = series.filter((s) => !s.tooltipOnly);
    const wrap = el('div', 'chart');
    if (drawn.length > 1) {
        const legend = el('div', 'chart-legend');
        for (const s of drawn) {
            const item = el('span', 'legend-item');
            const swatch = el('span', 'legend-swatch');
            swatch.style.background = s.color;
            item.append(swatch, s.label);
            legend.append(item);
        }
        wrap.append(legend);
    }

    const plot = el('div', 'chart-plot');
    const tooltip = el('div', 'chart-tooltip');
    tooltip.hidden = true;
    plot.append(tooltip);
    wrap.append(plot);

    // Screen readers (and anyone without a mouse) get the same numbers as a table
    const table = el('table', 'sr-only');
    table.append(el('caption', null, label));
    const head = table.createTHead().insertRow();
    head.append(el('th', null, 'Day'), ...series.map((s) => el('th', null, s.label)));
    const body = table.createTBody();
    days.forEach((day, i) => {
        const row = body.insertRow();
        row.append(el('td', null, dayLong.format(parseDay(day))), ...series.map((s) => el('td', null, format(s.values[i]))));
    });
    wrap.append(table);

    const totals = days.map((_, i) => drawn.reduce((sum, s) => sum + s.values[i], 0));
    const max = niceMax(Math.max(0, ...totals), integer);

    function draw() {
        const width = plot.clientWidth;
        if (!width) return;
        plot.querySelector('svg')?.remove();
        const chart = svg('svg', { width, height: HEIGHT, viewBox: `0 0 ${width} ${HEIGHT}`, role: 'img', 'aria-label': label });
        const plotW = width - PAD.left - PAD.right;
        const plotH = HEIGHT - PAD.top - PAD.bottom;
        const slot = plotW / days.length;
        const barW = Math.max(2, Math.min(MAX_BAR, slot * 0.62));
        const y = (v) => PAD.top + plotH - (v / max) * plotH;

        // Hairline gridlines with clean ticks: 0, half, max
        for (const tick of [0, max / 2, max]) {
            chart.append(svg('line', { x1: PAD.left, x2: width - PAD.right, y1: y(tick), y2: y(tick), stroke: GRID, 'stroke-width': 1 }));
            const text = svg('text', { x: PAD.left - 8, y: y(tick) + 4, 'text-anchor': 'end', fill: AXIS_TEXT, 'font-size': 11 });
            text.textContent = format(tick);
            chart.append(text);
        }

        const band = svg('rect', { y: PAD.top, height: plotH, width: slot, fill: HOVER_BAND, rx: 6, visibility: 'hidden' });
        chart.append(band);

        days.forEach((day, i) => {
            const x = PAD.left + i * slot + (slot - barW) / 2;
            let base = 0;
            const top = drawn.findLastIndex((s) => s.values[i] > 0);
            drawn.forEach((s, si) => {
                const value = s.values[i];
                if (value <= 0) return;
                const y0 = y(base);
                const y1 = y(base + value);
                // Segments above the first leave a surface gap below them
                const gapBelow = base > 0 ? GAP : 0;
                const height = Math.max(1, y0 - y1 - gapBelow);
                chart.append(svg('path', { d: columnPath(x, y1, barW, height, si === top), fill: s.color }));
                base += value;
            });
        });

        // X labels: first, middle and last day only
        const labelled = days.length > 2 ? [0, Math.floor((days.length - 1) / 2), days.length - 1] : days.map((_, i) => i);
        for (const i of labelled) {
            const anchor = i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle';
            const cx = i === 0 ? PAD.left : i === days.length - 1 ? width - PAD.right : PAD.left + (i + 0.5) * slot;
            const text = svg('text', { x: cx, y: HEIGHT - 6, 'text-anchor': anchor, fill: AXIS_TEXT, 'font-size': 11 });
            text.textContent = dayLabel.format(parseDay(days[i]));
            chart.append(text);
        }

        // Hit targets cover the whole slot, so thin bars are still easy to hover
        days.forEach((day, i) => {
            const hit = svg('rect', { x: PAD.left + i * slot, y: PAD.top, width: slot, height: plotH, fill: 'transparent' });
            hit.addEventListener('pointerenter', () => showTip(i, PAD.left + (i + 0.5) * slot));
            chart.append(hit);
        });
        chart.addEventListener('pointerleave', () => { tooltip.hidden = true; band.setAttribute('visibility', 'hidden'); });

        function showTip(i, cx) {
            band.setAttribute('x', PAD.left + i * slot);
            band.setAttribute('visibility', 'visible');
            tooltip.replaceChildren(el('div', 'tip-head', dayLong.format(parseDay(days[i]))));
            for (const s of series) {
                const row = el('div', 'tip-row');
                const key = el('span', 'legend-swatch');
                if (s.tooltipOnly) key.classList.add('legend-swatch-none');
                else key.style.background = s.color;
                row.append(key, el('span', null, s.label), el('strong', null, format(s.values[i])));
                tooltip.append(row);
            }
            tooltip.hidden = false;
            // Keep the tooltip inside the card
            const tipW = tooltip.offsetWidth;
            tooltip.style.left = `${Math.min(Math.max(cx - tipW / 2, 0), width - tipW)}px`;
        }

        plot.prepend(chart);
    }

    new ResizeObserver(draw).observe(plot);
    return wrap;
}

/** One horizontal bar split into shares, with a legend that carries the numbers. items: [{ label, value, color }] */
export function shareBar(items, { label }) {
    const total = items.reduce((sum, item) => sum + item.value, 0);
    const wrap = el('div', 'share');
    const bar = el('div', 'share-bar');
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', `${label}: ` + items.map((i) => `${i.label} ${i.value}`).join(', '));
    for (const item of items) {
        if (!item.value) continue;
        const segment = el('span', 'share-seg');
        segment.style.flexGrow = item.value;
        segment.style.background = item.color;
        bar.append(segment);
    }
    if (!total) bar.classList.add('share-empty');
    const legend = el('div', 'share-legend');
    for (const item of items) {
        const row = el('div', 'share-row');
        const swatch = el('span', 'legend-swatch');
        swatch.style.background = item.color;
        const pct = total ? Math.round((item.value / total) * 100) : 0;
        row.append(swatch, el('span', 'share-label', item.label), el('strong', null, item.value.toLocaleString()),
            el('span', 'muted', `${pct}%`));
        legend.append(row);
    }
    wrap.append(bar, legend);
    return wrap;
}

export function compactNumber(value) {
    return value >= 1000 ? compact.format(value) : value.toLocaleString();
}
