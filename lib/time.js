'use strict';

const DEFAULT_TIME_ZONE = 'America/New_York';

const formatterCache = new Map();

function formatterFor(timeZone) {
  if (!formatterCache.has(timeZone)) {
    formatterCache.set(timeZone, new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    }));
  }
  return formatterCache.get(timeZone);
}

function zonedParts(value, timeZone = DEFAULT_TIME_ZONE) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError('A valid date is required.');
  }

  const parts = {};
  for (const part of formatterFor(timeZone).formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return parts;
}

function dateKeyFromParts(year, month, day) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function addDays(dateKey, amount) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + amount));
  return date.toISOString().slice(0, 10);
}

function leagueDayKey(value = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const parts = zonedParts(value, timeZone);
  const localDate = dateKeyFromParts(parts.year, parts.month, parts.day);
  return parts.hour < 6 ? addDays(localDate, -1) : localDate;
}

function nextDayKey(dateKey) {
  return addDays(dateKey, 1);
}

function daysBetween(earlierKey, laterKey) {
  const earlier = Date.parse(`${earlierKey}T00:00:00.000Z`);
  const later = Date.parse(`${laterKey}T00:00:00.000Z`);
  return Math.round((later - earlier) / 86_400_000);
}

function dayOfWeek(dateKey) {
  return new Date(`${dateKey}T12:00:00.000Z`).getUTCDay();
}

function isWeekend(dateKey) {
  const weekday = dayOfWeek(dateKey);
  return weekday === 0 || weekday === 6;
}

function displayDate(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return `${month}/${day}/${String(year).slice(-2)}`;
}

module.exports = {
  DEFAULT_TIME_ZONE,
  addDays,
  dateKeyFromParts,
  dayOfWeek,
  daysBetween,
  displayDate,
  isWeekend,
  leagueDayKey,
  nextDayKey,
  zonedParts
};
