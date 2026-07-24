'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { StateStore } = require('../lib/state-store');
const {
  LeagueService,
  createDefaultState,
  migrateState,
  validateState
} = require('../lib/state');
const { MemoryWriteThrottle, createRequestHandler } = require('../server');

async function serverFixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yernar-server-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const store = new StateStore({ dataDir, beforeCommit: options.beforeCommit });
  await store.initialize({ createDefault: createDefaultState, migrate: migrateState, validate: validateState });
  const service = options.service || new LeagueService({
    store,
    clock: () => new Date(options.instant || '2026-07-24T16:00:00.000Z')
  });
  const handler = createRequestHandler({
    service,
    store,
    publicDir: path.join(__dirname, '..', 'public'),
    canonicalOrigin: 'https://willyernarplayleague.aolabs.io',
    throttle: options.throttle || new MemoryWriteThrottle()
  });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return { store, service, baseUrl: `http://127.0.0.1:${address.port}` };
}

test('SSR first paint contains real probability, exact controls, accessible plot, history, and metadata', async (t) => {
  const { baseUrl } = await serverFixture(t);
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /there is a 25% chance that yernar will play league today/);
  assert.match(html, /did yernar play league\?/);
  assert.match(html, /data-played="true">yes</);
  assert.match(html, /data-played="false">no</);
  assert.doesNotMatch(html, />--</);
  assert.match(html, /<title id="chart-title">league probability over time<\/title>/);
  assert.match(html, /Seven-day outlook: 7\/25\/26/);
  assert.equal((html.match(/chart-point-outlook/g) || []).length, 14);
  assert.equal((html.match(/class="chart-value"/g) || []).length, 14);
  assert.match(html, /class="chart-line chart-line-outlook"/);
  assert.match(html, /class="chart-point chart-point-issued"/);
  assert.match(html, /class="chart-svg chart-svg-mobile"/);
  assert.match(html, /<h1 class="sr-only">will yernar play league\?<\/h1>/);
  assert.ok(html.indexOf('suite-ao-home') < html.indexOf('suite-app-mark'));
  assert.ok(html.indexOf('suite-app-mark') < html.indexOf('suite-app-name'));
  assert.match(html, /<link rel="canonical" href="https:\/\/willyernarplayleague\.aolabs\.io\/">/);
  assert.match(html, /property="og:image" content="https:\/\/aolabs\.io\/previews\/willyernarplayleague-20260723\.png"/);
  assert.match(html, /7\/23\/26: yernar did not play league/);
});

test('state API separates solid issued forecasts from the dashed provisional outlook', async (t) => {
  const { baseUrl } = await serverFixture(t);
  const response = await fetch(`${baseUrl}/api/state`);
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(state.chart.issued.length, 1);
  assert.equal(state.chart.issued[0].kind, 'official');
  assert.equal(state.chart.outlook.length, 7);
  assert.ok(state.chart.outlook.every((point) => point.kind === 'outlook'));
  assert.equal(state.chart.outlook[0].targetDay, '2026-07-25');
  assert.deepEqual(state.chart.issued.map((point) => point.targetDay), ['2026-07-24']);
});

test('valid same-origin JSON PUT saves and returns complete updated state', async (t) => {
  const { baseUrl } = await serverFixture(t);
  const response = await fetch(`${baseUrl}/api/outcomes/today`, {
    method: 'PUT',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ played: true })
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.has('access-control-allow-origin'), false);
  const state = await response.json();
  assert.equal(state.todayOutcome, true);
  assert.match(state.statement, /^yernar plays league today\. there is a \d+% chance that he will play league tomorrow\.$/);
  assert.equal(state.tomorrowProbability, state.chart.outlook[0].percent);
  assert.equal(state.history[0].text, '7/24/26: yernar played league');
});

test('cross-origin writes, wrong content type, invalid shape, and oversized bodies are rejected', async (t) => {
  const { baseUrl } = await serverFixture(t);
  const missingOrigin = await fetch(`${baseUrl}/api/outcomes/today`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ played: true })
  });
  assert.equal(missingOrigin.status, 403);

  const crossOrigin = await fetch(`${baseUrl}/api/outcomes/today`, {
    method: 'PUT',
    headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' },
    body: JSON.stringify({ played: true })
  });
  assert.equal(crossOrigin.status, 403);

  const wrongType = await fetch(`${baseUrl}/api/outcomes/today`, {
    method: 'PUT',
    headers: { Origin: baseUrl, 'Content-Type': 'text/plain' },
    body: JSON.stringify({ played: true })
  });
  assert.equal(wrongType.status, 415);

  const invalid = await fetch(`${baseUrl}/api/outcomes/today`, {
    method: 'PUT',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ played: true, date: '2026-01-01' })
  });
  assert.equal(invalid.status, 400);

  const oversized = await fetch(`${baseUrl}/api/outcomes/today`, {
    method: 'PUT',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ played: true, padding: 'x'.repeat(2000) })
  });
  assert.equal(oversized.status, 413);
});

test('health checks real storage writes and reports runtime, schema, and model readiness', async (t) => {
  const { baseUrl } = await serverFixture(t);
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.status, 'ok');
  assert.equal(health.storage.writable, true);
  assert.equal(health.storage.recoveredFromBackup, false);
  assert.equal(health.schemaVersion, 1);
  assert.equal(health.modelReady, true);
  assert.match(health.runtime.node, /^v\d+/);
});

test('health fails closed when the live model state is not ready', async (t) => {
  const service = {
    async getState() { return { statement: 'incomplete' }; },
    async setTodayOutcome() { throw new Error('not used'); }
  };
  const { baseUrl } = await serverFixture(t, { service });
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 503);
  const health = await response.json();
  assert.equal(health.status, 'unhealthy');
  assert.equal(health.storage.writable, true);
  assert.equal(health.modelReady, false);
  assert.equal(health.modelError, 'model state failed readiness checks');
});

test('static identity routes work and unknown routes fail closed', async (t) => {
  const { baseUrl } = await serverFixture(t);
  const icon = await fetch(`${baseUrl}/icon.svg`);
  assert.equal(icon.status, 200);
  assert.match(icon.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(await icon.text(), /aria-label="league"/);
  assert.equal((await fetch(`${baseUrl}/site.webmanifest`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/missing`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/missing`)).status, 404);
});

test('in-memory throttle limits floods without persisting client addresses', async (t) => {
  const throttle = new MemoryWriteThrottle({ limit: 1, windowMs: 60_000 });
  const { baseUrl, store } = await serverFixture(t, { throttle });
  const options = {
    method: 'PUT',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.8' },
    body: JSON.stringify({ played: true })
  };
  assert.equal((await fetch(`${baseUrl}/api/outcomes/today`, options)).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/outcomes/today`, options)).status, 429);
  assert.equal(JSON.stringify(store.getSnapshot()).includes('198.51.100.8'), false);
});

test('failed atomic save returns an error and keeps the prior state intact', async (t) => {
  let fail = false;
  const fixture = await serverFixture(t, {
    beforeCommit: async () => {
      if (fail) throw new Error('simulated save failure');
    }
  });
  await fetch(`${fixture.baseUrl}/api/state`);
  const before = fixture.store.getSnapshot();
  fail = true;
  const response = await fetch(`${fixture.baseUrl}/api/outcomes/today`, {
    method: 'PUT',
    headers: { Origin: fixture.baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ played: true })
  });
  assert.equal(response.status, 500);
  assert.deepEqual(fixture.store.getSnapshot(), before);
});
