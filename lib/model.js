'use strict';

const {
  addDays,
  dayOfWeek,
  daysBetween,
  isWeekend
} = require('./time');

const EPSILON = 1e-9;
const CORE_ADAPTIVE_CANDIDATES = [
  'baseline',
  'calendar',
  'recency7',
  'recency14',
  'recency28',
  'transition',
  'streak',
  'sinceLastYes'
];
const CADENCE_CANDIDATES = [
  'dayOfWeek',
  'weeklyCadence',
  'monthlyCadence',
  'recentLoad',
  'reboundCooldown',
  'gapHazard'
];
const ALL_ADAPTIVE_CANDIDATES = [...CORE_ADAPTIVE_CANDIDATES, ...CADENCE_CANDIDATES];

function clamp(value, minimum = 0.05, maximum = 0.95) {
  return Math.min(maximum, Math.max(minimum, value));
}

function roundProbability(value) {
  const percent = Math.round(clamp(value) * 100);
  return { probability: percent / 100, percent };
}

function answeredRowsBefore(state, targetDay) {
  return Object.entries(state.outcomes || {})
    .filter(([dateKey, record]) => dateKey < targetDay && record && typeof record.played === 'boolean')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dateKey, record]) => ({ dateKey, played: record.played }));
}

function outcomeMapFromRows(rows) {
  return new Map(rows.map((row) => [row.dateKey, row.played]));
}

function betaRate(rows) {
  const yes = rows.reduce((total, row) => total + (row.played ? 1 : 0), 0);
  return (yes + 2) / (rows.length + 4);
}

function shrunkRate(samples, center, strength = 6) {
  let weightedYes = 0;
  let totalWeight = 0;
  for (const sample of samples) {
    const weight = Number.isFinite(sample.weight) ? Math.max(0, sample.weight) : 1;
    weightedYes += weight * (sample.played ? 1 : 0);
    totalWeight += weight;
  }
  return (weightedYes + center * strength) / (totalWeight + strength);
}

function recencyRate(rows, targetDay, halfLife, center) {
  const decay = Math.log(2) / halfLife;
  return shrunkRate(rows.map((row) => ({
    played: row.played,
    weight: Math.exp(-decay * Math.max(1, daysBetween(row.dateKey, targetDay)))
  })), center, 4);
}

function calendarRate(rows, targetDay, center) {
  const weekend = isWeekend(targetDay);
  return shrunkRate(rows
    .filter((row) => isWeekend(row.dateKey) === weekend)
    .map((row) => ({ ...row, weight: 1 })), center, 6);
}

function weekdayRate(rows, targetDay, center) {
  const weekday = dayOfWeek(targetDay);
  return shrunkRate(rows
    .filter((row) => dayOfWeek(row.dateKey) === weekday)
    .map((row) => ({ ...row, weight: 1 })), center, 6);
}

function transitionRate(rows, targetDay, center) {
  const map = outcomeMapFromRows(rows);
  const prior = map.get(addDays(targetDay, -1));
  if (typeof prior !== 'boolean') return center;

  const samples = [];
  for (const row of rows) {
    const previous = map.get(addDays(row.dateKey, -1));
    if (typeof previous === 'boolean' && previous === prior) {
      samples.push({ played: row.played, weight: 1 });
    }
  }
  return shrunkRate(samples, center, 6);
}

function streakBefore(map, targetDay) {
  let cursor = addDays(targetDay, -1);
  const played = map.get(cursor);
  if (typeof played !== 'boolean') return null;
  let length = 0;
  while (map.get(cursor) === played) {
    length += 1;
    cursor = addDays(cursor, -1);
  }
  return { played, length };
}

function streakRate(rows, targetDay, center) {
  const map = outcomeMapFromRows(rows);
  const targetStreak = streakBefore(map, targetDay);
  if (!targetStreak) return center;
  const targetBucket = Math.min(targetStreak.length, 3);
  const samples = [];
  for (const row of rows) {
    const context = streakBefore(map, row.dateKey);
    if (!context) continue;
    if (context.played === targetStreak.played && Math.min(context.length, 3) === targetBucket) {
      samples.push({ played: row.played, weight: 1 });
    }
  }
  return shrunkRate(samples, center, 7);
}

function gapSincePriorYes(map, targetDay) {
  let latest = null;
  for (const [dateKey, played] of map.entries()) {
    if (dateKey < targetDay && played && (!latest || dateKey > latest)) latest = dateKey;
  }
  return latest ? daysBetween(latest, targetDay) : null;
}

function gapContextRate(rows, targetDay, center, strength, width) {
  const map = outcomeMapFromRows(rows);
  const targetGap = gapSincePriorYes(map, targetDay);
  if (targetGap === null) return center;
  const samples = [];
  for (const row of rows) {
    const gap = gapSincePriorYes(map, row.dateKey);
    if (gap === null) continue;
    samples.push({
      played: row.played,
      weight: Math.exp(-Math.abs(gap - targetGap) / width)
    });
  }
  return shrunkRate(samples, center, strength);
}

function weeklySignature(map, targetDay) {
  const signature = [];
  for (const lag of [7, 14, 21, 28]) {
    const value = map.get(addDays(targetDay, -lag));
    if (typeof value === 'boolean') signature.push({ lag, value });
  }
  return signature;
}

function weeklyCadenceRate(rows, targetDay, center) {
  const map = outcomeMapFromRows(rows);
  const targetSignature = weeklySignature(map, targetDay);
  if (targetSignature.length === 0) return center;
  const samples = [];
  for (const row of rows) {
    let comparable = 0;
    let matches = 0;
    for (const part of targetSignature) {
      const historic = map.get(addDays(row.dateKey, -part.lag));
      if (typeof historic !== 'boolean') continue;
      comparable += 1;
      if (historic === part.value) matches += 1;
    }
    if (comparable > 0) {
      samples.push({ played: row.played, weight: 0.25 + 0.75 * (matches / comparable) });
    }
  }
  return shrunkRate(samples, center, 8);
}

function monthPhaseDistance(leftDay, rightDay) {
  const left = Number(leftDay.slice(8, 10));
  const right = Number(rightDay.slice(8, 10));
  const direct = Math.abs(left - right);
  return Math.min(direct, 31 - direct);
}

function monthlyCadenceRate(rows, targetDay, center) {
  return shrunkRate(rows.map((row) => ({
    played: row.played,
    weight: Math.exp(-monthPhaseDistance(row.dateKey, targetDay) / 4)
  })), center, 9);
}

function densityBefore(map, targetDay, windowDays) {
  let answered = 0;
  let yes = 0;
  for (let offset = 1; offset <= windowDays; offset += 1) {
    const value = map.get(addDays(targetDay, -offset));
    if (typeof value !== 'boolean') continue;
    answered += 1;
    if (value) yes += 1;
  }
  return answered > 0 ? { rate: yes / answered, answered, yes } : null;
}

function recentLoadRate(rows, targetDay, center) {
  const map = outcomeMapFromRows(rows);
  const target = densityBefore(map, targetDay, 7);
  if (!target) return center;
  const samples = [];
  for (const row of rows) {
    const historic = densityBefore(map, row.dateKey, 7);
    if (!historic) continue;
    samples.push({
      played: row.played,
      weight: Math.exp(-4 * Math.abs(historic.rate - target.rate))
    });
  }
  return shrunkRate(samples, center, 8);
}

function cooldownContext(map, targetDay) {
  const short = densityBefore(map, targetDay, 3);
  const medium = densityBefore(map, targetDay, 7);
  if (!short && !medium) return null;
  return {
    short: short ? short.rate : null,
    medium: medium ? medium.rate : null,
    observations: (short?.answered || 0) + (medium?.answered || 0)
  };
}

function reboundCooldownRate(rows, targetDay, center) {
  const map = outcomeMapFromRows(rows);
  const target = cooldownContext(map, targetDay);
  if (!target) return center;
  const samples = [];
  for (const row of rows) {
    const historic = cooldownContext(map, row.dateKey);
    if (!historic) continue;
    let distance = 0;
    let comparable = 0;
    if (target.short !== null && historic.short !== null) {
      distance += Math.abs(historic.short - target.short);
      comparable += 1;
    }
    if (target.medium !== null && historic.medium !== null) {
      distance += 0.5 * Math.abs(historic.medium - target.medium);
      comparable += 0.5;
    }
    if (comparable === 0) continue;
    distance /= comparable;
    samples.push({ played: row.played, weight: Math.exp(-3 * distance) });
  }
  return shrunkRate(samples, center, 9);
}

function calculateCandidates(state, targetDay) {
  const rows = answeredRowsBefore(state, targetDay);
  const baseline = betaRate(rows);
  const recency7 = recencyRate(rows, targetDay, 7, baseline);
  const recency14 = recencyRate(rows, targetDay, 14, baseline);
  const recency28 = recencyRate(rows, targetDay, 28, baseline);

  const candidates = {
    baseline,
    calendar: calendarRate(rows, targetDay, baseline),
    dayOfWeek: weekdayRate(rows, targetDay, baseline),
    recency7,
    recency14,
    recency28,
    recency: (recency7 + recency14 + recency28) / 3,
    transition: transitionRate(rows, targetDay, baseline),
    streak: streakRate(rows, targetDay, baseline),
    sinceLastYes: gapContextRate(rows, targetDay, baseline, 7, 7),
    weeklyCadence: weeklyCadenceRate(rows, targetDay, baseline),
    monthlyCadence: monthlyCadenceRate(rows, targetDay, baseline),
    recentLoad: recentLoadRate(rows, targetDay, baseline),
    reboundCooldown: reboundCooldownRate(rows, targetDay, baseline),
    gapHazard: gapContextRate(rows, targetDay, baseline, 9, 14)
  };

  return Object.fromEntries(Object.entries(candidates).map(([name, probability]) => [name, clamp(probability)]));
}

function brier(probability, outcome) {
  return (probability - (outcome ? 1 : 0)) ** 2;
}

function logLoss(probability, outcome) {
  const p = Math.min(1 - EPSILON, Math.max(EPSILON, probability));
  return outcome ? -Math.log(p) : -Math.log(1 - p);
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : Infinity;
}

function scoreRows(state, targetDay) {
  return (state.metrics?.scores || [])
    .filter((row) => row.targetDay < targetDay && typeof row.played === 'boolean')
    .sort((a, b) => a.targetDay.localeCompare(b.targetDay));
}

function metricFor(rows, candidateName, metric) {
  return mean(rows.map((row) => {
    const probability = row.candidates?.[candidateName] ?? row.candidates?.baseline ?? row.probability;
    return metric(probability, row.played);
  }));
}

function normalizeWithFloor(rawWeights, floor = 0.05) {
  const names = Object.keys(rawWeights);
  if (names.length === 0) return {};
  const effectiveFloor = Math.min(floor, 1 / names.length);
  const available = 1 - effectiveFloor * names.length;
  const rawTotal = names.reduce((sum, name) => sum + rawWeights[name], 0) || names.length;
  return Object.fromEntries(names.map((name) => [
    name,
    effectiveFloor + available * ((rawWeights[name] || 1) / rawTotal)
  ]));
}

function weightedProbability(candidates, weights) {
  return Object.entries(weights).reduce((total, [name, weight]) => total + weight * candidates[name], 0);
}

function historicalWeightedProbability(row, weights) {
  const candidates = row.candidates || { baseline: row.probability };
  return Object.entries(weights).reduce((total, [name, weight]) => {
    const probability = candidates[name] ?? candidates.baseline ?? row.probability;
    return total + weight * probability;
  }, 0);
}

function deriveAdaptiveWeights(trainingRows) {
  const window = trainingRows.slice(-56);
  const baselineBrier = metricFor(window, 'baseline', brier);
  const baselineLogLoss = metricFor(window, 'baseline', logLoss);
  const eligibleNames = [...CORE_ADAPTIVE_CANDIDATES];
  const candidateMetrics = {};

  for (const name of ALL_ADAPTIVE_CANDIDATES) {
    candidateMetrics[name] = {
      brier: metricFor(window, name, brier),
      logLoss: metricFor(window, name, logLoss)
    };
  }

  for (const name of CADENCE_CANDIDATES) {
    const candidate = candidateMetrics[name];
    if (candidate.brier < baselineBrier && candidate.logLoss < baselineLogLoss) {
      eligibleNames.push(name);
    }
  }

  const rawWeights = Object.fromEntries(eligibleNames.map((name) => [
    name,
    Math.exp(-12 * candidateMetrics[name].brier)
  ]));
  const weights = normalizeWithFloor(rawWeights, 0.05);
  return { weights, candidateMetrics, eligibleNames, baselineBrier, baselineLogLoss };
}

function causalShadowRows(rows) {
  return rows.map((row, index) => {
    if (Number.isFinite(row.shadowAdaptiveProbability)) {
      return { ...row, shadowProbability: row.shadowAdaptiveProbability };
    }
    const training = rows.slice(0, index);
    if (training.length < 14) {
      return { ...row, shadowProbability: row.candidates?.baseline ?? row.probability };
    }
    const { weights } = deriveAdaptiveWeights(training);
    return { ...row, shadowProbability: historicalWeightedProbability(row, weights) };
  });
}

function adaptiveSelection(rows, candidates) {
  const window = rows.slice(-56);
  const derived = deriveAdaptiveWeights(window);
  const weights = derived.weights;
  const baselineBrier = derived.baselineBrier;
  const baselineLogLoss = derived.baselineLogLoss;
  const shadowRows = causalShadowRows(window);
  const adaptiveBrier = mean(shadowRows.map((row) => brier(row.shadowProbability, row.played)));
  const adaptiveLogLoss = mean(shadowRows.map((row) => logLoss(row.shadowProbability, row.played)));
  const relativeGain = baselineBrier > 0 ? (baselineBrier - adaptiveBrier) / baselineBrier : 0;
  const newest28 = shadowRows.slice(-28);
  const recentAdaptiveBrier = mean(newest28.map((row) => brier(row.shadowProbability, row.played)));
  const recentBaselineBrier = metricFor(newest28, 'baseline', brier);
  const passesGate = baselineBrier - adaptiveBrier >= 0.01
    && relativeGain >= 0.05
    && adaptiveLogLoss < baselineLogLoss
    && recentAdaptiveBrier <= recentBaselineBrier;

  const shadowProbability = weightedProbability(candidates, weights);

  return {
    probability: passesGate ? weightedProbability(candidates, weights) : candidates.baseline,
    weights: passesGate ? weights : { baseline: 1 },
    shadowProbability,
    shadowWeights: weights,
    model: passesGate ? 'adaptive' : 'baseline',
    diagnostics: {
      adaptiveBrier,
      adaptiveLogLoss,
      baselineBrier,
      baselineLogLoss,
      candidateMetrics: derived.candidateMetrics,
      eligibleCandidates: derived.eligibleNames,
      recentAdaptiveBrier,
      recentBaselineBrier,
      relativeGain,
      passed: passesGate
    }
  };
}

function sigmoid(value) {
  if (value >= 0) {
    const exp = Math.exp(-value);
    return 1 / (1 + exp);
  }
  const exp = Math.exp(value);
  return exp / (1 + exp);
}

function logit(probability) {
  const p = Math.min(1 - 1e-6, Math.max(1e-6, probability));
  return Math.log(p / (1 - p));
}

function fitLogistic(rows, regularization = 0.1) {
  let slope = 1;
  let intercept = 0;
  const learningRate = 0.05;
  for (let iteration = 0; iteration < 600; iteration += 1) {
    let slopeGradient = regularization * (slope - 1);
    let interceptGradient = regularization * intercept;
    for (const row of rows) {
      const x = logit(row.rawProbability);
      const error = sigmoid(slope * x + intercept) - (row.played ? 1 : 0);
      slopeGradient += error * x;
      interceptGradient += error;
    }
    const scale = Math.max(1, rows.length);
    slope -= learningRate * slopeGradient / scale;
    intercept -= learningRate * interceptGradient / scale;
  }
  return { slope, intercept };
}

function applyCalibration(probability, parameters) {
  return sigmoid(parameters.slope * logit(probability) + parameters.intercept);
}

function evaluateCalibration(rows) {
  if (rows.length < 50) return { attempted: false, retained: false };
  const evaluations = [];
  for (let index = 20; index < rows.length; index += 1) {
    const training = rows.slice(0, index).map((row) => ({
      rawProbability: row.rawProbability ?? row.probability,
      played: row.played
    }));
    const parameters = fitLogistic(training);
    const rawProbability = rows[index].rawProbability ?? rows[index].probability;
    evaluations.push({
      rawProbability,
      calibratedProbability: applyCalibration(rawProbability, parameters),
      played: rows[index].played
    });
  }

  const rawBrier = mean(evaluations.map((row) => brier(row.rawProbability, row.played)));
  const calibratedBrier = mean(evaluations.map((row) => brier(row.calibratedProbability, row.played)));
  const rawLogLoss = mean(evaluations.map((row) => logLoss(row.rawProbability, row.played)));
  const calibratedLogLoss = mean(evaluations.map((row) => logLoss(row.calibratedProbability, row.played)));
  const retained = calibratedBrier < rawBrier && calibratedLogLoss < rawLogLoss;
  const parameters = retained ? fitLogistic(rows.map((row) => ({
    rawProbability: row.rawProbability ?? row.probability,
    played: row.played
  }))) : null;

  return {
    attempted: true,
    retained,
    parameters,
    rawBrier,
    calibratedBrier,
    rawLogLoss,
    calibratedLogLoss
  };
}

function computeForecast(state, targetDay) {
  const candidates = calculateCandidates(state, targetDay);
  const rows = scoreRows(state, targetDay);
  let selection;
  let stage;

  if (rows.length < 14) {
    selection = {
      probability: candidates.baseline,
      weights: { baseline: 1 },
      shadowProbability: candidates.baseline,
      shadowWeights: { baseline: 1 },
      model: 'baseline',
      diagnostics: null
    };
    stage = 'bayesian-baseline';
  } else if (rows.length < 28) {
    selection = {
      probability: 0.7 * candidates.baseline + 0.15 * candidates.calendar + 0.15 * candidates.recency,
      weights: { baseline: 0.7, calendar: 0.15, recency: 0.15 },
      shadowProbability: 0.7 * candidates.baseline + 0.15 * candidates.calendar + 0.15 * candidates.recency,
      shadowWeights: { baseline: 0.7, calendar: 0.15, recency: 0.15 },
      model: 'fixed-blend',
      diagnostics: null
    };
    stage = 'fixed-blend';
  } else {
    selection = adaptiveSelection(rows, candidates);
    stage = selection.model === 'adaptive' ? 'adaptive-ensemble' : 'adaptive-gated-baseline';
  }

  const rawProbability = clamp(selection.probability);
  const calibration = evaluateCalibration(rows);
  const calibrated = calibration.retained
    ? clamp(applyCalibration(rawProbability, calibration.parameters))
    : rawProbability;
  const rounded = roundProbability(calibrated);

  return {
    targetDay,
    probability: rounded.probability,
    percent: rounded.percent,
    rawProbability,
    unroundedProbability: calibrated,
    candidates,
    weights: selection.weights,
    shadowAdaptiveProbability: selection.shadowProbability,
    shadowWeights: selection.shadowWeights,
    stage,
    model: calibration.retained ? `${selection.model}-calibrated` : selection.model,
    scoreCount: rows.length,
    diagnostics: selection.diagnostics,
    calibration
  };
}

function cloneStateWithOutcome(state, targetDay, played) {
  return {
    ...state,
    outcomes: {
      ...(state.outcomes || {}),
      [targetDay]: { played, source: 'forecast-path' }
    }
  };
}

function computePatternOutlookForecast(state, targetDay) {
  const candidates = calculateCandidates(state, targetDay);
  const shrunkPatternProbability = (
    0.70 * candidates.baseline
    + 0.04 * candidates.calendar
    + 0.04 * candidates.dayOfWeek
    + 0.04 * candidates.recency
    + 0.03 * candidates.weeklyCadence
    + 0.03 * candidates.monthlyCadence
    + 0.03 * candidates.transition
    + 0.03 * candidates.streak
    + 0.03 * candidates.recentLoad
    + 0.03 * candidates.reboundCooldown
  );
  const rows = answeredRowsBefore(state, targetDay);
  const map = outcomeMapFromRows(rows);
  const prior = map.get(addDays(targetDay, -1));
  const streak = streakBefore(map, targetDay);
  let contextShift = isWeekend(targetDay) ? 0.14 : -0.02;
  if (typeof prior === 'boolean') contextShift += prior ? -0.32 : 0.24;
  if (streak && streak.length > 1) {
    const extraDays = Math.min(2, streak.length - 1);
    contextShift += (streak.played ? -0.06 : 0.05) * extraDays;
  }
  const probability = clamp(sigmoid(logit(shrunkPatternProbability) + contextShift));
  const rounded = roundProbability(probability);
  return {
    targetDay,
    probability: rounded.probability,
    percent: rounded.percent,
    unroundedProbability: probability,
    candidates,
    weights: {
      baseline: 0.70,
      calendar: 0.04,
      dayOfWeek: 0.04,
      recency: 0.04,
      weeklyCadence: 0.03,
      monthlyCadence: 0.03,
      transition: 0.03,
      streak: 0.03,
      recentLoad: 0.03,
      reboundCooldown: 0.03
    },
    model: 'strongly-shrunk-pattern-outlook'
  };
}

function buildRecursiveOutlook(state, baseDay, horizon = 7) {
  let branches = [{ state, weight: 1 }];
  const points = [];

  if (typeof state.outcomes?.[baseDay]?.played !== 'boolean') {
    const issued = state.forecasts?.official?.[baseDay];
    const computed = issued ? null : computeForecast(state, baseDay);
    const currentProbability = issued?.unroundedProbability
      ?? issued?.probability
      ?? computed.unroundedProbability;
    branches = [
      { state: cloneStateWithOutcome(state, baseDay, true), weight: currentProbability },
      { state: cloneStateWithOutcome(state, baseDay, false), weight: 1 - currentProbability }
    ];
  }

  for (let offset = 1; offset <= horizon; offset += 1) {
    const targetDay = addDays(baseDay, offset);
    const branchForecasts = branches.map((branch) => ({
      ...branch,
      forecast: offset === 1
        ? computeForecast(branch.state, targetDay)
        : computePatternOutlookForecast(branch.state, targetDay)
    }));
    const marginal = branchForecasts.reduce((total, branch) => (
      total + branch.weight * branch.forecast.unroundedProbability
    ), 0);
    const rounded = roundProbability(marginal);
    const pathWeightTotal = branchForecasts.reduce((total, branch) => total + branch.weight, 0);
    points.push({
      targetDay,
      probability: rounded.probability,
      percent: rounded.percent,
      branchCount: branchForecasts.length,
      pathWeightTotal
    });

    const nextBranches = [];
    for (const branch of branchForecasts) {
      const probability = branch.forecast.unroundedProbability;
      nextBranches.push({
        state: cloneStateWithOutcome(branch.state, targetDay, true),
        weight: branch.weight * probability
      });
      nextBranches.push({
        state: cloneStateWithOutcome(branch.state, targetDay, false),
        weight: branch.weight * (1 - probability)
      });
    }
    branches = nextBranches;
  }

  return {
    baseDay,
    horizon,
    method: 'recursive-branch-marginalization',
    points
  };
}

module.exports = {
  ALL_ADAPTIVE_CANDIDATES,
  CADENCE_CANDIDATES,
  adaptiveSelection,
  answeredRowsBefore,
  applyCalibration,
  brier,
  buildRecursiveOutlook,
  calculateCandidates,
  clamp,
  computeForecast,
  computePatternOutlookForecast,
  deriveAdaptiveWeights,
  evaluateCalibration,
  fitLogistic,
  logLoss,
  normalizeWithFloor,
  roundProbability,
  weightedProbability
};
