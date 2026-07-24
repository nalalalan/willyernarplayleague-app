'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { addDays } = require('../lib/time');
const { chartGeometry, renderChart, renderPrediction } = require('../lib/view');

function point(targetDay, percent, kind) {
  return { targetDay, percent, probability: percent / 100, kind };
}

test('chart uses one continuous 61-day calendar domain without inventing missing past points', () => {
  const activeDay = '2026-06-30';
  const windowStart = addDays(activeDay, -30);
  const windowEnd = addDays(activeDay, 30);
  const issued = Array.from({ length: 31 }, (_, index) => (
    point(addDays(windowStart, index), 55 + (index % 6), 'official')
  )).filter((item) => item.targetDay !== addDays(activeDay, -17));
  const outlook = Array.from({ length: 30 }, (_, index) => (
    point(addDays(activeDay, index + 1), 70 + (index % 5), 'outlook')
  ));
  const chart = { activeDay, windowStart, windowEnd, issued, outlook };

  for (const layoutName of ['desktop', 'mobile']) {
    const geometry = chartGeometry(chart, layoutName);
    const dailyStep = (geometry.layout.right - geometry.layout.left) / 60;
    assert.equal(geometry.past.length, 30);
    assert.equal(geometry.future.length, 30);
    assert.equal(geometry.windowStart, windowStart);
    assert.equal(geometry.windowEnd, windowEnd);
    assert.equal(geometry.past[0].x, geometry.layout.left);
    assert.ok(Math.abs(geometry.past.at(-1).x - (geometry.layout.left + 30 * dailyStep)) < 1e-9);
    assert.ok(Math.abs(geometry.future[0].x - (geometry.layout.left + 31 * dailyStep)) < 1e-9);
    assert.equal(geometry.future.at(-1).x, geometry.layout.right);
    assert.deepEqual(geometry.ticks.map((tick) => tick.targetDay), [
      windowStart,
      addDays(windowStart, 10),
      addDays(windowStart, 20),
      activeDay,
      addDays(activeDay, 10),
      addDays(activeDay, 20),
      windowEnd
    ]);
    assert.equal(geometry.ticks.filter((tick) => tick.active).length, 1);
  }

  const html = renderChart(chart);
  assert.equal((html.match(/chart-point chart-point-past/g) || []).length, 60);
  assert.equal((html.match(/chart-point chart-point-future/g) || []).length, 60);
  assert.equal((html.match(/chart-line chart-line-past/g) || []).length, 4);
  assert.equal((html.match(/chart-line chart-line-future/g) || []).length, 2);
  assert.equal((html.match(/class="chart-date/g) || []).length, 14);
  assert.equal((html.match(/>probability<\/text>/g) || []).length, 2);
  assert.doesNotMatch(html, />probability over time</);
  assert.ok(html.indexOf('>past</span>') < html.indexOf('>future</span>'));
  assert.match(html, /7\/1\/26: 70% future/);
  assert.match(html, /7\/30\/26: 74% future/);
});

test('prediction renders only the single did-not-play exception action while today is open', () => {
  const html = renderPrediction({
    statement: 'there is a 75% chance that yernar will play league today',
    canRecordDidNotPlay: true,
    actionLabel: "yernar didn't play league"
  });
  assert.match(html, /data-played="false">yernar didn&#39;t play league<\/button>/);
  assert.doesNotMatch(html, /data-played="true"/);
  assert.doesNotMatch(html, /change answer|>yes<|>no</);
});

test('prediction renders no correction control after the No exception is recorded', () => {
  const html = renderPrediction({
    statement: 'yernar does not play league today. there is a 72% chance that he will play league tomorrow.',
    canRecordDidNotPlay: false,
    actionLabel: null
  });
  assert.doesNotMatch(html, /data-played|change answer/);
});
