'use strict';

const {
  OUTLOOK_HORIZON,
  OUTLOOK_METHOD,
  OUTLOOK_PARTICLE_CAP,
  brier,
  buildRecursiveOutlook,
  computeForecast,
  logLoss
} = require('./model');
const { addDays, displayDate, leagueDayKey, nextDayKey } = require('./time');

const SCHEMA_VERSION = 3;
const SEED_VERSION = 2;
const AUDIT_LIMIT = 200;
const TIME_ZONE = process.env.TIME_ZONE || 'America/New_York';
const DEFAULT_YES_START_DAY = '2026-07-04';
const DEFAULT_YES_POLICY_VERSION = 1;

const SEED_OUTCOMES = Object.freeze({
  '2026-07-04': false,
  '2026-07-13': false,
  '2026-07-22': false,
  '2026-07-23': false
});

function makeSeedRecord(played) {
  return {
    played,
    source: 'authoritative-seed',
    recordedAt: null,
    revision: 1
  };
}

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isDateKey(value) {
  if (typeof value !== 'string') return false;
  const match = DATE_KEY_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function isTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isProbability(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function isProbabilityRecord(value) {
  return isPlainRecord(value) && Object.values(value).every(isProbability);
}

function isForecastPoint(value, expectedDay) {
  return isPlainRecord(value)
    && value.targetDay === expectedDay
    && isDateKey(value.targetDay)
    && isProbability(value.probability)
    && Number.isInteger(value.percent)
    && value.percent >= 0
    && value.percent <= 100;
}

function isOutcomeRecord(value) {
  return isPlainRecord(value)
    && typeof value.played === 'boolean'
    && typeof value.source === 'string'
    && value.source.length > 0
    && (value.recordedAt === null || isTimestamp(value.recordedAt))
    && Number.isInteger(value.revision)
    && value.revision >= 1;
}

function isDeletedOutcome(value) {
  return isPlainRecord(value)
    && isTimestamp(value.deletedAt)
    && typeof value.previousPlayed === 'boolean'
    && Number.isInteger(value.revision)
    && value.revision >= 1
    && Number.isInteger(value.sequence)
    && value.sequence >= 1;
}

function isOutcomeChange(value) {
  const deletion = value?.played === null;
  return isPlainRecord(value)
    && Number.isInteger(value.sequence)
    && value.sequence >= 1
    && isDateKey(value.leagueDay)
    && (value.previousPlayed === null || typeof value.previousPlayed === 'boolean')
    && (value.played === null || typeof value.played === 'boolean')
    && (!deletion || (typeof value.previousPlayed === 'boolean' && value.source === 'explicit-delete'))
    && isTimestamp(value.changedAt);
}

function isAuditEvent(value) {
  const deletion = value?.played === null;
  return isPlainRecord(value)
    && Number.isInteger(value.sequence)
    && value.sequence >= 1
    && isDateKey(value.leagueDay)
    && (value.played === null || typeof value.played === 'boolean')
    && (!deletion || value.action === 'delete')
    && isTimestamp(value.changedAt);
}

function sequencesIncrease(values) {
  return values.every((value, index) => index === 0 || value.sequence > values[index - 1].sequence);
}

function isOfficialForecast(value, expectedDay) {
  return isForecastPoint(value, expectedDay)
    && value.kind === 'official'
    && isTimestamp(value.issuedAt)
    && isProbability(value.rawProbability)
    && isProbability(value.unroundedProbability)
    && isProbability(value.shadowAdaptiveProbability)
    && isProbabilityRecord(value.candidates)
    && isProbabilityRecord(value.weights)
    && isProbabilityRecord(value.shadowWeights)
    && typeof value.stage === 'string'
    && typeof value.model === 'string'
    && Number.isInteger(value.scoreCount)
    && value.scoreCount >= 0
    && isPlainRecord(value.calibration)
    && typeof value.calibration.attempted === 'boolean'
    && typeof value.calibration.retained === 'boolean';
}

function isProvisionalForecast(value, expectedDay) {
  return isForecastPoint(value, expectedDay)
    && value.kind === 'provisional'
    && isTimestamp(value.issuedAt)
    && typeof value.method === 'string'
    && Number.isInteger(value.branchCount)
    && value.branchCount >= 1
    && Number.isFinite(value.pathWeightTotal)
    && Math.abs(value.pathWeightTotal - 1) < 1e-8;
}

function isOutlook(value) {
  if (value === null) return true;
  if (!isPlainRecord(value)
    || !isDateKey(value.baseDay)
    || !Number.isInteger(value.horizon)
    || value.horizon < 1
    || typeof value.method !== 'string'
    || !Array.isArray(value.points)
    || value.points.length !== value.horizon
    || !isTimestamp(value.issuedAt)
    || !Number.isInteger(value.basisRevision)
    || value.basisRevision < 0) return false;
  let expectedDay = value.baseDay;
  return value.points.every((point) => {
    expectedDay = nextDayKey(expectedDay);
    return isForecastPoint(point, expectedDay)
      && Number.isInteger(point.branchCount)
      && point.branchCount >= 1
      && Number.isFinite(point.pathWeightTotal)
      && Math.abs(point.pathWeightTotal - 1) < 1e-8;
  });
}

function isScore(value) {
  return isPlainRecord(value)
    && isDateKey(value.targetDay)
    && isTimestamp(value.scoredAt)
    && typeof value.played === 'boolean'
    && isProbability(value.probability)
    && isProbability(value.rawProbability)
    && isProbability(value.shadowAdaptiveProbability)
    && isProbabilityRecord(value.candidates)
    && isProbabilityRecord(value.weights)
    && isProbabilityRecord(value.shadowWeights)
    && Number.isFinite(value.brier)
    && value.brier >= 0
    && value.brier <= 1
    && Number.isFinite(value.logLoss)
    && value.logLoss >= 0;
}

function isCalibrationEntry(value) {
  if (!isPlainRecord(value)
    || !isDateKey(value.targetDay)
    || !isTimestamp(value.issuedAt)
    || typeof value.attempted !== 'boolean'
    || typeof value.retained !== 'boolean') return false;
  return ['rawBrier', 'calibratedBrier', 'rawLogLoss', 'calibratedLogLoss']
    .every((key) => value[key] === null || (Number.isFinite(value[key]) && value[key] >= 0));
}

function createDefaultState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    seedVersion: SEED_VERSION,
    outcomeRevision: 0,
    nextSequence: 1,
    defaultYesPolicy: {
      version: DEFAULT_YES_POLICY_VERSION,
      backfillThrough: null
    },
    outcomes: Object.fromEntries(Object.entries(SEED_OUTCOMES).map(([dateKey, played]) => [
      dateKey,
      makeSeedRecord(played)
    ])),
    deletedOutcomes: {},
    outcomeChanges: [],
    audit: [],
    forecasts: {
      official: {},
      provisional: {},
      outlook: null
    },
    metrics: {
      scores: [],
      calibrationHistory: []
    }
  };
}

function validateState(state) {
  if (!isPlainRecord(state)
    || state.schemaVersion !== SCHEMA_VERSION
    || state.seedVersion !== SEED_VERSION
    || !Number.isInteger(state.outcomeRevision)
    || state.outcomeRevision < 0
    || !Number.isInteger(state.nextSequence)
    || state.nextSequence < 1
    || !isPlainRecord(state.defaultYesPolicy)
    || state.defaultYesPolicy.version !== DEFAULT_YES_POLICY_VERSION
    || (state.defaultYesPolicy.backfillThrough !== null && !isDateKey(state.defaultYesPolicy.backfillThrough))
    || !isPlainRecord(state.outcomes)
    || !Object.entries(state.outcomes).every(([dateKey, record]) => isDateKey(dateKey) && isOutcomeRecord(record))
    || !isPlainRecord(state.deletedOutcomes)
    || !Object.entries(state.deletedOutcomes).every(([dateKey, record]) => isDateKey(dateKey) && isDeletedOutcome(record))
    || Object.keys(state.deletedOutcomes).some((dateKey) => Object.hasOwn(state.outcomes, dateKey))
    || !Array.isArray(state.outcomeChanges)
    || !state.outcomeChanges.every(isOutcomeChange)
    || !sequencesIncrease(state.outcomeChanges)
    || !Array.isArray(state.audit)
    || state.audit.length > AUDIT_LIMIT
    || !state.audit.every(isAuditEvent)
    || !sequencesIncrease(state.audit)
    || !isPlainRecord(state.forecasts)
    || !isPlainRecord(state.forecasts.official)
    || !Object.entries(state.forecasts.official).every(([dateKey, forecast]) => isOfficialForecast(forecast, dateKey))
    || !isPlainRecord(state.forecasts.provisional)
    || !Object.entries(state.forecasts.provisional).every(([dateKey, forecast]) => isProvisionalForecast(forecast, dateKey))
    || !isOutlook(state.forecasts.outlook)
    || !isPlainRecord(state.metrics)
    || !Array.isArray(state.metrics.scores)
    || !state.metrics.scores.every(isScore)
    || !Array.isArray(state.metrics.calibrationHistory)
    || !state.metrics.calibrationHistory.every(isCalibrationEntry)) return false;

  const maximumSequence = state.outcomeChanges.reduce((maximum, event) => Math.max(maximum, event.sequence), 0);
  return state.nextSequence > maximumSequence;
}

function migrateState(input) {
  let changed = false;
  const state = input && typeof input === 'object' ? input : createDefaultState();

  if (!state.outcomes || typeof state.outcomes !== 'object') {
    state.outcomes = {};
    changed = true;
  }
  if (!isPlainRecord(state.deletedOutcomes)) {
    state.deletedOutcomes = {};
    changed = true;
  }
  for (const dateKey of Object.keys(state.deletedOutcomes)) {
    if (Object.hasOwn(state.outcomes, dateKey)) {
      delete state.outcomes[dateKey];
      changed = true;
    }
  }
  for (const [key, fallback] of [['outcomeRevision', 0], ['nextSequence', 1]]) {
    if (!Number.isInteger(state[key])) {
      state[key] = fallback;
      changed = true;
    }
  }
  for (const key of ['outcomeChanges', 'audit']) {
    if (!Array.isArray(state[key])) {
      state[key] = [];
      changed = true;
    }
  }
  const existingMaximumSequence = state.outcomeChanges.reduce((maximum, event) => (
    Number.isInteger(event?.sequence) ? Math.max(maximum, event.sequence) : maximum
  ), 0);
  if (state.nextSequence <= existingMaximumSequence) {
    state.nextSequence = existingMaximumSequence + 1;
    changed = true;
  }
  for (const [dateKey, played] of Object.entries(SEED_OUTCOMES)) {
    if (Object.hasOwn(state.deletedOutcomes, dateKey)) continue;
    const existing = state.outcomes[dateKey];
    if (!Object.hasOwn(state.outcomes, dateKey)) {
      state.outcomes[dateKey] = makeSeedRecord(played);
      changed = true;
    } else if (existing?.played !== played) {
      const changedAt = new Date().toISOString();
      const sequence = state.nextSequence;
      state.nextSequence += 1;
      state.outcomeRevision += 1;
      state.outcomes[dateKey] = {
        ...makeSeedRecord(played),
        revision: Number.isInteger(existing?.revision) ? existing.revision + 1 : 1
      };
      state.outcomeChanges.push({
        sequence,
        leagueDay: dateKey,
        previousPlayed: typeof existing?.played === 'boolean' ? existing.played : null,
        played,
        changedAt,
        source: 'authoritative-seed-correction'
      });
      changed = true;
    }
  }
  if (state.seedVersion !== SEED_VERSION) {
    state.seedVersion = SEED_VERSION;
    changed = true;
  }
  if (state.schemaVersion !== SCHEMA_VERSION) {
    state.schemaVersion = SCHEMA_VERSION;
    changed = true;
  }
  if (!isPlainRecord(state.defaultYesPolicy)
    || state.defaultYesPolicy.version !== DEFAULT_YES_POLICY_VERSION
    || (state.defaultYesPolicy.backfillThrough !== null && !isDateKey(state.defaultYesPolicy.backfillThrough))) {
    state.defaultYesPolicy = {
      version: DEFAULT_YES_POLICY_VERSION,
      backfillThrough: null
    };
    changed = true;
  }
  if (!state.forecasts || typeof state.forecasts !== 'object') {
    state.forecasts = { official: {}, provisional: {}, outlook: null };
    changed = true;
  }
  for (const key of ['official', 'provisional']) {
    if (!state.forecasts[key] || typeof state.forecasts[key] !== 'object') {
      state.forecasts[key] = {};
      changed = true;
    }
  }
  if (!Object.hasOwn(state.forecasts, 'outlook')) {
    state.forecasts.outlook = null;
    changed = true;
  }
  if (!state.metrics || typeof state.metrics !== 'object') {
    state.metrics = { scores: [], calibrationHistory: [] };
    changed = true;
  }
  for (const key of ['scores', 'calibrationHistory']) {
    if (!Array.isArray(state.metrics[key])) {
      state.metrics[key] = [];
      changed = true;
    }
  }
  return { state, changed };
}

function snapshotForecast(forecast, issuedAt, kind) {
  return {
    targetDay: forecast.targetDay,
    issuedAt,
    kind,
    probability: forecast.probability,
    percent: forecast.percent,
    rawProbability: forecast.rawProbability,
    unroundedProbability: forecast.unroundedProbability,
    candidates: forecast.candidates,
    weights: forecast.weights,
    shadowAdaptiveProbability: forecast.shadowAdaptiveProbability,
    shadowWeights: forecast.shadowWeights,
    stage: forecast.stage,
    model: forecast.model,
    scoreCount: forecast.scoreCount,
    calibration: forecast.calibration
  };
}

function ensureOfficialForecast(state, activeDay, issuedAt) {
  if (typeof state.outcomes[activeDay]?.played === 'boolean') return false;
  if (state.forecasts.official[activeDay]) return false;
  const forecast = computeForecast(state, activeDay);
  state.forecasts.official[activeDay] = snapshotForecast(forecast, issuedAt, 'official');
  state.metrics.calibrationHistory.push({
    targetDay: activeDay,
    issuedAt,
    attempted: Boolean(forecast.calibration.attempted),
    retained: Boolean(forecast.calibration.retained),
    rawBrier: forecast.calibration.rawBrier ?? null,
    calibratedBrier: forecast.calibration.calibratedBrier ?? null,
    rawLogLoss: forecast.calibration.rawLogLoss ?? null,
    calibratedLogLoss: forecast.calibration.calibratedLogLoss ?? null
  });
  return true;
}

function finalizeClosedScores(state, activeDay, scoredAt) {
  let changed = false;
  const scoredDays = new Set(state.metrics.scores.map((score) => score.targetDay));
  for (const [targetDay, forecast] of Object.entries(state.forecasts.official).sort(([a], [b]) => a.localeCompare(b))) {
    if (targetDay >= activeDay || scoredDays.has(targetDay)) continue;
    const outcome = state.outcomes[targetDay];
    if (!outcome || typeof outcome.played !== 'boolean') continue;
    if (outcome.source === 'historical-default-yes') continue;
    const played = outcome.played;
    state.metrics.scores.push({
      targetDay,
      scoredAt,
      played,
      probability: forecast.probability,
      rawProbability: forecast.rawProbability ?? forecast.probability,
      candidates: forecast.candidates,
      weights: forecast.weights,
      shadowAdaptiveProbability: forecast.shadowAdaptiveProbability ?? forecast.rawProbability ?? forecast.probability,
      shadowWeights: forecast.shadowWeights || forecast.weights,
      brier: brier(forecast.probability, played),
      logLoss: logLoss(forecast.probability, played)
    });
    scoredDays.add(targetDay);
    changed = true;
  }
  state.metrics.scores.sort((a, b) => a.targetDay.localeCompare(b.targetDay));
  return changed;
}

function finalizeMissingClosedDays(state, activeDay, finalizedAt) {
  const lastClosedDay = addDays(activeDay, -1);
  if (lastClosedDay < DEFAULT_YES_START_DAY) return false;

  const priorBackfillThrough = state.defaultYesPolicy.backfillThrough;
  let cursor = DEFAULT_YES_START_DAY;
  let changed = false;

  while (cursor <= lastClosedDay) {
    if (!Object.hasOwn(state.deletedOutcomes, cursor)
      && typeof state.outcomes[cursor]?.played !== 'boolean') {
      const source = priorBackfillThrough === null || cursor <= priorBackfillThrough
        ? 'historical-default-yes'
        : 'automatic-default-yes';
      const sequence = state.nextSequence;
      state.nextSequence += 1;
      state.outcomeRevision += 1;
      state.outcomes[cursor] = {
        played: true,
        source,
        recordedAt: null,
        finalizedAt,
        revision: 1
      };
      state.outcomeChanges.push({
        sequence,
        leagueDay: cursor,
        previousPlayed: null,
        played: true,
        changedAt: finalizedAt,
        source
      });
      changed = true;
    }
    cursor = nextDayKey(cursor);
  }

  if (state.defaultYesPolicy.backfillThrough === null || state.defaultYesPolicy.backfillThrough < lastClosedDay) {
    state.defaultYesPolicy.backfillThrough = lastClosedDay;
    changed = true;
  }
  return changed;
}

function ensureOutlook(state, activeDay, issuedAt, force = false) {
  const current = state.forecasts.outlook;
  if (!force
    && current
    && current.baseDay === activeDay
    && current.basisRevision === state.outcomeRevision
    && current.method === OUTLOOK_METHOD
    && current.particleCap === OUTLOOK_PARTICLE_CAP
    && Array.isArray(current.points)
    && current.points.length === OUTLOOK_HORIZON) {
    return false;
  }

  const outlook = buildRecursiveOutlook(state, activeDay, OUTLOOK_HORIZON);
  state.forecasts.outlook = {
    ...outlook,
    issuedAt,
    basisRevision: state.outcomeRevision
  };
  const tomorrow = outlook.points[0];
  state.forecasts.provisional = {
    [tomorrow.targetDay]: {
      ...tomorrow,
      issuedAt,
      kind: 'provisional',
      method: outlook.method
    }
  };
  return true;
}

function outcomeText(dateKey, played) {
  return `${displayDate(dateKey)}: yernar ${played ? 'played' : 'did not play'} league`;
}

function buildPublicState(state, activeDay) {
  const outcome = state.outcomes[activeDay] || null;
  const official = state.forecasts.official[activeDay] || null;
  const outlook = state.forecasts.outlook?.baseDay === activeDay
    ? state.forecasts.outlook
    : { baseDay: activeDay, method: 'unavailable', points: [] };
  const tomorrow = outlook.points[0] || null;
  const history = Object.entries(state.outcomes)
    .filter(([dateKey, record]) => dateKey <= activeDay && typeof record?.played === 'boolean')
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([dateKey, record]) => ({
      dateKey,
      date: displayDate(dateKey),
      played: record.played,
      revision: record.revision,
      text: outcomeText(dateKey, record.played)
    }));
  const chartWindowStart = addDays(activeDay, -30);
  const chartWindowEnd = addDays(activeDay, OUTLOOK_HORIZON);
  const past = [...history]
    .reverse()
    .filter((entry) => entry.dateKey >= chartWindowStart)
    .map((entry) => ({
      targetDay: entry.dateKey,
      probability: entry.played ? 1 : 0,
      percent: entry.played ? 100 : 0,
      played: entry.played,
      kind: 'outcome'
    }));
  const issued = Object.values(state.forecasts.official)
    .filter((forecast) => (
      forecast.targetDay >= chartWindowStart
      && forecast.targetDay <= activeDay
    ))
    .sort((a, b) => a.targetDay.localeCompare(b.targetDay))
    .map((forecast) => ({
      targetDay: forecast.targetDay,
      probability: forecast.probability,
      percent: forecast.percent,
      kind: 'official',
      issuedAt: forecast.issuedAt
    }));

  let statement;
  if (typeof outcome?.played === 'boolean') {
    statement = outcome.played
      ? `yernar plays league today. there is a ${tomorrow?.percent ?? 0}% chance that he will play league tomorrow.`
      : `yernar does not play league today. there is a ${tomorrow?.percent ?? 0}% chance that he will play league tomorrow.`;
  } else {
    statement = `there is a ${official.percent}% chance that yernar will play league today`;
  }

  return {
    activeLeagueDay: activeDay,
    todayProbability: official ? official.percent : null,
    todayOutcome: typeof outcome?.played === 'boolean' ? outcome.played : null,
    tomorrowProbability: typeof outcome?.played === 'boolean' && tomorrow ? tomorrow.percent : null,
    statement,
    question: null,
    canRecordOutcome: true,
    canRecordDidNotPlay: true,
    actionLabel: 'no league',
    yesActionLabel: 'yes league slay',
    history,
    chart: {
      activeDay,
      windowStart: chartWindowStart,
      windowEnd: chartWindowEnd,
      past,
      issued,
      outlook: outlook.points.map((point) => ({
        targetDay: point.targetDay,
        probability: point.probability,
        percent: point.percent,
        kind: 'outlook'
      }))
    },
    outlook: {
      baseDay: outlook.baseDay,
      issuedAt: outlook.issuedAt || null,
      method: outlook.method,
      points: outlook.points.map((point) => ({
        targetDay: point.targetDay,
        probability: point.probability,
        percent: point.percent
      }))
    }
  };
}

class LeagueService {
  constructor({ store, clock = () => new Date(), timeZone = TIME_ZONE }) {
    this.store = store;
    this.clock = clock;
    this.timeZone = timeZone;
  }

  async getState() {
    const now = this.clock();
    const activeDay = leagueDayKey(now, this.timeZone);
    const issuedAt = now.toISOString();
    const mutation = await this.store.update((state) => {
      let changed = finalizeMissingClosedDays(state, activeDay, issuedAt);
      changed = finalizeClosedScores(state, activeDay, issuedAt) || changed;
      changed = ensureOfficialForecast(state, activeDay, issuedAt) || changed;
      changed = ensureOutlook(state, activeDay, issuedAt) || changed;
      return { changed };
    });
    return buildPublicState(mutation.state, activeDay);
  }

  async recordTodayOutcome(played, expectedLeagueDay) {
    if (typeof played !== 'boolean') {
      const error = new TypeError('played must be a boolean.');
      error.statusCode = 400;
      throw error;
    }
    if (typeof expectedLeagueDay !== 'string') {
      const error = new TypeError('expectedLeagueDay is required.');
      error.statusCode = 400;
      throw error;
    }

    let activeDay;
    let mutation;
    try {
      mutation = await this.store.update((state) => {
      const now = this.clock();
      activeDay = leagueDayKey(now, this.timeZone);
      const changedAt = now.toISOString();
      if (expectedLeagueDay !== activeDay) {
        const error = new Error('The League day changed before this answer was saved.');
        error.statusCode = 409;
        error.code = 'LEAGUE_DAY_CHANGED';
        throw error;
      }
      let changed = finalizeMissingClosedDays(state, activeDay, changedAt);
      changed = finalizeClosedScores(state, activeDay, changedAt) || changed;
      changed = ensureOfficialForecast(state, activeDay, changedAt) || changed;
      const existing = state.outcomes[activeDay];
      const previousPlayed = typeof existing?.played === 'boolean' ? existing.played : null;

      if (previousPlayed !== played) {
        const sequence = state.nextSequence;
        const priorRevision = Math.max(
          Number.isInteger(existing?.revision) ? existing.revision : 0,
          Number.isInteger(state.deletedOutcomes[activeDay]?.revision)
            ? state.deletedOutcomes[activeDay].revision
            : 0
        );
        state.nextSequence += 1;
        state.outcomeRevision += 1;
        state.outcomes[activeDay] = {
          played,
          source: played ? 'explicit-yes' : 'explicit-no',
          recordedAt: changedAt,
          revision: priorRevision + 1
        };
        delete state.deletedOutcomes[activeDay];
        const event = {
          sequence,
          leagueDay: activeDay,
          previousPlayed,
          played,
          changedAt
        };
        state.outcomeChanges.push(event);
        state.audit.push({ sequence, leagueDay: activeDay, played, changedAt });
        state.audit = state.audit.slice(-AUDIT_LIMIT);
        changed = true;
      }

      changed = ensureOutlook(state, activeDay, changedAt, previousPlayed !== played) || changed;
      return { changed };
      });
    } catch (error) {
      if (error.code === 'LEAGUE_DAY_CHANGED') error.state = await this.getState();
      throw error;
    }
    return buildPublicState(mutation.state, activeDay);
  }

  async recordTodayNo(expectedLeagueDay) {
    return this.recordTodayOutcome(false, expectedLeagueDay);
  }

  async deleteOutcome(dateKey, expectedRevision, expectedLeagueDay) {
    if (!isDateKey(dateKey)) {
      const error = new TypeError('A valid League day is required.');
      error.statusCode = 400;
      throw error;
    }
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      const error = new TypeError('expectedRevision must be a positive integer.');
      error.statusCode = 400;
      throw error;
    }
    if (!isDateKey(expectedLeagueDay)) {
      const error = new TypeError('expectedLeagueDay is required.');
      error.statusCode = 400;
      throw error;
    }

    let activeDay;
    let mutation;
    try {
      mutation = await this.store.update((state) => {
        const now = this.clock();
        activeDay = leagueDayKey(now, this.timeZone);
        const changedAt = now.toISOString();
        if (expectedLeagueDay !== activeDay) {
          const error = new Error('The League day changed before this entry was deleted.');
          error.statusCode = 409;
          error.code = 'LEAGUE_DAY_CHANGED';
          throw error;
        }
        if (dateKey > activeDay) {
          const error = new Error('Future entries cannot be deleted.');
          error.statusCode = 400;
          throw error;
        }

        let changed = finalizeMissingClosedDays(state, activeDay, changedAt);
        changed = finalizeClosedScores(state, activeDay, changedAt) || changed;
        changed = ensureOfficialForecast(state, activeDay, changedAt) || changed;
        const existing = state.outcomes[dateKey];
        const deleted = state.deletedOutcomes[dateKey];

        if (!existing) {
          if (deleted?.revision === expectedRevision) {
            changed = ensureOutlook(state, activeDay, changedAt) || changed;
            return { changed };
          }
          const error = new Error('This history entry no longer exists.');
          error.statusCode = 409;
          error.code = 'OUTCOME_CHANGED';
          throw error;
        }
        if (existing.revision !== expectedRevision) {
          const error = new Error('This history entry changed before it was deleted.');
          error.statusCode = 409;
          error.code = 'OUTCOME_CHANGED';
          throw error;
        }

        const sequence = state.nextSequence;
        state.nextSequence += 1;
        state.outcomeRevision += 1;
        delete state.outcomes[dateKey];
        state.deletedOutcomes[dateKey] = {
          deletedAt: changedAt,
          previousPlayed: existing.played,
          revision: existing.revision,
          sequence
        };
        state.outcomeChanges.push({
          sequence,
          leagueDay: dateKey,
          previousPlayed: existing.played,
          played: null,
          changedAt,
          source: 'explicit-delete'
        });
        state.audit.push({ sequence, leagueDay: dateKey, played: null, action: 'delete', changedAt });
        state.audit = state.audit.slice(-AUDIT_LIMIT);
        state.metrics.scores = state.metrics.scores.filter((score) => score.targetDay !== dateKey);
        ensureOfficialForecast(state, activeDay, changedAt);
        ensureOutlook(state, activeDay, changedAt, true);
        return { changed: true };
      });
    } catch (error) {
      if (error.code === 'LEAGUE_DAY_CHANGED' || error.code === 'OUTCOME_CHANGED') {
        error.state = await this.getState();
      }
      throw error;
    }
    return buildPublicState(mutation.state, activeDay);
  }
}

module.exports = {
  AUDIT_LIMIT,
  DEFAULT_YES_POLICY_VERSION,
  DEFAULT_YES_START_DAY,
  LeagueService,
  OUTLOOK_HORIZON,
  OUTLOOK_METHOD,
  OUTLOOK_PARTICLE_CAP,
  SCHEMA_VERSION,
  SEED_OUTCOMES,
  SEED_VERSION,
  buildPublicState,
  createDefaultState,
  ensureOfficialForecast,
  ensureOutlook,
  finalizeClosedScores,
  finalizeMissingClosedDays,
  migrateState,
  outcomeText,
  snapshotForecast,
  validateState
};
