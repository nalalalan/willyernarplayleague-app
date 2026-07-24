'use strict';

const { displayDate, daysBetween } = require('./time');

const CANONICAL_ORIGIN = process.env.CANONICAL_ORIGIN || 'https://willyernarplayleague.aolabs.io';
const PREVIEW_URL = 'https://aolabs.io/previews/willyernarplayleague-20260723.png';
const CHART_LAYOUTS = Object.freeze({
  desktop: {
    width: 680,
    height: 218,
    left: 58,
    right: 642,
    historyRight: 370,
    outlookLeft: 400,
    top: 22,
    middle: 99,
    bottom: 176,
    axisX: 47,
    labelY: 204
  },
  mobile: {
    width: 360,
    height: 170,
    left: 42,
    right: 344,
    historyRight: 110,
    outlookLeft: 122,
    top: 10,
    middle: 66,
    bottom: 122,
    axisX: 34,
    labelY: 160
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
  const issued = (chart.issued || []).slice(-28);
  const outlook = chart.outlook || [];
  const pointY = (item) => layout.top + (1 - item.probability) * (layout.bottom - layout.top);
  const placeSeries = (items, startX, endX, singleX = endX) => {
    if (items.length === 0) return [];
    if (items.length === 1) return [{ ...items[0], x: singleX, y: pointY(items[0]) }];
    const firstDay = items[0].targetDay;
    const lastDay = items[items.length - 1].targetDay;
    const span = Math.max(1, daysBetween(firstDay, lastDay));
    return items.map((item) => ({
      ...item,
      x: startX + (daysBetween(firstDay, item.targetDay) / span) * (endX - startX),
      y: pointY(item)
    }));
  };
  const hasIssued = issued.length > 0;
  return {
    issued: placeSeries(issued, layout.left, layout.historyRight),
    outlook: placeSeries(
      outlook,
      hasIssued ? layout.outlookLeft : layout.left,
      layout.right,
      hasIssued ? layout.outlookLeft : layout.left
    ),
    layout
  };
}

function pointString(points) {
  return points.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ');
}

function renderChartSvg(chart, layoutName) {
  const geometry = chartGeometry(chart, layoutName);
  const { layout } = geometry;
  const suffix = layoutName === 'desktop' ? '' : '-mobile';
  const descriptionParts = [];
  if (geometry.issued.length) {
    descriptionParts.push(`Issued forecasts: ${geometry.issued.map((point) => `${displayDate(point.targetDay)} ${point.percent}%`).join(', ')}.`);
  } else {
    descriptionParts.push('No issued historical forecasts yet.');
  }
  descriptionParts.push(`Seven-day outlook: ${geometry.outlook.map((point) => `${displayDate(point.targetDay)} ${point.percent}%`).join(', ')}.`);
  const description = descriptionParts.join(' ');

  const issuedLine = geometry.issued.length > 1
    ? `<polyline class="chart-line chart-line-issued" points="${pointString(geometry.issued)}"/>`
    : '';
  const outlookLine = geometry.outlook.length > 1
    ? `<polyline class="chart-line chart-line-outlook" points="${pointString(geometry.outlook)}"/>`
    : '';
  const issuedPoints = geometry.issued.map((point) => (
    `<circle class="chart-point chart-point-issued" cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="4"><title>${escapeHtml(`${displayDate(point.targetDay)}: ${point.percent}% issued`)}</title></circle>`
  )).join('');
  const outlookPoints = geometry.outlook.map((point) => (
    `<circle class="chart-point chart-point-outlook" cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="3.5"><title>${escapeHtml(`${displayDate(point.targetDay)}: ${point.percent}% outlook`)}</title></circle>`
  )).join('');
  const outlookLabels = geometry.outlook.map((point) => {
    const valueY = Math.max(layout.top - 8, point.y - 11);
    return `<text class="chart-value" x="${point.x.toFixed(2)}" y="${valueY.toFixed(2)}" text-anchor="middle">${point.percent}%</text><text class="chart-date" x="${point.x.toFixed(2)}" y="${layout.labelY}" text-anchor="middle">${shortDate(point.targetDay)}</text>`;
  }).join('');

  return `<svg class="chart-svg chart-svg-${layoutName}" viewBox="0 0 ${layout.width} ${layout.height}" role="img" aria-labelledby="chart-title${suffix} chart-description${suffix}" data-chart="${layoutName}">
      <title id="chart-title${suffix}">league probability over time</title>
      <desc id="chart-description${suffix}">${escapeHtml(description)}</desc>
      <line class="chart-grid" x1="${layout.left}" y1="${layout.top}" x2="${layout.right}" y2="${layout.top}"/>
      <line class="chart-grid" x1="${layout.left}" y1="${layout.middle}" x2="${layout.right}" y2="${layout.middle}"/>
      <line class="chart-grid" x1="${layout.left}" y1="${layout.bottom}" x2="${layout.right}" y2="${layout.bottom}"/>
      <text class="chart-axis-label" x="${layout.axisX}" y="${layout.top + 4}" text-anchor="end">100%</text>
      <text class="chart-axis-label" x="${layout.axisX}" y="${layout.middle + 4}" text-anchor="end">50%</text>
      <text class="chart-axis-label" x="${layout.axisX}" y="${layout.bottom + 4}" text-anchor="end">0%</text>
      ${issuedLine}
      ${outlookLine}
      ${issuedPoints}
      ${outlookPoints}
      ${outlookLabels}
    </svg>`;
}

function renderChart(chart) {

  return `<section class="probability-chart" aria-labelledby="chart-heading">
    <div class="chart-heading-row">
      <h2 id="chart-heading">probability over time</h2>
      <div class="chart-legend" aria-label="chart legend">
        <span><i class="legend-line legend-issued" aria-hidden="true"></i>issued</span>
        <span><i class="legend-line legend-outlook" aria-hidden="true"></i>7-day outlook</span>
      </div>
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
    <link rel="stylesheet" href="/styles.css?v=20260724">
    <script src="/app.js?v=20260724" defer></script>
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
      <div data-chart-root>${renderChart(state.chart)}</div>
      <div data-prediction-root>${renderPrediction(state)}</div>
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
