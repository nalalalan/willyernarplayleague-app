'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { addDays } = require('../lib/time');
const { chartGeometry } = require('../lib/view');

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
    assert.ok(Math.min(...spacings) >= (layoutName === 'mobile' ? 26 : 40));
    assert.ok(geometry.issued.at(-1).x < geometry.outlook[0].x);
  }
});
