'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { addDays } = require('../lib/time');
const { chartGeometry, renderChart, renderPrediction } = require('../lib/view');
const chartModule = require('../public/chart');

function point(targetDay, percent, kind) {
  return { targetDay, percent, probability: percent / 100, kind };
}

function result(targetDay, played) {
  return { targetDay, played, percent: played ? 100 : 0, probability: played ? 1 : 0, kind: 'outcome' };
}

test('chart uses one continuous 61-day calendar domain without inventing missing past points', () => {
  const activeDay = '2026-06-30';
  const windowStart = addDays(activeDay, -30);
  const windowEnd = addDays(activeDay, 30);
  const past = Array.from({ length: 31 }, (_, index) => (
    result(addDays(windowStart, index), index % 6 !== 0)
  )).filter((item) => item.targetDay !== addDays(activeDay, -17));
  const outlook = Array.from({ length: 30 }, (_, index) => (
    point(addDays(activeDay, index + 1), 70 + (index % 5), 'outlook')
  ));
  const chart = { activeDay, windowStart, windowEnd, past, outlook };

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
  assert.match(html, /6\/30\/26: yernar did not play league/);
  assert.match(html, /Past results: 5\/31\/26 did not play/);
  assert.match(html, /7\/1\/26: 70% future/);
  assert.match(html, /7\/30\/26: 74% future/);
});

test('server and browser use one chart renderer and one editorial layout contract', () => {
  const activeDay = '2026-07-24';
  const chart = {
    activeDay,
    windowStart: addDays(activeDay, -30),
    windowEnd: addDays(activeDay, 30),
    past: [result('2026-07-22', false), result('2026-07-23', false)],
    outlook: [point('2026-07-25', 85, 'outlook'), point('2026-07-26', 84, 'outlook')]
  };
  const chartSourcePath = path.join(__dirname, '..', 'public', 'chart.js');
  const appSourcePath = path.join(__dirname, '..', 'public', 'app.js');
  const cssPath = path.join(__dirname, '..', 'public', 'styles.css');
  const browserContext = {};
  vm.runInNewContext(fs.readFileSync(chartSourcePath, 'utf8'), browserContext);

  assert.strictEqual(renderChart, chartModule.renderChart);
  assert.equal(browserContext.YernarLeagueChart.renderChart(chart), renderChart(chart));
  assert.deepEqual(chartModule.CHART_CONFIG.layouts.desktop, {
    width: 680,
    height: 230,
    left: 56,
    right: 612,
    top: 14,
    middle: 98,
    bottom: 182,
    axisX: 47,
    labelY: 214,
    yLabelX: 14,
    yLabelY: 98,
    pointRadius: 2.5
  });

  const appSource = fs.readFileSync(appSourcePath, 'utf8');
  assert.match(appSource, /chartRenderer\.renderChart\(state\.chart\)/);
  assert.doesNotMatch(appSource, /chartLayouts|chartGeometry|createChartSvg|svgElement/);

  const css = fs.readFileSync(cssPath, 'utf8');
  assert.match(css, /width: min\(1360px, calc\(100% - 48px\)\)/);
  assert.match(css, /gap: clamp\(20px, 2vw, 24px\)/);
  assert.match(css, /font-size: clamp\(38px, 3vw, 46px\)/);
  assert.match(css, /line-height: 1\.06/);
  assert.match(css, /text-wrap: pretty/);
  assert.match(css, /@media \(max-width: 999px\)/);
  assert.doesNotMatch(css, /max-width: 660px/);
  assert.doesNotMatch(css.match(/\.forecast-layout \{([\s\S]*?)\n\}/)[1], /border-bottom/);
  assert.match(css, /\.chart-legend \{[\s\S]*position: absolute/);
  assert.match(css, /stroke-width: var\(--chart-line-width\)/);
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
