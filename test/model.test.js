'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const {
  OUTLOOK_HORIZON,
  OUTLOOK_METHOD,
  OUTLOOK_PARTICLE_CAP,
  adaptiveSelection,
  buildRecursiveOutlook,
  calculateCandidates,
  computeForecast,
  deriveAdaptiveWeights,
  detectCrashCycle,
  evaluateCalibration,
  systematicResample
} = require('../lib/model');
const { createDefaultState } = require('../lib/state');
const { addDays } = require('../lib/time');

function scoreRow(index, overrides = {}) {
  const played = overrides.played ?? false;
  const baseline = overrides.baseline ?? 0.5;
  const candidate = overrides.candidate ?? 0.2;
  const candidates = {
    baseline,
    calendar: candidate,
    recency7: candidate,
    recency14: candidate,
    recency28: candidate,
    transition: candidate,
    streak: candidate,
    sinceLastYes: candidate,
    dayOfWeek: candidate,
    weeklyCadence: candidate,
    monthlyCadence: candidate,
    crashCycle: candidate,
    recentLoad: candidate,
    reboundCooldown: candidate,
    gapHazard: candidate
  };
  return {
    targetDay: addDays('2025-01-01', index),
    played,
    probability: baseline,
    rawProbability: baseline,
    candidates: overrides.candidates || candidates,
    shadowAdaptiveProbability: overrides.shadow ?? candidate
  };
}

test('the isolated four-No prior remains 25% before closed-day policy materialization', () => {
  const forecast = computeForecast(createDefaultState(), '2026-07-24');
  assert.equal(forecast.percent, 25);
  assert.equal(forecast.probability, 0.25);
  assert.equal(forecast.stage, 'bayesian-baseline');
  assert.equal(forecast.cycle.active, false);
});

test('a repeated nine-day crash cycle creates bounded recurring troughs', () => {
  const state = createDefaultState();
  const noDays = new Set(['2026-07-04', '2026-07-13', '2026-07-22', '2026-07-23']);
  for (let dateKey = '2026-07-04'; dateKey <= '2026-07-23'; dateKey = addDays(dateKey, 1)) {
    state.outcomes[dateKey] = {
      played: !noDays.has(dateKey),
      source: 'observed'
    };
  }

  const cycle = detectCrashCycle(Object.entries(state.outcomes)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([dateKey, record]) => ({ dateKey, played: record.played, source: record.source })));
  assert.equal(cycle.active, true);
  assert.equal(cycle.period, 9);
  assert.deepEqual(cycle.clusterStarts, ['2026-07-04', '2026-07-13', '2026-07-22']);

  const outlook = buildRecursiveOutlook(state, '2026-07-23');
  const byDay = new Map(outlook.points.map((point) => [point.targetDay, point.percent]));
  for (const troughDay of ['2026-07-31', '2026-08-09', '2026-08-18']) {
    assert.ok(byDay.get(troughDay) <= 50, `${troughDay} should be a visible trough`);
  }
  for (const normalDay of ['2026-07-30', '2026-08-02', '2026-08-11', '2026-08-20']) {
    assert.ok(byDay.get(normalDay) >= 70, `${normalDay} should remain a likely play day`);
  }
  assert.ok(outlook.points.every((point) => point.percent >= 5 && point.percent <= 95));
  assert.equal(computeForecast(state, '2026-07-31').stage, 'cycle-aware-bayesian-baseline');

  const leaked = structuredClone(state);
  leaked.outcomes['2026-07-31'] = { played: true, source: 'test-target' };
  assert.equal(
    computeForecast(leaked, '2026-07-31').percent,
    computeForecast(state, '2026-07-31').percent
  );
});

test('target and future outcomes cannot leak into their own forecast', () => {
  const state = createDefaultState();
  const before = computeForecast(state, '2026-07-24');
  state.outcomes['2026-07-24'] = { played: true, source: 'test' };
  state.outcomes['2026-07-30'] = { played: true, source: 'test' };
  const after = computeForecast(state, '2026-07-24');
  assert.deepEqual(after.candidates, before.candidates);
  assert.equal(after.percent, before.percent);
});

test('missing days are excluded from counts and break transition and streak context', () => {
  const state = createDefaultState();
  const base = calculateCandidates(state, '2026-07-26');
  state.outcomes['2026-07-24'] = { played: false, source: 'test' };
  const withAnsweredDay = calculateCandidates(state, '2026-07-26');
  assert.notEqual(withAnsweredDay.baseline, base.baseline);
  assert.equal(withAnsweredDay.transition, withAnsweredDay.baseline);
  assert.equal(withAnsweredDay.streak, withAnsweredDay.baseline);
  assert.equal(Object.keys(state.outcomes).includes('2026-07-25'), false);
});

test('model stages switch at exactly 14 and 28 scored forecasts', () => {
  const state = createDefaultState();
  state.metrics.scores = Array.from({ length: 13 }, (_, index) => scoreRow(index));
  assert.equal(computeForecast(state, '2026-08-01').stage, 'bayesian-baseline');
  state.metrics.scores.push(scoreRow(13));
  assert.equal(computeForecast(state, '2026-08-01').stage, 'fixed-blend');
  state.metrics.scores = Array.from({ length: 28 }, (_, index) => scoreRow(index));
  assert.match(computeForecast(state, '2026-08-01').stage, /^adaptive-/);
});

test('calibration is not attempted before 50 forecasts and is tested at 50', () => {
  const rows49 = Array.from({ length: 49 }, (_, index) => scoreRow(index));
  assert.equal(evaluateCalibration(rows49).attempted, false);
  const rows50 = [...rows49, scoreRow(49)];
  assert.equal(evaluateCalibration(rows50).attempted, true);
});

test('adaptive weights sum to one and every included candidate receives at least 5%', () => {
  const rows = Array.from({ length: 40 }, (_, index) => scoreRow(index));
  const { weights } = deriveAdaptiveWeights(rows);
  const values = Object.values(weights);
  assert.ok(values.length >= 8);
  assert.ok(values.every((value) => value >= 0.05 - 1e-12));
  assert.ok(Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) < 1e-12);
});

test('cadence candidates are excluded unless both Brier and log loss beat baseline', () => {
  const rows = Array.from({ length: 40 }, (_, index) => {
    const row = scoreRow(index);
    row.candidates.dayOfWeek = 0.7;
    return row;
  });
  const selection = deriveAdaptiveWeights(rows);
  assert.equal(selection.eligibleNames.includes('dayOfWeek'), false);
  assert.equal(Object.hasOwn(selection.weights, 'dayOfWeek'), false);
});

test('adaptive gate independently enforces absolute and relative Brier gains', () => {
  const candidates = calculateCandidates(createDefaultState(), '2026-08-01');
  const absoluteFailure = Array.from({ length: 40 }, (_, index) => scoreRow(index, {
    baseline: 0.2,
    candidate: 0.176,
    shadow: 0.176
  }));
  assert.equal(adaptiveSelection(absoluteFailure, candidates).model, 'baseline');

  const relativeFailure = Array.from({ length: 40 }, (_, index) => scoreRow(index, {
    baseline: 0.5,
    candidate: 0.489,
    shadow: 0.489
  }));
  assert.equal(adaptiveSelection(relativeFailure, candidates).model, 'baseline');

  const passing = Array.from({ length: 40 }, (_, index) => scoreRow(index, {
    baseline: 0.5,
    candidate: 0.2,
    shadow: 0.2
  }));
  assert.equal(adaptiveSelection(passing, candidates).model, 'adaptive');
});

test('newest-28 underperformance forces the Bayesian fallback', () => {
  const candidates = calculateCandidates(createDefaultState(), '2026-08-01');
  const early = Array.from({ length: 28 }, (_, index) => scoreRow(index, { baseline: 0.5, candidate: 0.05, shadow: 0.05 }));
  const recent = Array.from({ length: 28 }, (_, index) => scoreRow(index + 28, { baseline: 0.5, candidate: 0.6, shadow: 0.6 }));
  const selection = adaptiveSelection([...early, ...recent], candidates);
  assert.equal(selection.diagnostics.recentAdaptiveBrier > selection.diagnostics.recentBaselineBrier, true);
  assert.equal(selection.model, 'baseline');
});

test('systematic resampling is deterministic and normalizes raw branch weights', () => {
  const raw = [
    { state: { id: 'a' }, path: '00', weight: 1 },
    { state: { id: 'b' }, path: '01', weight: 2 },
    { state: { id: 'c' }, path: '10', weight: 3 },
    { state: { id: 'd' }, path: '11', weight: 4 }
  ];
  const first = systematicResample(raw, 2);
  const second = systematicResample(raw, 2);
  assert.deepEqual(second, first);
  assert.equal(first.resampled, true);
  assert.deepEqual(first.branches.map((branch) => branch.path), ['01', '11']);
  assert.deepEqual(first.branches.map((branch) => branch.weight), [0.5, 0.5]);
  assert.equal(first.branches.reduce((sum, branch) => sum + branch.weight, 0), 1);
  assert.deepEqual(raw.map((branch) => branch.weight), [1, 2, 3, 4]);
});

test('30-day outlook is causal, bounded, deterministic, and never linear extrapolation', () => {
  const state = createDefaultState();
  const startedAt = performance.now();
  const first = buildRecursiveOutlook(state, '2026-07-23');
  const elapsedMs = performance.now() - startedAt;
  const second = buildRecursiveOutlook(state, '2026-07-23');
  assert.deepEqual(second, first);
  assert.equal(first.method, OUTLOOK_METHOD);
  assert.equal(first.horizon, OUTLOOK_HORIZON);
  assert.equal(first.particleCap, OUTLOOK_PARTICLE_CAP);
  assert.equal(first.points.length, OUTLOOK_HORIZON);
  assert.deepEqual(
    first.points.map((point) => point.targetDay),
    Array.from({ length: OUTLOOK_HORIZON }, (_, index) => addDays('2026-07-23', index + 1))
  );
  assert.equal(first.points[0].percent, 25);
  assert.ok(new Set(first.points.map((point) => point.percent)).size >= 3);
  assert.deepEqual(first.points.slice(0, 6).map((point) => point.branchCount), [1, 2, 4, 8, 16, 32]);
  assert.ok(first.points.every((point) => point.branchCount <= OUTLOOK_PARTICLE_CAP));
  assert.ok(first.points.every((point) => point.uniqueBranchCount <= point.branchCount));
  assert.ok(first.points.some((point) => point.resampled));
  assert.ok(first.points.every((point) => Math.abs(point.pathWeightTotal - 1) < 1e-12));
  assert.ok(first.points.every((point) => point.nextBranchCount <= OUTLOOK_PARTICLE_CAP));
  const deltas = first.points.slice(1).map((point, index) => point.percent - first.points[index].percent);
  assert.ok(new Set(deltas).size > 1);
  assert.ok(elapsedMs < 10_000, `30-day outlook took ${Math.round(elapsedMs)} ms`);
});

test('outlook marginalizes an unanswered active day without mutating it', () => {
  const state = createDefaultState();
  const issued = computeForecast(state, '2026-07-24');
  state.forecasts.official['2026-07-24'] = { ...issued, issuedAt: '2026-07-24T10:00:00.000Z' };
  const outlook = buildRecursiveOutlook(state, '2026-07-24');
  assert.equal(outlook.points[0].branchCount, 2);
  assert.equal(outlook.points.at(-1).branchCount, OUTLOOK_PARTICLE_CAP);
  assert.equal(Object.hasOwn(state.outcomes, '2026-07-24'), false);
  assert.ok(outlook.points.every((point) => Math.abs(point.pathWeightTotal - 1) < 1e-12));

  const yesState = {
    ...state,
    outcomes: { ...state.outcomes, '2026-07-24': { played: true, source: 'test-path' } }
  };
  const noState = {
    ...state,
    outcomes: { ...state.outcomes, '2026-07-24': { played: false, source: 'test-path' } }
  };
  const exactTomorrow = (
    issued.unroundedProbability * computeForecast(yesState, '2026-07-25').unroundedProbability
    + (1 - issued.unroundedProbability) * computeForecast(noState, '2026-07-25').unroundedProbability
  );
  assert.equal(outlook.points[0].percent, Math.round(exactTomorrow * 100));
});
