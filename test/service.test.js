'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { computeForecast } = require('../lib/model');
const { StateStore } = require('../lib/state-store');
const {
  LeagueService,
  OUTLOOK_HORIZON,
  OUTLOOK_METHOD,
  SCHEMA_VERSION,
  SEED_VERSION,
  buildPublicState,
  createDefaultState,
  migrateState,
  snapshotForecast,
  validateState
} = require('../lib/state');
const { addDays } = require('../lib/time');

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

test('first request backfills every closed day as Yes except the four authoritative No dates', async (t) => {
  const { store, service } = await serviceFixture(t);
  const state = await service.getState();
  const stored = store.getSnapshot();
  assert.equal(stored.schemaVersion, SCHEMA_VERSION);
  assert.equal(stored.seedVersion, SEED_VERSION);
  assert.equal(stored.defaultYesPolicy.backfillThrough, '2026-07-23');
  assert.equal(Object.keys(stored.outcomes).length, 20);
  assert.equal(Object.values(stored.outcomes).filter((record) => record.played).length, 16);
  assert.equal(Object.values(stored.outcomes).filter((record) => !record.played).length, 4);
  assert.deepEqual(['2026-07-04', '2026-07-13', '2026-07-22', '2026-07-23'].map((day) => stored.outcomes[day].played), [false, false, false, false]);
  assert.equal(stored.outcomes['2026-07-21'].source, 'historical-default-yes');
  assert.equal(Object.hasOwn(stored.outcomes, '2026-07-24'), false);
  assert.equal(state.todayOutcome, null);
  assert.equal(state.todayProbability, 85);
  assert.equal(state.statement, 'there is a 85% chance that yernar will play league today');
  assert.equal(state.canRecordOutcome, true);
  assert.equal(state.canRecordDidNotPlay, true);
  assert.equal(state.actionLabel, 'no league');
  assert.equal(state.yesActionLabel, 'yes league');
  assert.equal(state.chart.activeDay, '2026-07-24');
  assert.equal(state.chart.windowStart, '2026-06-24');
  assert.equal(state.chart.windowEnd, '2026-08-23');
  assert.equal(state.chart.past.length, 20);
  assert.deepEqual(
    state.chart.past.filter((point) => !point.played).map((point) => point.targetDay),
    ['2026-07-04', '2026-07-13', '2026-07-22', '2026-07-23']
  );
  assert.equal(state.chart.past.filter((point) => point.played).length, 16);
  assert.ok(state.chart.past.every((point) => point.probability === (point.played ? 1 : 0)));
  assert.equal(state.chart.outlook.length, OUTLOOK_HORIZON);
  assert.equal(state.chart.outlook[0].targetDay, '2026-07-25');
  assert.equal(state.chart.outlook.at(-1).targetDay, '2026-08-23');
  assert.equal(state.history.length, 20);
  assert.equal(state.history[0].text, '7/23/26: yernar did not play league');
  assert.equal(state.history.find((entry) => entry.dateKey === '2026-07-21').text, '7/21/26: yernar played league');
});

test('official forecast is created after closed-day backfill and remains frozen', async (t) => {
  const { store, service } = await serviceFixture(t);
  await service.getState();
  const official = structuredClone(store.getSnapshot().forecasts.official['2026-07-24']);
  assert.equal(official.percent, 85);
  assert.ok(Number.isFinite(official.unroundedProbability));
  await service.recordTodayNo('2026-07-24');
  assert.deepEqual(store.getSnapshot().forecasts.official['2026-07-24'], official);
});

test('public service accepts explicit Yes and No, stays idempotent, and keeps the latest answer', async (t) => {
  const { store, service } = await serviceFixture(t);
  await service.getState();
  const before = store.getSnapshot();
  assert.equal(typeof service.setTodayOutcome, 'undefined');
  assert.deepEqual(store.getSnapshot(), before);

  const yes = await service.recordTodayOutcome(true, '2026-07-24');
  const sameYes = await service.recordTodayOutcome(true, '2026-07-24');
  assert.equal(yes.todayOutcome, true);
  assert.equal(yes.canRecordOutcome, true);
  assert.equal(yes.yesActionLabel, 'yes league');
  assert.equal(yes.statement, `yernar plays league today. there is a ${yes.tomorrowProbability}% chance that he will play league tomorrow.`);
  assert.deepEqual(sameYes, yes);
  assert.deepEqual(yes.chart.past.at(-1), {
    targetDay: '2026-07-24',
    probability: 1,
    percent: 100,
    played: true,
    kind: 'outcome'
  });

  const no = await service.recordTodayOutcome(false, '2026-07-24');
  const sameNo = await service.recordTodayNo('2026-07-24');
  assert.equal(no.todayOutcome, false);
  assert.equal(no.statement, `yernar does not play league today. there is a ${no.tomorrowProbability}% chance that he will play league tomorrow.`);
  assert.equal(no.tomorrowProbability, no.outlook.points[0].percent);
  assert.equal(no.chart.past.length, 21);
  assert.deepEqual(no.chart.past.at(-1), {
    targetDay: '2026-07-24',
    probability: 0,
    percent: 0,
    played: false,
    kind: 'outcome'
  });
  assert.deepEqual(sameNo, no);
  const stored = store.getSnapshot();
  assert.equal(stored.outcomes['2026-07-24'].source, 'explicit-no');
  assert.equal(stored.outcomeChanges.filter((event) => event.leagueDay === '2026-07-24').length, 2);
  assert.equal(stored.audit.filter((event) => event.leagueDay === '2026-07-24').length, 2);
});

test('an unanswered day stays unresolved through 5:59 AM and finalizes Yes at 6:00 AM', async (t) => {
  const fixture = await serviceFixture(t);
  await fixture.service.getState();
  fixture.setInstant('2026-07-25T09:59:59.999Z');
  const beforeCutoff = await fixture.service.getState();
  assert.equal(beforeCutoff.activeLeagueDay, '2026-07-24');
  assert.equal(beforeCutoff.todayOutcome, null);
  assert.equal(Object.hasOwn(fixture.store.getSnapshot().outcomes, '2026-07-24'), false);
  assert.equal(fixture.store.getSnapshot().metrics.scores.length, 0);

  fixture.setInstant('2026-07-25T10:00:00.000Z');
  const afterCutoff = await fixture.service.getState();
  const stored = fixture.store.getSnapshot();
  assert.equal(afterCutoff.activeLeagueDay, '2026-07-25');
  assert.equal(afterCutoff.todayOutcome, null);
  assert.equal(stored.outcomes['2026-07-24'].played, true);
  assert.equal(stored.outcomes['2026-07-24'].source, 'automatic-default-yes');
  assert.equal(stored.metrics.scores.length, 1);
  assert.equal(stored.metrics.scores[0].targetDay, '2026-07-24');
  assert.equal(stored.metrics.scores[0].played, true);
  await fixture.service.getState();
  assert.equal(fixture.store.getSnapshot().metrics.scores.length, 1);
});

test('an explicit No is the final scored outcome after cutoff', async (t) => {
  const fixture = await serviceFixture(t);
  await fixture.service.getState();
  await fixture.service.recordTodayNo('2026-07-24');
  fixture.setInstant('2026-07-25T10:00:00.000Z');
  await fixture.service.getState();
  const stored = fixture.store.getSnapshot();
  assert.equal(stored.outcomes['2026-07-24'].source, 'explicit-no');
  assert.equal(stored.metrics.scores.length, 1);
  assert.equal(stored.metrics.scores[0].played, false);
});

test('historical default-Yes backfills are excluded from forecast-quality scoring', async (t) => {
  const fixture = await serviceFixture(t);
  await fixture.store.update((state) => {
    const forecast = computeForecast(state, '2026-07-10');
    state.forecasts.official['2026-07-10'] = snapshotForecast(forecast, '2026-07-10T10:00:00.000Z', 'official');
    return { changed: true };
  });
  await fixture.service.getState();
  const stored = fixture.store.getSnapshot();
  assert.equal(stored.outcomes['2026-07-10'].source, 'historical-default-yes');
  assert.equal(stored.metrics.scores.some((score) => score.targetDay === '2026-07-10'), false);
});

test('closed holes below the backfill marker are repaired without becoming scored evidence', async (t) => {
  const fixture = await serviceFixture(t);
  await fixture.service.getState();
  await fixture.store.update((state) => {
    delete state.outcomes['2026-07-10'];
    return { changed: true };
  });
  await fixture.service.getState();
  const restored = fixture.store.getSnapshot().outcomes['2026-07-10'];
  assert.equal(restored.played, true);
  assert.equal(restored.source, 'historical-default-yes');
});

test('concurrent duplicate No submissions produce one canonical change', async (t) => {
  const { store, service } = await serviceFixture(t);
  await service.getState();
  await Promise.all([service.recordTodayNo('2026-07-24'), service.recordTodayNo('2026-07-24')]);
  const stored = store.getSnapshot();
  assert.equal(stored.outcomes['2026-07-24'].played, false);
  assert.equal(stored.outcomeChanges.filter((event) => event.leagueDay === '2026-07-24').length, 1);
  assert.equal(stored.audit.filter((event) => event.leagueDay === '2026-07-24').length, 1);
});

test('concurrent first reads materialize backfill and official forecast only once', async (t) => {
  const { store, service } = await serviceFixture(t);
  const states = await Promise.all([service.getState(), service.getState(), service.getState()]);
  assert.ok(states.every((state) => state.todayProbability === 85 && state.history.length === 20));
  const stored = store.getSnapshot();
  assert.equal(Object.keys(stored.forecasts.official).filter((day) => day === '2026-07-24').length, 1);
  assert.equal(stored.outcomeChanges.filter((event) => event.source === 'historical-default-yes').length, 16);
  assert.deepEqual(states[0].chart.issued.map((point) => point.targetDay), ['2026-07-24']);
  assert.equal(states[0].chart.past.length, 20);
});

test('chart exposes a fixed 60-day domain and every recorded outcome within it', () => {
  const state = createDefaultState();
  const activeDay = '2026-08-10';
  const template = computeForecast(state, addDays(activeDay, -34));
  for (let offset = -34; offset <= 0; offset += 1) {
    const targetDay = addDays(activeDay, offset);
    state.outcomes[targetDay] = { played: offset % 5 !== 0, source: 'test' };
    state.forecasts.official[targetDay] = snapshotForecast(
      { ...template, targetDay },
      `${targetDay}T10:00:00.000Z`,
      'official'
    );
  }

  const publicState = buildPublicState(state, activeDay);
  assert.equal(Object.keys(state.forecasts.official).length, 35);
  assert.equal(publicState.chart.activeDay, activeDay);
  assert.equal(publicState.chart.windowStart, addDays(activeDay, -30));
  assert.equal(publicState.chart.windowEnd, addDays(activeDay, 30));
  assert.equal(publicState.chart.past.length, 31);
  assert.equal(publicState.chart.past[0].targetDay, addDays(activeDay, -30));
  assert.equal(publicState.chart.past.at(-1).targetDay, activeDay);
  assert.ok(publicState.chart.past.every((point) => point.percent === (point.played ? 100 : 0)));
  assert.equal(publicState.chart.issued.length, 31);
  assert.equal(publicState.chart.issued[0].targetDay, addDays(activeDay, -30));
  assert.equal(publicState.chart.issued.at(-1).targetDay, activeDay);
});

test('stale short or older-method outlook caches are replaced without changing official forecasts', async (t) => {
  const { store, service } = await serviceFixture(t);
  await service.getState();
  const frozenOfficial = structuredClone(store.getSnapshot().forecasts.official);
  await store.update((state) => {
    state.forecasts.outlook.horizon = 7;
    state.forecasts.outlook.method = 'recursive-branch-marginalization';
    state.forecasts.outlook.points = state.forecasts.outlook.points.slice(0, 7);
    return { changed: true };
  });

  const refreshed = await service.getState();
  assert.equal(refreshed.outlook.method, OUTLOOK_METHOD);
  assert.equal(refreshed.outlook.points.length, OUTLOOK_HORIZON);
  assert.deepEqual(store.getSnapshot().forecasts.official, frozenOfficial);
});

test('an active Yes remains valid and can still be changed before cutoff', async (t) => {
  const { store, service } = await serviceFixture(t);
  let frozenOfficial;
  await store.update((state) => {
    const forecast = computeForecast(state, '2026-07-24');
    frozenOfficial = snapshotForecast(forecast, '2026-07-24T10:00:00.000Z', 'official');
    state.forecasts.official['2026-07-24'] = structuredClone(frozenOfficial);
    state.outcomes['2026-07-24'] = {
      played: true,
      source: 'answer',
      recordedAt: '2026-07-24T10:01:00.000Z',
      revision: 1
    };
    return { changed: true };
  });
  const state = await service.getState();
  assert.equal(state.todayOutcome, true);
  assert.equal(state.canRecordOutcome, true);
  assert.equal(state.canRecordDidNotPlay, true);
  assert.deepEqual(store.getSnapshot().forecasts.official['2026-07-24'], frozenOfficial);
  assert.equal(typeof service.setTodayOutcome, 'undefined');
  const changed = await service.recordTodayOutcome(false, '2026-07-24');
  assert.equal(changed.todayOutcome, false);
  assert.equal(store.getSnapshot().outcomes['2026-07-24'].source, 'explicit-no');
});

for (const boundary of [
  {
    label: 'DST end',
    before: '2026-11-01T10:59:59.999Z',
    after: '2026-11-01T11:00:00.000Z',
    oldDay: '2026-10-31',
    newDay: '2026-11-01'
  },
  {
    label: 'DST start',
    before: '2027-03-14T09:59:59.999Z',
    after: '2027-03-14T10:00:00.000Z',
    oldDay: '2027-03-13',
    newDay: '2027-03-14'
  }
]) {
  test(`${boundary.label} stale-day precondition prevents a No from crossing the 6 AM boundary`, async (t) => {
    const fixture = await serviceFixture(t, boundary.before);
    const before = await fixture.service.getState();
    assert.equal(before.activeLeagueDay, boundary.oldDay);
    fixture.setInstant(boundary.after);
    await assert.rejects(
      fixture.service.recordTodayNo(boundary.oldDay),
      (error) => {
        assert.equal(error.statusCode, 409);
        assert.equal(error.state.activeLeagueDay, boundary.newDay);
        return true;
      }
    );
    const stored = fixture.store.getSnapshot();
    assert.equal(stored.outcomes[boundary.oldDay].played, true);
    assert.equal(Object.hasOwn(stored.outcomes, boundary.newDay), false);
  });
}

test('recording No recomputes the provisional outlook but not its exact dates', async (t) => {
  const { store, service } = await serviceFixture(t);
  const before = await service.getState();
  const basisBefore = store.getSnapshot().forecasts.outlook.basisRevision;
  const after = await service.recordTodayNo('2026-07-24');
  const basisAfter = store.getSnapshot().forecasts.outlook.basisRevision;
  assert.notDeepEqual(after.outlook.points, before.outlook.points);
  assert.ok(basisAfter > basisBefore);
  assert.deepEqual(
    after.outlook.points.map((point) => point.targetDay),
    Array.from({ length: OUTLOOK_HORIZON }, (_, index) => addDays('2026-07-24', index + 1))
  );
});

test('deleting a closed outcome persists as missing, removes its score, and preserves official forecasts', async (t) => {
  const fixture = await serviceFixture(t);
  await fixture.service.getState();
  const recorded = await fixture.service.recordTodayNo('2026-07-24');
  const revision = recorded.history.find((entry) => entry.dateKey === '2026-07-24').revision;
  fixture.setInstant('2026-07-25T16:00:00.000Z');
  const beforeDelete = await fixture.service.getState();
  const officialBeforeDelete = structuredClone(fixture.store.getSnapshot().forecasts.official);
  assert.equal(fixture.store.getSnapshot().metrics.scores.some((score) => score.targetDay === '2026-07-24'), true);
  const changeCountBefore = fixture.store.getSnapshot().outcomeChanges.length;

  const deleted = await fixture.service.deleteOutcome('2026-07-24', revision, '2026-07-25');
  const stored = fixture.store.getSnapshot();
  assert.equal(deleted.history.some((entry) => entry.dateKey === '2026-07-24'), false);
  assert.equal(deleted.chart.past.some((point) => point.targetDay === '2026-07-24'), false);
  assert.equal(Object.hasOwn(stored.outcomes, '2026-07-24'), false);
  assert.equal(stored.deletedOutcomes['2026-07-24'].previousPlayed, false);
  assert.equal(stored.metrics.scores.some((score) => score.targetDay === '2026-07-24'), false);
  assert.deepEqual(stored.forecasts.official, officialBeforeDelete);
  assert.notDeepEqual(deleted.outlook.points, beforeDelete.outlook.points);
  assert.equal(stored.outcomeChanges.at(-1).played, null);
  assert.equal(stored.outcomeChanges.at(-1).source, 'explicit-delete');
  assert.equal(stored.audit.at(-1).action, 'delete');

  const repeated = await fixture.service.deleteOutcome('2026-07-24', revision, '2026-07-25');
  assert.equal(repeated.history.some((entry) => entry.dateKey === '2026-07-24'), false);
  assert.equal(fixture.store.getSnapshot().outcomeChanges.length, changeCountBefore + 1);
  await fixture.service.getState();
  assert.equal(Object.hasOwn(fixture.store.getSnapshot().outcomes, '2026-07-24'), false);
});

test('deleting and re-recording the active No advances revision and rejects an old delete request', async (t) => {
  const { store, service } = await serviceFixture(t);
  const before = await service.getState();
  const officialBefore = structuredClone(store.getSnapshot().forecasts.official['2026-07-24']);
  const first = await service.recordTodayNo(before.activeLeagueDay);
  const firstRevision = first.history[0].revision;

  const deleted = await service.deleteOutcome('2026-07-24', firstRevision, '2026-07-24');
  assert.equal(deleted.todayOutcome, null);
  assert.equal(deleted.canRecordOutcome, true);
  assert.equal(deleted.canRecordDidNotPlay, true);
  assert.deepEqual(store.getSnapshot().forecasts.official['2026-07-24'], officialBefore);

  const restored = await service.recordTodayNo('2026-07-24');
  const restoredEntry = restored.history.find((entry) => entry.dateKey === '2026-07-24');
  assert.equal(restoredEntry.revision, firstRevision + 1);
  await assert.rejects(
    service.deleteOutcome('2026-07-24', firstRevision, '2026-07-24'),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.state.history[0].revision, restoredEntry.revision);
      return true;
    }
  );
  assert.equal(store.getSnapshot().outcomes['2026-07-24'].revision, restoredEntry.revision);
});

test('no network address or personal context is persisted', async (t) => {
  const { store, service } = await serviceFixture(t);
  await service.recordTodayNo('2026-07-24');
  const serialized = JSON.stringify(store.getSnapshot()).toLowerCase();
  assert.equal(serialized.includes('ipaddress'), false);
  assert.equal(serialized.includes('fatigue'), false);
  assert.equal(serialized.includes('clinical'), false);
});
