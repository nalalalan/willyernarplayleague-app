(function chartModule(root, factory) {
  'use strict';

  const chart = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = chart;
  } else {
    root.YernarLeagueChart = chart;
  }
}(typeof globalThis === 'undefined' ? this : globalThis, () => {
  'use strict';

  const freeze = (value) => Object.freeze(value);
  const CHART_CONFIG = freeze({
    tickEveryDays: freeze({ desktop: 10, mobile: 15 }),
    layouts: freeze({
      desktop: freeze({
        width: 680,
        height: 246,
        left: 60,
        right: 646,
        top: 18,
        middle: 100,
        bottom: 182,
        axisX: 50,
        labelY: 228,
        yLabelX: 17,
        yLabelY: 100,
        pointRadius: 3.2
      }),
      mobile: freeze({
        width: 360,
        height: 246,
        left: 54,
        right: 346,
        top: 46,
        middle: 118,
        bottom: 190,
        axisX: 45,
        labelY: 228,
        yLabelX: 16,
        yLabelY: 118,
        pointRadius: 2.2
      })
    }),
    palette: freeze({
      past: '#5c4862',
      future: '#704b19',
      muted: '#493f39',
      grid: 'rgba(64, 54, 48, .10)',
      boundary: 'rgba(64, 54, 48, .24)'
    }),
    series: freeze({
      lineWidth: 3.25,
      pastPointWidth: 1.9,
      futurePointWidth: 1.9,
      futureDash: '9 8'
    })
  });

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function displayDate(dateKey) {
    const [year, month, day] = dateKey.split('-').map(Number);
    return `${month}/${day}/${String(year).slice(-2)}`;
  }

  function shortDate(dateKey) {
    const [, month, day] = dateKey.split('-').map(Number);
    return `${month}/${day}`;
  }

  function dayNumber(dateKey) {
    return Date.parse(`${dateKey}T00:00:00.000Z`) / 86400000;
  }

  function addDays(dateKey, amount) {
    const date = new Date(`${dateKey}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + amount);
    return date.toISOString().slice(0, 10);
  }

  function chartGeometry(chart, layoutName = 'desktop') {
    const layout = CHART_CONFIG.layouts[layoutName] || CHART_CONFIG.layouts.desktop;
    const recorded = [...(chart.past || [])].sort((a, b) => a.targetDay.localeCompare(b.targetDay));
    const outlook = [...(chart.outlook || [])].sort((a, b) => a.targetDay.localeCompare(b.targetDay));
    const activeDay = chart.activeDay
      || recorded.at(-1)?.targetDay
      || (outlook[0] ? addDays(outlook[0].targetDay, -1) : null);
    const windowStart = chart.windowStart || (activeDay ? addDays(activeDay, -30) : null);
    const windowEnd = chart.windowEnd || (activeDay ? addDays(activeDay, 30) : null);
    if (!activeDay || !windowStart || !windowEnd) {
      return { past: [], future: [], issued: [], outlook: [], ticks: [], layout, activeDay, windowStart, windowEnd };
    }

    const span = Math.max(1, dayNumber(windowEnd) - dayNumber(windowStart));
    const pointY = (item) => layout.top + (1 - item.probability) * (layout.bottom - layout.top);
    const pointX = (targetDay) => (
      layout.left + ((dayNumber(targetDay) - dayNumber(windowStart)) / span) * (layout.right - layout.left)
    );
    const placeSeries = (items) => items.map((item) => ({
      ...item,
      x: pointX(item.targetDay),
      y: pointY(item)
    }));
    const past = placeSeries(recorded.filter((item) => (
      item.targetDay >= windowStart && item.targetDay <= activeDay
    )));
    const future = placeSeries(outlook.filter((item) => (
      item.targetDay > activeDay && item.targetDay <= windowEnd
    )));
    const ticks = [];
    const tickEveryDays = CHART_CONFIG.tickEveryDays[layoutName] || CHART_CONFIG.tickEveryDays.desktop;
    for (let offset = 0; offset <= span; offset += tickEveryDays) {
      const targetDay = addDays(windowStart, offset);
      ticks.push({ targetDay, x: pointX(targetDay), active: targetDay === activeDay });
    }
    if (ticks.at(-1)?.targetDay !== windowEnd) {
      ticks.push({ targetDay: windowEnd, x: pointX(windowEnd), active: windowEnd === activeDay });
    }
    return {
      past,
      future,
      issued: past,
      outlook: future,
      ticks,
      layout,
      activeDay,
      windowStart,
      windowEnd,
      activeX: pointX(activeDay)
    };
  }

  function pointString(points) {
    return points.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ');
  }

  function stepPath(points) {
    if (!points.length) return '';
    const commands = [`M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`];
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1];
      const point = points[index];
      const midpoint = ((previous.x + point.x) / 2).toFixed(2);
      commands.push(`H ${midpoint} V ${point.y.toFixed(2)} H ${point.x.toFixed(2)}`);
    }
    return commands.join(' ');
  }

  function continuousSegments(points) {
    const segments = [];
    for (const point of points) {
      const current = segments.at(-1);
      if (!current || dayNumber(point.targetDay) - dayNumber(current.at(-1).targetDay) !== 1) {
        segments.push([point]);
      } else {
        current.push(point);
      }
    }
    return segments;
  }

  function renderChartSvg(chart, layoutName) {
    const geometry = chartGeometry(chart, layoutName);
    const { layout } = geometry;
    const suffix = layoutName === 'desktop' ? '' : '-mobile';
    const pastDescription = geometry.past.length
      ? `Past results: ${geometry.past.map((point) => `${displayDate(point.targetDay)} ${point.played ? 'played' : 'did not play'}`).join(', ')}.`
      : 'Past results: no recorded days.';
    const futureDescription = geometry.future.length
      ? `Future: ${geometry.future.map((point) => `${displayDate(point.targetDay)} ${point.percent}%`).join(', ')}.`
      : 'Future: no forecast.';
    const description = `${pastDescription} ${futureDescription}`;
    const renderLines = (points, kind) => continuousSegments(points)
      .filter((segment) => segment.length > 1)
      .map((segment) => kind === 'past'
        ? `<path class="chart-line chart-line-past chart-step" d="${stepPath(segment)}"/>`
        : `<polyline class="chart-line chart-line-future" points="${pointString(segment)}"/>`)
      .join('');
    const visibleMarkers = (points, kind) => {
      if (kind === 'past') {
        const isolatedDays = new Set(
          continuousSegments(points)
            .filter((segment) => segment.length === 1)
            .map((segment) => segment[0].targetDay)
        );
        return points.filter((point) => point.played === false || isolatedDays.has(point.targetDay));
      }
      return points.filter((point, index) => (
        index === 0
        || index === points.length - 1
        || (point.probability < points[index - 1].probability
          && point.probability < points[index + 1].probability)
      ));
    };
    const renderPoints = (points, kind) => points.map((point) => {
      const label = kind === 'past'
        ? `${displayDate(point.targetDay)}: yernar ${point.played ? 'played' : 'did not play'} league`
        : `${displayDate(point.targetDay)}: ${point.percent}% future`;
      return `<circle class="chart-point chart-point-${kind}" cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="${layout.pointRadius}"><title>${escapeHtml(label)}</title></circle>`;
    }).join('');
    const ticks = geometry.ticks.map((tick) => (
      `<line class="chart-x-tick" x1="${tick.x.toFixed(2)}" y1="${layout.bottom}" x2="${tick.x.toFixed(2)}" y2="${layout.bottom + 5}"/><text class="chart-date${tick.active ? ' chart-date-active' : ''}" x="${tick.x.toFixed(2)}" y="${layout.labelY}" text-anchor="middle">${shortDate(tick.targetDay)}</text>`
    )).join('');

    return `<svg class="chart-svg chart-svg-${layoutName}" viewBox="0 0 ${layout.width} ${layout.height}" role="img" aria-labelledby="chart-title${suffix} chart-description${suffix}" data-chart="${layoutName}">
      <title id="chart-title${suffix}">yernar league probability, past and future</title>
      <desc id="chart-description${suffix}">${escapeHtml(description)}</desc>
      <line class="chart-grid" x1="${layout.left}" y1="${layout.top}" x2="${layout.right}" y2="${layout.top}"/>
      <line class="chart-grid" x1="${layout.left}" y1="${layout.middle}" x2="${layout.right}" y2="${layout.middle}"/>
      <line class="chart-grid" x1="${layout.left}" y1="${layout.bottom}" x2="${layout.right}" y2="${layout.bottom}"/>
      <line class="chart-active-boundary" x1="${geometry.activeX.toFixed(2)}" y1="${layout.top}" x2="${geometry.activeX.toFixed(2)}" y2="${layout.bottom}"/>
      <text class="chart-y-label" x="${layout.yLabelX}" y="${layout.yLabelY}" text-anchor="middle" transform="rotate(-90 ${layout.yLabelX} ${layout.yLabelY})">probability</text>
      <text class="chart-axis-label" x="${layout.axisX}" y="${layout.top + 4}" text-anchor="end">100%</text>
      <text class="chart-axis-label" x="${layout.axisX}" y="${layout.middle + 4}" text-anchor="end">50%</text>
      <text class="chart-axis-label" x="${layout.axisX}" y="${layout.bottom + 4}" text-anchor="end">0%</text>
      ${ticks}
      ${renderLines(geometry.past, 'past')}
      ${renderLines(geometry.future, 'future')}
      ${renderPoints(visibleMarkers(geometry.past, 'past'), 'past')}
      ${renderPoints(visibleMarkers(geometry.future, 'future'), 'future')}
    </svg>`;
  }

  function renderChart(chart) {
    return `<section class="probability-chart" aria-labelledby="chart-heading">
    <h2 id="chart-heading" class="sr-only">league probability chart</h2>
    <div class="chart-legend" aria-label="chart legend">
      <span><i class="legend-line legend-past" aria-hidden="true"></i>past</span>
      <span><i class="legend-line legend-future" aria-hidden="true"></i>future</span>
    </div>
    ${renderChartSvg(chart, 'desktop')}
    ${renderChartSvg(chart, 'mobile')}
  </section>`;
  }

  function renderChartCss() {
    const { palette, series } = CHART_CONFIG;
    return `:root {
  --chart-past: ${palette.past};
  --chart-future: ${palette.future};
  --chart-muted: ${palette.muted};
  --chart-grid: ${palette.grid};
  --chart-boundary: ${palette.boundary};
  --chart-line-width: ${series.lineWidth}px;
  --chart-past-point-width: ${series.pastPointWidth}px;
  --chart-future-point-width: ${series.futurePointWidth}px;
  --chart-future-dash: ${series.futureDash};
}\n`;
  }

  return freeze({
    CHART_CONFIG,
    chartGeometry,
    renderChart,
    renderChartCss,
    renderChartSvg
  });
}));
