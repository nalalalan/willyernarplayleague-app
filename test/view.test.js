'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { addDays } = require('../lib/time');
const { chartGeometry, renderPrediction } = require('../lib/view');

function point(targetDay, percent, kind) {
  return { targetDay, percent, probability: percent / 100, kind };
}

test('responsive chart windows issued history and reserves readable space for every outlook day', () => {
  const start = '2026-05-01';
  const issued = Array.from({ length: 60 }, (_, index) => (
    point(addDays(start, index), 20 + (index % 6) * 5, 'official')
  ));
  const outlookStart = addDays(start, 60);
  const outlook = Array.from({ length: 7 }, (_, index) => (
    point(addDays(outlookStart, index), [25, 30, 29, 26, 27, 27, 27][index], 'outlook')
  ));

  for (const layoutName of ['desktop', 'mobile']) {
    const geometry = chartGeometry({ issued, outlook }, layoutName);
    assert.equal(geometry.issued.length, 28);
    assert.equal(geometry.issued[0].targetDay, issued[32].targetDay);
    assert.equal(geometry.outlook.length, 7);
    const spacings = geometry.outlook.slice(1).map((item, index) => (
      item.x - geometry.outlook[index].x
    ));
    assert.ok(Math.min(...spacings) >= (layoutName === 'mobile' ? 36 : 40));
    assert.ok(geometry.issued.at(-1).x < geometry.outlook[0].x);
    if (layoutName === 'mobile') {
      assert.ok(geometry.outlook[0].x >= 120);
      assert.ok(geometry.layout.width - geometry.outlook.at(-1).x >= 16);
    }
  }
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
