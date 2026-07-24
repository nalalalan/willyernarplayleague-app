'use strict';

const { chartGeometry, renderChart } = require('../public/chart');

const CANONICAL_ORIGIN = process.env.CANONICAL_ORIGIN || 'https://willyernarplayleague.aolabs.io';
const PREVIEW_URL = 'https://aolabs.io/previews/willyernarplayleague-20260724-v4.png';
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

function renderPrediction(state) {
  const action = state.canRecordDidNotPlay ? renderExceptionAction(state.actionLabel) : '';
  return `<section class="prediction" aria-live="polite" aria-atomic="true">
    <p class="prediction-statement" data-statement>${escapeHtml(state.statement)}</p>
    ${action ? `<div class="answer-area" data-answer-area>${action}</div>` : ''}
    <p class="save-status" role="status" data-status></p>
  </section>`;
}

function renderExceptionAction(label = 'no league') {
  return `<div class="answer-buttons">
      <button class="answer-button answer-exception" type="button" data-played="false">${escapeHtml(label)}</button>
    </div>`;
}

function renderHistory(history) {
  return `<section class="history" aria-labelledby="history-heading" data-history-section data-editing="false">
    <div class="history-heading-row">
      <h2 id="history-heading">history</h2>
      <button class="history-edit" type="button" data-history-toggle aria-expanded="false" aria-controls="history-list">edit</button>
    </div>
    <ol id="history-list" data-history>
      ${history.map((entry) => `<li data-history-day="${escapeHtml(entry.dateKey)}">
        <span class="history-entry-text">${escapeHtml(entry.text)}</span>
        <span class="history-entry-action">
          <button class="history-delete" type="button" data-delete-day="${escapeHtml(entry.dateKey)}" data-delete-revision="${entry.revision}" aria-label="delete ${escapeHtml(entry.date)} entry">delete</button>
        </span>
      </li>`).join('')}
    </ol>
    <p class="history-status" role="status" data-history-status></p>
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
    <link rel="icon" href="/icon.svg?v=20260724-yernar-league-v4" type="image/svg+xml">
    <link rel="apple-touch-icon" href="/icon.svg?v=20260724-yernar-league-v4">
    <link rel="manifest" href="/site.webmanifest?v=20260724-yernar-league-v4">
    <meta name="apple-mobile-web-app-title" content="yernar league">
    <meta name="application-name" content="will yernar play league?">
    <link rel="stylesheet" href="/chart.css?v=20260724-ticks-only-v1">
    <link rel="stylesheet" href="/styles.css?v=20260724-ticks-only-v1">
    <script src="/chart.js?v=20260724-ticks-only-v1" defer></script>
    <script src="/app.js?v=20260724-ticks-only-v1" defer></script>
  </head>
  <body>
    <header class="suite-topbar" aria-label="will yernar play league navigation">
      <div class="suite-brand-cluster">
        <a class="suite-ao-home" href="https://aolabs.io/" aria-label="aolabs.io">
          <img src="https://aolabs.io/marks/ao-ink.svg?v=20260516-suite-bloom" alt="">
        </a>
        <a class="suite-app-brand" href="/" aria-label="will yernar play league home">
          <img class="suite-app-mark" src="/icon.svg?v=20260724-yernar-league-v4" alt="">
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
