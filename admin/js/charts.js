// Inline SVG charts. Monochrome by brand rule: the value ramp carries the data,
// never hue. Every chart degrades to a labelled empty state with no data.

import { el, shortMoney, money } from './ui.js';

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

/** Shared gradient/gloss defs — injected once per chart. */
function defs() {
  const d = svgEl('defs');
  d.innerHTML = `
    <linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#E8EBED" stop-opacity="0.95"/>
      <stop offset="100%" stop-color="#53585D" stop-opacity="0.55"/>
    </linearGradient>
    <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#E8EBED" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="#E8EBED" stop-opacity="0"/>
    </linearGradient>`;
  return d;
}

function emptyChart(message) {
  return el('div', { class: 'chart-empty' }, message);
}

/**
 * Vertical bar chart with a value axis and hover tooltips.
 * `series`: [{ label, value }]
 */
export function barChart(series, { height = 200, format = shortMoney } = {}) {
  if (!series.length || series.every((s) => !s.value)) {
    return emptyChart('No income recorded in this window yet.');
  }

  const W = 640, H = height, padL = 46, padR = 10, padT = 16, padB = 26;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const max = Math.max(...series.map((s) => s.value)) || 1;
  const niceMax = Math.ceil(max / 100) * 100 || 100;
  const slot = innerW / series.length;
  const barW = Math.min(slot * 0.56, 34);

  const svg = svgEl('svg', {
    class: 'chart', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none',
    role: 'img', 'aria-label': `Bar chart, peak ${format(max)}`
  });
  svg.append(defs());

  // gridlines + y axis
  const grid = svgEl('g', { class: 'chart-grid' });
  for (let i = 0; i <= 4; i++) {
    const y = padT + (innerH / 4) * i;
    grid.append(svgEl('line', { x1: padL, y1: y, x2: W - padR, y2: y }));
    const label = svgEl('text', { class: 'chart-axis', x: padL - 8, y: y + 3.5, 'text-anchor': 'end' });
    label.textContent = format(niceMax - (niceMax / 4) * i);
    grid.append(label);
  }
  svg.append(grid);

  series.forEach((point, i) => {
    const h = Math.max((point.value / niceMax) * innerH, point.value > 0 ? 2 : 0);
    const x = padL + slot * i + (slot - barW) / 2;
    const y = padT + innerH - h;

    const bar = svgEl('rect', { class: 'bar', x, y, width: barW, height: h, rx: 3 });
    const tip = svgEl('title');
    tip.textContent = `${point.label}: ${money(point.value)}`;
    bar.append(tip);
    svg.append(bar);

    const label = svgEl('text', {
      class: 'chart-axis', x: x + barW / 2, y: H - 8, 'text-anchor': 'middle'
    });
    label.textContent = point.label;
    svg.append(label);
  });

  return svg;
}

/**
 * Cumulative area + line chart, with an optional horizontal target rule.
 * `series`: [{ label, value }]
 */
export function areaChart(series, { height = 200, target = 0, format = shortMoney } = {}) {
  if (series.length < 2) return emptyChart('Not enough history to plot a trend yet.');

  const W = 640, H = height, padL = 46, padR = 10, padT = 16, padB = 26;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const max = Math.max(...series.map((s) => s.value), target) || 1;
  const niceMax = Math.ceil(max / 100) * 100 || 100;

  const x = (i) => padL + (innerW / (series.length - 1)) * i;
  const y = (v) => padT + innerH - (v / niceMax) * innerH;

  const svg = svgEl('svg', {
    class: 'chart', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none',
    role: 'img', 'aria-label': `Trend chart, latest ${format(series.at(-1).value)}`
  });
  svg.append(defs());

  const grid = svgEl('g', { class: 'chart-grid' });
  for (let i = 0; i <= 4; i++) {
    const gy = padT + (innerH / 4) * i;
    grid.append(svgEl('line', { x1: padL, y1: gy, x2: W - padR, y2: gy }));
    const label = svgEl('text', { class: 'chart-axis', x: padL - 8, y: gy + 3.5, 'text-anchor': 'end' });
    label.textContent = format(niceMax - (niceMax / 4) * i);
    grid.append(label);
  }
  svg.append(grid);

  const line = series.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.value)}`).join(' ');
  svg.append(svgEl('path', {
    class: 'spark-area',
    d: `${line} L${x(series.length - 1)},${padT + innerH} L${padL},${padT + innerH} Z`
  }));
  svg.append(svgEl('path', { class: 'spark-line', d: line }));

  if (target > 0 && target <= niceMax) {
    svg.append(svgEl('line', {
      x1: padL, y1: y(target), x2: W - padR, y2: y(target),
      stroke: '#D9B36A', 'stroke-width': 1.2, 'stroke-dasharray': '5 4', opacity: '.7'
    }));
    const tag = svgEl('text', { class: 'chart-axis', x: W - padR, y: y(target) - 6, 'text-anchor': 'end', fill: '#D9B36A' });
    tag.textContent = `Target ${format(target)}`;
    svg.append(tag);
  }

  series.forEach((point, i) => {
    const dot = svgEl('circle', { cx: x(i), cy: y(point.value), r: 3, fill: '#E8EBED' });
    const tip = svgEl('title');
    tip.textContent = `${point.label}: ${money(point.value)}`;
    dot.append(tip);
    svg.append(dot);

    if (i % Math.ceil(series.length / 8) === 0 || i === series.length - 1) {
      const label = svgEl('text', { class: 'chart-axis', x: x(i), y: H - 8, 'text-anchor': 'middle' });
      label.textContent = point.label;
      svg.append(label);
    }
  });

  return svg;
}

/**
 * Donut chart with a centred total. Segments use a light-to-dark value ramp,
 * and the legend repeats the value so colour is never the only channel.
 */
export function donutChart(series, { size = 168, centreLabel = 'Total' } = {}) {
  const total = series.reduce((t, s) => t + s.value, 0);
  if (!total) return emptyChart('No revenue attributed yet.');

  const RAMP = ['#E8EBED', '#B8BDC2', '#989CA0', '#6E7378', '#53585D', '#3A3F44'];
  const r = size / 2, stroke = 20, radius = r - stroke / 2 - 2;
  const circumference = 2 * Math.PI * radius;

  const svg = svgEl('svg', {
    class: 'chart', viewBox: `0 0 ${size} ${size}`, width: size, height: size,
    role: 'img', 'aria-label': `Donut chart, total ${money(total)}`
  });

  let offset = 0;
  series.forEach((slice, i) => {
    const fraction = slice.value / total;
    const arc = svgEl('circle', {
      cx: r, cy: r, r: radius, fill: 'none',
      stroke: RAMP[i % RAMP.length], 'stroke-width': stroke,
      'stroke-dasharray': `${fraction * circumference} ${circumference}`,
      'stroke-dashoffset': -offset,
      transform: `rotate(-90 ${r} ${r})`
    });
    const tip = svgEl('title');
    tip.textContent = `${slice.label}: ${money(slice.value)} (${Math.round(fraction * 100)}%)`;
    arc.append(tip);
    svg.append(arc);
    offset += fraction * circumference;
  });

  const value = svgEl('text', {
    x: r, y: r - 2, 'text-anchor': 'middle',
    fill: '#fff', 'font-family': 'Archivo, sans-serif', 'font-weight': '900',
    'font-size': '19', 'letter-spacing': '-0.5'
  });
  value.textContent = shortMoney(total);
  svg.append(value);

  const caption = svgEl('text', {
    x: r, y: r + 15, 'text-anchor': 'middle',
    fill: '#B8BDC2', 'font-family': 'Inter, sans-serif', 'font-size': '10.5'
  });
  caption.textContent = centreLabel;
  svg.append(caption);

  return svg;
}

/** Legend rows matched to the donut ramp. */
export function donutLegend(series) {
  const RAMP = ['#E8EBED', '#B8BDC2', '#989CA0', '#6E7378', '#53585D', '#3A3F44'];
  return el('div', { class: 'legend' },
    series.map((slice, i) => el('div', { class: 'legend-item' },
      el('span', { class: 'legend-swatch', style: `background:${RAMP[i % RAMP.length]}` }),
      el('span', { class: 'legend-label', title: slice.label }, slice.label),
      el('span', { class: 'legend-value' }, money(slice.value))
    ))
  );
}

/** Horizontal progress meter, 0–1. */
export function meter(fraction) {
  return el('div', { class: 'meter', role: 'progressbar',
    'aria-valuenow': Math.round(fraction * 100), 'aria-valuemin': '0', 'aria-valuemax': '100' },
    el('div', { class: 'meter-fill', style: `width:${Math.min(100, Math.max(0, fraction * 100))}%` })
  );
}
