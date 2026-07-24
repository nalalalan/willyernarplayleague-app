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
    clock: options.clock || (() => new Date(options.instant || '2026-07-24T16:00:00.000Z'))
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
  assert.match(html, /there is a 85% chance that yernar will play league today/);
  assert.match(html, /data-played="false">no league</);
  assert.doesNotMatch(html, /data-played="true"/);
  assert.doesNotMatch(html, /change answer/);
  assert.doesNotMatch(html, />--</);
  assert.match(html, /<title id="chart-title">yernar league probability, past and future<\/title>/);
  assert.match(html, /Past results: 7\/4\/26 did not play, 7\/5\/26 played/);
  assert.match(html, /Future: 7\/25\/26/);
  assert.equal((html.match(/chart-point-past/g) || []).length, 8);
  assert.equal((html.match(/chart-point-future/g) || []).length, 10);
  assert.equal((html.match(/class="chart-date/g) || []).length, 12);
  assert.doesNotMatch(html, /class="chart-value"|>probability over time</);
  assert.match(html, /class="chart-line chart-line-future"/);
  assert.match(html, /class="chart-line chart-line-past chart-step"/);
  assert.match(html, /class="chart-point chart-point-past"/);
  assert.match(html, /class="chart-svg chart-svg-mobile"/);
  assert.equal((html.match(/>probability<\/text>/g) || []).length, 2);
  assert.ok(html.indexOf('>past<\/span>') < html.indexOf('>future<\/span>'));
  assert.match(html, /<h1 class="sr-only">will yernar play league\?<\/h1>/);
  assert.ok(html.indexOf('suite-ao-home') < html.indexOf('suite-app-mark'));
  assert.ok(html.indexOf('suite-app-mark') < html.indexOf('suite-app-name'));
  assert.match(html, /<link rel="canonical" href="https:\/\/willyernarplayleague\.aolabs\.io\/">/);
  assert.match(html, /property="og:image" content="https:\/\/aolabs\.io\/previews\/willyernarplayleague-20260723\.png"/);
  assert.match(html, /href="\/chart\.css\?v=20260724-no-league-v1"/);
  assert.match(html, /href="\/styles\.css\?v=20260724-no-league-v1"/);
  assert.match(html, /src="\/chart\.js\?v=20260724-no-league-v1"/);
  assert.match(html, /src="\/app\.js\?v=20260724-no-league-v1"/);
  assert.ok(html.indexOf('src="/chart.js') < html.indexOf('src="/app.js'));
  assert.match(html, /7\/23\/26: yernar did not play league/);
  assert.match(html, /data-history-toggle[^>]*>edit<\/button>/);
  assert.match(html, /data-delete-day="2026-07-23" data-delete-revision="1"/);
  assert.match(html, /aria-label="delete 7\/23\/26 entry"/);
});

test('state API separates solid recorded outcomes from the dashed provisional outlook', async (t) => {
  const { baseUrl } = await serverFixture(t);
  const response = await fetch(`${baseUrl}/api/state`);
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(state.chart.issued.length, 1);
  assert.equal(state.chart.issued[0].kind, 'official');
  assert.equal(state.chart.past.length, 20);
  assert.ok(state.chart.past.every((point) => point.kind === 'outcome'));
  assert.equal(state.chart.past[0].targetDay, '2026-07-04');
  assert.equal(state.chart.past.at(-1).targetDay, '2026-07-23');
  assert.deepEqual(
    state.chart.past.filter((point) => !point.played).map((point) => point.targetDay),
    ['2026-07-04', '2026-07-13', '2026-07-22', '2026-07-23']
  );
  assert.equal(state.chart.outlook.length, 30);
  assert.ok(state.chart.outlook.every((point) => point.kind === 'outlook'));
  assert.equal(state.chart.outlook[0].targetDay, '2026-07-25');
  assert.equal(state.chart.outlook.at(-1).targetDay, '2026-08-23');
  assert.equal(state.chart.activeDay, '2026-07-24');
  assert.equal(state.chart.windowStart, '2026-06-24');
  assert.equal(state.chart.windowEnd, '2026-08-23');
  assert.deepEqual(state.chart.issued.map((point) => point.targetDay), ['2026-07-24']);
});

test('valid same-origin JSON PUT saves and returns complete updated state', async (t) => {
  const { baseUrl } = await serverFixture(t);
  const response = await fetch(`${baseUrl}/api/outcomes/today`, {
    method: 'PUT',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ played: false, expectedLeagueDay: '2026-07-24' })
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.has('access-control-allow-origin'), false);
  const state = await response.json();
  assert.equal(state.todayOutcome, false);
  assert.match(state.statement, /^yernar does not play league today\. there is a \d+% chance that he will play league tomorrow\.$/);
  assert.equal(state.tomorrowProbability, state.chart.outlook[0].percent);
  assert.equal(state.history[0].text, '7/24/26: yernar did not play league');
});

test('same-origin DELETE removes one history entry and is idempotent', async (t) => {
  const { baseUrl, store } = await serverFixture(t);
  const before = await (await fetch(`${baseUrl}/api/state`)).json();
  const entry = before.history.find((item) => item.dateKey === '2026-07-13');
  const options = {
    method: 'DELETE',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      expectedRevision: entry.revision,
      expectedLeagueDay: before.activeLeagueDay
    })
  };

  const response = await fetch(`${baseUrl}/api/outcomes/2026-07-13`, options);
  assert.equal(response.status, 200);
  assert.equal(response.headers.has('access-control-allow-origin'), false);
  const state = await response.json();
  assert.equal(state.history.some((item) => item.dateKey === '2026-07-13'), false);
  assert.equal(state.chart.past.some((point) => point.targetDay === '2026-07-13'), false);
  assert.equal(store.getSnapshot().deletedOutcomes['2026-07-13'].revision, entry.revision);

  const changeCount = store.getSnapshot().outcomeChanges.length;
  const repeated = await fetch(`${baseUrl}/api/outcomes/2026-07-13`, options);
  assert.equal(repeated.status, 200);
  assert.equal(store.getSnapshot().outcomeChanges.length, changeCount);
});

test('DELETE rejects cross-origin, malformed, future, and stale requests', async (t) => {
  const { baseUrl } = await serverFixture(t);
  const state = await (await fetch(`${baseUrl}/api/state`)).json();
  const body = JSON.stringify({ expectedRevision: 1, expectedLeagueDay: state.activeLeagueDay });

  const missingOrigin = await fetch(`${baseUrl}/api/outcomes/2026-07-13`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body
  });
  assert.equal(missingOrigin.status, 403);

  const crossOrigin = await fetch(`${baseUrl}/api/outcomes/2026-07-13`, {
    method: 'DELETE',
    headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' },
    body
  });
  assert.equal(crossOrigin.status, 403);

  const malformed = await fetch(`${baseUrl}/api/outcomes/2026-07-13`, {
    method: 'DELETE',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, expectedLeagueDay: state.activeLeagueDay })
  });
  assert.equal(malformed.status, 400);

  const future = await fetch(`${baseUrl}/api/outcomes/2026-08-01`, {
    method: 'DELETE',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body
  });
  assert.equal(future.status, 400);

  const stale = await fetch(`${baseUrl}/api/outcomes/2026-07-13`, {
    method: 'DELETE',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 99, expectedLeagueDay: state.activeLeagueDay })
  });
  assert.equal(stale.status, 409);
  const stalePayload = await stale.json();
  assert.equal(stalePayload.state.history.some((item) => item.dateKey === '2026-07-13'), true);
});

test('stale pre-cutoff tab receives fresh state without recording No on the new day', async (t) => {
  let instant = new Date('2026-07-25T09:59:59.999Z');
  const { baseUrl, store } = await serverFixture(t, { clock: () => new Date(instant) });
  const before = await (await fetch(`${baseUrl}/api/state`)).json();
  assert.equal(before.activeLeagueDay, '2026-07-24');
  instant = new Date('2026-07-25T10:00:00.000Z');
  const response = await fetch(`${baseUrl}/api/outcomes/today`, {
    method: 'PUT',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ played: false, expectedLeagueDay: '2026-07-24' })
  });
  assert.equal(response.status, 409);
  const payload = await response.json();
  assert.equal(payload.state.activeLeagueDay, '2026-07-25');
  assert.equal(payload.state.todayOutcome, null);
  const stored = store.getSnapshot();
  assert.equal(stored.outcomes['2026-07-24'].played, true);
  assert.equal(Object.hasOwn(stored.outcomes, '2026-07-25'), false);
});

test('cross-origin writes, wrong content type, invalid shape, and oversized bodies are rejected', async (t) => {
  const { baseUrl } = await serverFixture(t);
  const missingOrigin = await fetch(`${baseUrl}/api/outcomes/today`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ played: false, expectedLeagueDay: '2026-07-24' })
  });
  assert.equal(missingOrigin.status, 403);

  const crossOrigin = await fetch(`${baseUrl}/api/outcomes/today`, {
    method: 'PUT',
    headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' },
    body: JSON.stringify({ played: false, expectedLeagueDay: '2026-07-24' })
  });
  assert.equal(crossOrigin.status, 403);

  const wrongType = await fetch(`${baseUrl}/api/outcomes/today`, {
    method: 'PUT',
    headers: { Origin: baseUrl, 'Content-Type': 'text/plain' },
    body: JSON.stringify({ played: false, expectedLeagueDay: '2026-07-24' })
  });
  assert.equal(wrongType.status, 415);

  const cachedYesClient = await fetch(`${baseUrl}/api/outcomes/today`, {
    method: 'PUT',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ played: true, expectedLeagueDay: '2026-07-24' })
  });
  assert.equal(cachedYesClient.status, 400);

  const missingPrecondition = await fetch(`${baseUrl}/api/outcomes/today`, {
    method: 'PUT',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ played: false })
  });
  assert.equal(missingPrecondition.status, 400);

  const invalid = await fetch(`${baseUrl}/api/outcomes/today`, {
    method: 'PUT',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ played: false, expectedLeagueDay: '2026-07-24', date: '2026-01-01' })
  });
  assert.equal(invalid.status, 400);

  const oversized = await fetch(`${baseUrl}/api/outcomes/today`, {
    method: 'PUT',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ played: false, expectedLeagueDay: '2026-07-24', padding: 'x'.repeat(2000) })
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
  assert.equal(health.schemaVersion, 3);
  assert.equal(health.modelReady, true);
  assert.match(health.runtime.node, /^v\d+/);
});

test('health fails closed when the live model state is not ready', async (t) => {
  const service = {
    async getState() { return { statement: 'incomplete' }; },
    async recordTodayNo() { throw new Error('not used'); }
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
  const chartScript = await fetch(`${baseUrl}/chart.js`);
  assert.equal(chartScript.status, 200);
  assert.match(chartScript.headers.get('content-type'), /text\/javascript/);
  assert.match(await chartScript.text(), /YernarLeagueChart/);
  const chartStyles = await fetch(`${baseUrl}/chart.css`);
  assert.equal(chartStyles.status, 200);
  assert.match(chartStyles.headers.get('content-type'), /text\/css/);
  assert.match(await chartStyles.text(), /--chart-line-width: 3\.25px/);
  assert.equal((await fetch(`${baseUrl}/missing`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/missing`)).status, 404);
});

test('in-memory throttle limits floods without persisting client addresses', async (t) => {
  const throttle = new MemoryWriteThrottle({ limit: 1, windowMs: 60_000 });
  const { baseUrl, store } = await serverFixture(t, { throttle });
  const options = {
    method: 'PUT',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.8' },
    body: JSON.stringify({ played: false, expectedLeagueDay: '2026-07-24' })
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
    body: JSON.stringify({ played: false, expectedLeagueDay: '2026-07-24' })
  });
  assert.equal(response.status, 500);
  assert.deepEqual(fixture.store.getSnapshot(), before);
});
