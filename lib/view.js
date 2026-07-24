'use strict';

const { addDays, displayDate, daysBetween } = require('./time');

const CANONICAL_ORIGIN = process.env.CANONICAL_ORIGIN || 'https://willyernarplayleague.aolabs.io';
const PREVIEW_URL = 'https://aolabs.io/previews/willyernarplayleague-20260723.png';
const CHART_LAYOUTS = Object.freeze({
  desktop: {
    width: 640,
    height: 262,
    left: 62,
    right: 626,
    top: 20,
    middle: 116,
    bottom: 212,
    axisX: 53,
    labelY: 240,
    yLabelX: 16,
    yLabelY: 116,
    pointRadius: 2.4
  },
  mobile: {
    width: 360,
    height: 210,
    left: 52,
    right: 348,
    top: 16,
    middle: 82,
    bottom: 148,
    axisX: 44,
    labelY: 182,
    yLabelX: 14,
    yLabelY: 82,
    pointRadius: 1.8
  }
});

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeJson(value) {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

function shortDate(dateKey) {
  const [, month, day] = dateKey.split('-').map(Number);
  return `${month}/${day}`;
}

function chartGeometry(chart, layoutName = 'desktop') {
  const layout = CHART_LAYOUTS[layoutName] || CHART_LAYOUTS.desktop;
  const issued = [...(chart.issued || [])].sort((a, b) => a.targetDay.localeCompare(b.targetDay));
  const outlook = [...(chart.outlook || [])].sort((a, b) => a.targetDay.localeCompare(b.targetDay));
  const activeDay = chart.activeDay
    || issued.at(-1)?.targetDay
    || (outlook[0] ? addDays(outlook[0].targetDay, -1) : null);
  const windowStart = chart.windowStart || (activeDay ? addDays(activeDay, -30) : null);
  const windowEnd = chart.windowEnd || (activeDay ? addDays(activeDay, 30) : null);
  if (!activeDay || !windowStart || !windowEnd) {
    return { past: [], future: [], issued: [], outlook: [], ticks: [], layout, activeDay, windowStart, windowEnd };
  }
  const span = Math.max(1, daysBetween(windowStart, windowEnd));
  const pointY = (item) => layout.top + (1 - item.probability) * (layout.bottom - layout.top);
  const pointX = (targetDay) => (
    layout.left + (daysBetween(windowStart, targetDay) / span) * (layout.right - layout.left)
  );
  const placeSeries = (items) => items.map((item) => ({
      ...item,
      x: pointX(item.targetDay),
      y: pointY(item)
    }));
  const past = placeSeries(issued.filter((item) => (
    item.targetDay >= windowStart && item.targetDay <= activeDay
  )));
  const future = placeSeries(outlook.filter((item) => (
    item.targetDay > activeDay && item.targetDay <= windowEnd
  )));
  const ticks = [];
  for (let offset = 0; offset <= span; offset += 10) {
    const targetDay = addDays(windowStart, offset);
    ticks.push({ targetDay, x: pointX(targetDay), active: targetDay === activeDay });
  }
  if (ticks.at(-1)?.targetDay !== windowEnd) {
    ticks.push({ targetDay: windowEnd, x: pointX(windowEnd), active: windowEnd === activeDay });
  }
  return {
    past,
    future,
    issued: past,
    outlook: future,
    ticks,
    layout,
    activeDay,
    windowStart,
    windowEnd,
    activeX: pointX(activeDay)
  };
}

function pointString(points) {
  return points.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ');
}

function continuousSegments(points) {
  const segments = [];
  for (const point of points) {
    const current = segments.at(-1);
    if (!current || daysBetween(current.at(-1).targetDay, point.targetDay) !== 1) {
      segments.push([point]);
    } else {
      current.push(point);
    }
  }
  return segments;
}

function renderChartSvg(chart, layoutName) {
  const geometry = chartGeometry(chart, layoutName);
  const { layout } = geometry;
  const suffix = layoutName === 'desktop' ? '' : '-mobile';
  const describe = (label, points) => points.length
    ? `${label}: ${points.map((point) => `${displayDate(point.targetDay)} ${point.percent}%`).join(', ')}.`
    : `${label}: no data.`;
  const description = `${describe('Past', geometry.past)} ${describe('Future', geometry.future)}`;
  const renderLines = (points, kind) => continuousSegments(points)
    .filter((segment) => segment.length > 1)
    .map((segment) => `<polyline class="chart-line chart-line-${kind}" points="${pointString(segment)}"/>`)
    .join('');
  const renderPoints = (points, kind) => points.map((point) => (
    `<circle class="chart-point chart-point-${kind}" cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="${layout.pointRadius}"><title>${escapeHtml(`${displayDate(point.targetDay)}: ${point.percent}% ${kind}`)}</title></circle>`
  )).join('');
  const ticks = geometry.ticks.map((tick) => (
    `<line class="chart-x-tick" x1="${tick.x.toFixed(2)}" y1="${layout.bottom}" x2="${tick.x.toFixed(2)}" y2="${layout.bottom + 5}"/><text class="chart-date${tick.active ? ' chart-date-active' : ''}" x="${tick.x.toFixed(2)}" y="${layout.labelY}" text-anchor="middle">${shortDate(tick.targetDay)}</text>`
  )).join('');

  return `<svg class="chart-svg chart-svg-${layoutName}" viewBox="0 0 ${layout.width} ${layout.height}" role="img" aria-labelledby="chart-title${suffix} chart-description${suffix}" data-chart="${layoutName}">
      <title id="chart-title${suffix}">yernar league probability, past and future</title>
      <desc id="chart-description${suffix}">${escapeHtml(description)}</desc>
      <line class="chart-grid" x1="${layout.left}" y1="${layout.top}" x2="${layout.right}" y2="${layout.top}"/>
      <line class="chart-grid" x1="${layout.left}" y1="${layout.middle}" x2="${layout.right}" y2="${layout.middle}"/>
      <line class="chart-grid" x1="${layout.left}" y1="${layout.bottom}" x2="${layout.right}" y2="${layout.bottom}"/>
      <line class="chart-active-boundary" x1="${geometry.activeX.toFixed(2)}" y1="${layout.top}" x2="${geometry.activeX.toFixed(2)}" y2="${layout.bottom}"/>
      <text class="chart-y-label" x="${layout.yLabelX}" y="${layout.yLabelY}" text-anchor="middle" transform="rotate(-90 ${layout.yLabelX} ${layout.yLabelY})">probability</text>
      <text class="chart-axis-label" x="${layout.axisX}" y="${layout.top + 4}" text-anchor="end">100%</text>
      <text class="chart-axis-label" x="${layout.axisX}" y="${layout.middle + 4}" text-anchor="end">50%</text>
      <text class="chart-axis-label" x="${layout.axisX}" y="${layout.bottom + 4}" text-anchor="end">0%</text>
      ${ticks}
      ${renderLines(geometry.past, 'past')}
      ${renderLines(geometry.future, 'future')}
      ${renderPoints(geometry.past, 'past')}
      ${renderPoints(geometry.future, 'future')}
    </svg>`;
}

function renderChart(chart) {
  return `<section class="probability-chart" aria-labelledby="chart-heading">
    <h2 id="chart-heading" class="sr-only">league probability chart</h2>
    <div class="chart-legend" aria-label="chart legend">
      <span><i class="legend-line legend-past" aria-hidden="true"></i>past</span>
      <span><i class="legend-line legend-future" aria-hidden="true"></i>future</span>
    </div>
    ${renderChartSvg(chart, 'desktop')}
    ${renderChartSvg(chart, 'mobile')}
  </section>`;
}

function renderPrediction(state) {
  const action = state.canRecordDidNotPlay ? renderExceptionAction(state.actionLabel) : '';
  return `<section class="prediction" aria-live="polite" aria-atomic="true">
    <p class="prediction-statement" data-statement>${escapeHtml(state.statement)}</p>
    ${action ? `<div class="answer-area" data-answer-area>${action}</div>` : ''}
    <p class="save-status" role="status" data-status></p>
  </section>`;
}

function renderExceptionAction(label = "yernar didn't play league") {
  return `<div class="answer-buttons">
      <button class="answer-button answer-exception" type="button" data-played="false">${escapeHtml(label)}</button>
    </div>`;
}

function renderHistory(history) {
  return `<section class="history" aria-labelledby="history-heading">
    <h2 id="history-heading">history</h2>
    <ol data-history>
      ${history.map((entry) => `<li>${escapeHtml(entry.text)}</li>`).join('')}
    </ol>
  </section>`;
}

function renderPage(state, options = {}) {
  const canonicalOrigin = (options.canonicalOrigin || CANONICAL_ORIGIN).replace(/\/$/, '');
  const canonicalUrl = `${canonicalOrigin}/`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#f5efe6">
    <title>will yernar play league?</title>
    <meta name="description" content="daily yernar league probability and result history.">
    <link rel="canonical" href="${escapeHtml(canonicalUrl)}">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="AO Labs">
    <meta property="og:title" content="will yernar play league?">
    <meta property="og:description" content="daily yernar league probability and result history.">
    <meta property="og:url" content="${escapeHtml(canonicalUrl)}">
    <meta property="og:image" content="${PREVIEW_URL}">
    <meta property="og:image:secure_url" content="${PREVIEW_URL}">
    <meta property="og:image:type" content="image/png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta property="og:image:alt" content="will yernar play league? preview card.">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="will yernar play league?">
    <meta name="twitter:description" content="daily yernar league probability and result history.">
    <meta name="twitter:image" content="${PREVIEW_URL}">
    <meta name="twitter:image:alt" content="will yernar play league? preview card.">
    <link rel="icon" href="/icon.svg?v=20260723" type="image/svg+xml">
    <link rel="apple-touch-icon" href="/icon.svg?v=20260723">
    <link rel="manifest" href="/site.webmanifest">
    <meta name="apple-mobile-web-app-title" content="yernar league">
    <meta name="application-name" content="will yernar play league?">
    <link rel="stylesheet" href="/styles.css?v=20260724-plot61">
    <script src="/app.js?v=20260724-plot61" defer></script>
  </head>
  <body>
    <header class="suite-topbar" aria-label="will yernar play league navigation">
      <div class="suite-brand-cluster">
        <a class="suite-ao-home" href="https://aolabs.io/" aria-label="aolabs.io">
          <img src="https://aolabs.io/marks/ao-ink.svg?v=20260516-suite-bloom" alt="">
        </a>
        <a class="suite-app-brand" href="/" aria-label="will yernar play league home">
          <img class="suite-app-mark" src="/icon.svg?v=20260723" alt="">
          <span class="suite-app-name">will yernar play league?</span>
        </a>
      </div>
    </header>
    <main>
      <h1 class="sr-only">will yernar play league?</h1>
      <div class="forecast-layout">
        <div data-prediction-root>${renderPrediction(state)}</div>
        <div data-chart-root>${renderChart(state.chart)}</div>
      </div>
      <div data-history-root>${renderHistory(state.history)}</div>
    </main>
    <script type="application/json" id="initial-state">${escapeJson(state)}</script>
  </body>
</html>`;
}

module.exports = {
  PREVIEW_URL,
  chartGeometry,
  escapeHtml,
  escapeJson,
  renderChart,
  renderHistory,
  renderPage,
  renderPrediction,
  renderExceptionAction
};
