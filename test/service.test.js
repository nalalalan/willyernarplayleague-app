'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { StateStore } = require('../lib/state-store');
const {
  LeagueService,
  createDefaultState,
  migrateState,
  validateState
} = require('../lib/state');

async function serviceFixture(t, initialInstant = '2026-07-24T16:00:00.000Z') {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yernar-service-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const store = new StateStore({ dataDir });
  await store.initialize({ createDefault: createDefaultState, migrate: migrateState, validate: validateState });
  let instant = new Date(initialInstant);
  const service = new LeagueService({ store, clock: () => new Date(instant) });
  return {
    store,
    service,
    setInstant(value) { instant = new Date(value); }
  };
}

test('seed migration exposes exactly four authoritative No outcomes newest-first', async (t) => {
  const { store, service } = await serviceFixture(t, '2026-07-23T16:00:00.000Z');
  const state = await service.getState();
  assert.equal(state.todayOutcome, false);
  assert.equal(state.todayProbability, null);
  assert.equal(state.tomorrowProbability, 25);
  assert.deepEqual(state.history.map((entry) => entry.text), [
    '7/23/26: yernar did not play league',
    '7/22/26: yernar did not play league',
    '7/13/26: yernar did not play league',
    '7/4/26: yernar did not play league'
  ]);
  const stored = store.getSnapshot();
  assert.equal(Object.keys(stored.outcomes).length, 4);
  assert.equal(Object.hasOwn(stored.forecasts.official, '2026-07-23'), false);
  assert.equal(state.chart.issued.length, 0);
  assert.equal(state.chart.outlook.length, 7);
});

test('first view freezes the 25% official forecast before any outcome write', async (t) => {
  const { store, service } = await serviceFixture(t);
  const state = await service.getState();
  assert.equal(state.statement, 'there is a 25% chance that yernar will play league today');
  assert.equal(state.question, 'did yernar play league?');
  const official = store.getSnapshot().forecasts.official['2026-07-24'];
  assert.equal(official.percent, 25);
  assert.equal(official.kind, 'official');
  assert.ok(Number.isFinite(official.unroundedProbability));
});

test('Yes and No produce exact requested copy and recompute tomorrow', async (t) => {
  const { store, service } = await serviceFixture(t);
  await service.getState();
  const officialBefore = store.getSnapshot().forecasts.official['2026-07-24'];

  const yes = await service.setTodayOutcome(true);
  assert.equal(yes.statement, `yernar plays league today. there is a ${yes.tomorrowProbability}% chance that he will play league tomorrow.`);
  assert.equal(yes.tomorrowProbability, yes.outlook.points[0].percent);

  const no = await service.setTodayOutcome(false);
  assert.equal(no.statement, `yernar does not play league today. there is a ${no.tomorrowProbability}% chance that he will play league tomorrow.`);
  assert.equal(no.tomorrowProbability, no.outlook.points[0].percent);
  assert.notEqual(no.tomorrowProbability, yes.tomorrowProbability);
  assert.deepEqual(store.getSnapshot().forecasts.official['2026-07-24'], officialBefore);
});

test('answer changes upsert one canonical row, identical writes are idempotent, and audit is bounded to changes', async (t) => {
  const { store, service } = await serviceFixture(t);
  await service.getState();
  await service.setTodayOutcome(true);
  await service.setTodayOutcome(false);
  await service.setTodayOutcome(false);
  const stored = store.getSnapshot();
  assert.equal(stored.outcomes['2026-07-24'].played, false);
  assert.equal(Object.keys(stored.outcomes).filter((day) => day === '2026-07-24').length, 1);
  assert.equal(stored.outcomeChanges.filter((event) => event.leagueDay === '2026-07-24').length, 2);
  assert.equal(stored.audit.filter((event) => event.leagueDay === '2026-07-24').length, 2);
  assert.equal(stored.metrics.scores.length, 0);
});

test('official outcome is scored once only after the next 6 AM cutoff', async (t) => {
  const fixture = await serviceFixture(t);
  await fixture.service.getState();
  await fixture.service.setTodayOutcome(true);
  await fixture.service.setTodayOutcome(false);
  assert.equal(fixture.store.getSnapshot().metrics.scores.length, 0);

  fixture.setInstant('2026-07-25T09:59:59.999Z');
  await fixture.service.getState();
  assert.equal(fixture.store.getSnapshot().metrics.scores.length, 0);

  fixture.setInstant('2026-07-25T10:00:00.000Z');
  await fixture.service.getState();
  await fixture.service.getState();
  const scores = fixture.store.getSnapshot().metrics.scores;
  assert.equal(scores.length, 1);
  assert.equal(scores[0].targetDay, '2026-07-24');
  assert.equal(scores[0].played, false);
  assert.ok(Number.isFinite(scores[0].shadowAdaptiveProbability));
});

test('serialized concurrent changes deterministically leave the newest committed answer', async (t) => {
  const { store, service } = await serviceFixture(t);
  await service.getState();
  await Promise.all([
    service.setTodayOutcome(true),
    service.setTodayOutcome(false)
  ]);
  const stored = store.getSnapshot();
  assert.equal(stored.outcomes['2026-07-24'].played, false);
  const changes = stored.outcomeChanges.filter((event) => event.leagueDay === '2026-07-24');
  assert.deepEqual(changes.map((event) => event.played), [true, false]);
  assert.ok(changes[1].sequence > changes[0].sequence);
});

test('outlook snapshot recomputes after an answer changes and contains exact future dates', async (t) => {
  const { store, service } = await serviceFixture(t);
  await service.getState();
  const yes = await service.setTodayOutcome(true);
  const yesSnapshot = store.getSnapshot().forecasts.outlook;
  const no = await service.setTodayOutcome(false);
  const noSnapshot = store.getSnapshot().forecasts.outlook;
  assert.notDeepEqual(no.outlook.points, yes.outlook.points);
  assert.notEqual(noSnapshot.basisRevision, yesSnapshot.basisRevision);
  assert.deepEqual(no.outlook.points.map((point) => point.targetDay), [
    '2026-07-25', '2026-07-26', '2026-07-27', '2026-07-28',
    '2026-07-29', '2026-07-30', '2026-07-31'
  ]);
});

test('no network address or personal context is persisted', async (t) => {
  const { store, service } = await serviceFixture(t);
  await service.setTodayOutcome(true);
  const serialized = JSON.stringify(store.getSnapshot()).toLowerCase();
  assert.equal(serialized.includes('ipaddress'), false);
  assert.equal(serialized.includes('fatigue'), false);
  assert.equal(serialized.includes('clinical'), false);
});
