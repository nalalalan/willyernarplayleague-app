'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  adaptiveSelection,
  buildRecursiveOutlook,
  calculateCandidates,
  computeForecast,
  deriveAdaptiveWeights,
  evaluateCalibration
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

test('four authoritative No outcomes produce the required 25% baseline', () => {
  const forecast = computeForecast(createDefaultState(), '2026-07-24');
  assert.equal(forecast.percent, 25);
  assert.equal(forecast.probability, 0.25);
  assert.equal(forecast.stage, 'bayesian-baseline');
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

test('seven-day outlook is recursively marginalized, deterministic, and never linear extrapolation', () => {
  const state = createDefaultState();
  const first = buildRecursiveOutlook(state, '2026-07-23');
  const second = buildRecursiveOutlook(state, '2026-07-23');
  assert.deepEqual(second, first);
  assert.equal(first.method, 'recursive-branch-marginalization');
  assert.equal(first.points.length, 7);
  assert.deepEqual(first.points.map((point) => point.targetDay), Array.from({ length: 7 }, (_, index) => addDays('2026-07-23', index + 1)));
  assert.equal(first.points[0].percent, 25);
  assert.ok(new Set(first.points.map((point) => point.percent)).size >= 3);
  assert.deepEqual(first.points.map((point) => point.branchCount), [1, 2, 4, 8, 16, 32, 64]);
  assert.ok(first.points.every((point) => Math.abs(point.pathWeightTotal - 1) < 1e-12));
  const deltas = first.points.slice(1).map((point, index) => point.percent - first.points[index].percent);
  assert.ok(new Set(deltas).size > 1);
});

test('outlook marginalizes an unanswered active day without mutating it', () => {
  const state = createDefaultState();
  const issued = computeForecast(state, '2026-07-24');
  state.forecasts.official['2026-07-24'] = { ...issued, issuedAt: '2026-07-24T10:00:00.000Z' };
  const outlook = buildRecursiveOutlook(state, '2026-07-24');
  assert.equal(outlook.points[0].branchCount, 2);
  assert.equal(outlook.points[6].branchCount, 128);
  assert.equal(Object.hasOwn(state.outcomes, '2026-07-24'), false);
  assert.ok(outlook.points.every((point) => Math.abs(point.pathWeightTotal - 1) < 1e-12));
});
