'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  addDays,
  displayDate,
  leagueDayKey,
  nextDayKey
} = require('../lib/time');

test('League day changes at exactly 6:00 AM Eastern', () => {
  assert.equal(leagueDayKey(new Date('2026-07-24T09:59:59.999Z')), '2026-07-23');
  assert.equal(leagueDayKey(new Date('2026-07-24T10:00:00.000Z')), '2026-07-24');
});

test('DST start preserves the 6:00 AM Eastern boundary', () => {
  assert.equal(leagueDayKey(new Date('2026-03-08T09:59:59.999Z')), '2026-03-07');
  assert.equal(leagueDayKey(new Date('2026-03-08T10:00:00.000Z')), '2026-03-08');
});

test('DST end preserves the 6:00 AM Eastern boundary', () => {
  assert.equal(leagueDayKey(new Date('2026-11-01T10:59:59.999Z')), '2026-10-31');
  assert.equal(leagueDayKey(new Date('2026-11-01T11:00:00.000Z')), '2026-11-01');
});

test('calendar helpers cross month and year boundaries', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(nextDayKey('2026-02-28'), '2026-03-01');
  assert.equal(displayDate('2026-07-04'), '7/4/26');
});
