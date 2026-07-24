(() => {
  'use strict';

  const initial = document.getElementById('initial-state');
  let state = JSON.parse(initial.textContent);
  let saving = false;

  const chartRoot = document.querySelector('[data-chart-root]');
  const predictionRoot = document.querySelector('[data-prediction-root]');
  const historyRoot = document.querySelector('[data-history-root]');
  const svgNamespace = 'http://www.w3.org/2000/svg';
  const chartLayouts = {
    desktop: {
      width: 640, height: 262, left: 62, right: 626, top: 20, middle: 116,
      bottom: 212, axisX: 53, labelY: 240, yLabelX: 16, yLabelY: 116, pointRadius: 2.4
    },
    mobile: {
      width: 360, height: 210, left: 52, right: 348, top: 16, middle: 82,
      bottom: 148, axisX: 44, labelY: 182, yLabelX: 14, yLabelY: 82, pointRadius: 1.8
    }
  };

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

  function svgElement(name, attributes = {}) {
    const element = document.createElementNS(svgNamespace, name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
    return element;
  }

  function chartGeometry(layoutName) {
    const layout = chartLayouts[layoutName];
    const recorded = [...(state.chart.past || [])]
      .sort((a, b) => a.targetDay.localeCompare(b.targetDay));
    const outlook = [...(state.chart.outlook || [])]
      .sort((a, b) => a.targetDay.localeCompare(b.targetDay));
    const activeDay = state.chart.activeDay
      || recorded.at(-1)?.targetDay
      || (outlook[0] ? addDays(outlook[0].targetDay, -1) : null);
    const windowStart = state.chart.windowStart || (activeDay ? addDays(activeDay, -30) : null);
    const windowEnd = state.chart.windowEnd || (activeDay ? addDays(activeDay, 30) : null);
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
    for (let offset = 0; offset <= span; offset += 10) {
      const targetDay = addDays(windowStart, offset);
      ticks.push({ targetDay, x: pointX(targetDay), active: targetDay === activeDay });
    }
    if (ticks.at(-1)?.targetDay !== windowEnd) {
      ticks.push({ targetDay: windowEnd, x: pointX(windowEnd), active: windowEnd === activeDay });
    }
    return {
      layout,
      past,
      future,
      issued: past,
      outlook: future,
      ticks,
      activeDay,
      windowStart,
      windowEnd,
      activeX: pointX(activeDay)
    };
  }

  function createChartSvg(layoutName) {
    const geometry = chartGeometry(layoutName);
    const { past, future, layout } = geometry;
    const suffix = layoutName === 'desktop' ? '' : '-mobile';
    const svg = svgElement('svg', {
      class: `chart-svg chart-svg-${layoutName}`,
      viewBox: `0 0 ${layout.width} ${layout.height}`,
      role: 'img',
      'aria-labelledby': `chart-title${suffix} chart-description${suffix}`,
      'data-chart': layoutName
    });
    const title = svgElement('title', { id: `chart-title${suffix}` });
    title.textContent = 'yernar league probability, past and future';
    const description = svgElement('desc', { id: `chart-description${suffix}` });
    const pastDescription = past.length
      ? `Past results: ${past.map((point) => `${displayDate(point.targetDay)} ${point.played ? 'played' : 'did not play'}`).join(', ')}.`
      : 'Past results: no recorded days.';
    const futureDescription = future.length
      ? `Future: ${future.map((point) => `${displayDate(point.targetDay)} ${point.percent}%`).join(', ')}.`
      : 'Future: no forecast.';
    description.textContent = `${pastDescription} ${futureDescription}`;
    svg.append(title, description);

    for (const [y, label] of [[layout.top, '100%'], [layout.middle, '50%'], [layout.bottom, '0%']]) {
      svg.append(svgElement('line', { class: 'chart-grid', x1: layout.left, y1: y, x2: layout.right, y2: y }));
      const text = svgElement('text', { class: 'chart-axis-label', x: layout.axisX, y: y + 4, 'text-anchor': 'end' });
      text.textContent = label;
      svg.append(text);
    }

    svg.append(svgElement('line', {
      class: 'chart-active-boundary',
      x1: geometry.activeX.toFixed(2),
      y1: layout.top,
      x2: geometry.activeX.toFixed(2),
      y2: layout.bottom
    }));
    const yLabel = svgElement('text', {
      class: 'chart-y-label',
      x: layout.yLabelX,
      y: layout.yLabelY,
      'text-anchor': 'middle',
      transform: `rotate(-90 ${layout.yLabelX} ${layout.yLabelY})`
    });
    yLabel.textContent = 'probability';
    svg.append(yLabel);

    for (const tick of geometry.ticks) {
      svg.append(svgElement('line', {
        class: 'chart-x-tick',
        x1: tick.x.toFixed(2),
        y1: layout.bottom,
        x2: tick.x.toFixed(2),
        y2: layout.bottom + 5
      }));
      const date = svgElement('text', {
        class: `chart-date${tick.active ? ' chart-date-active' : ''}`,
        x: tick.x.toFixed(2),
        y: layout.labelY,
        'text-anchor': 'middle'
      });
      date.textContent = shortDate(tick.targetDay);
      svg.append(date);
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

    function addSeries(points, kind) {
      for (const segment of continuousSegments(points)) {
        if (segment.length < 2) continue;
        svg.append(svgElement('polyline', {
          class: `chart-line chart-line-${kind}`,
          points: segment.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ')
        }));
      }
      for (const point of points) {
        const circle = svgElement('circle', {
          class: `chart-point chart-point-${kind}`,
          cx: point.x.toFixed(2),
          cy: point.y.toFixed(2),
          r: layout.pointRadius
        });
        const pointTitle = svgElement('title');
        pointTitle.textContent = kind === 'past'
          ? `${displayDate(point.targetDay)}: yernar ${point.played ? 'played' : 'did not play'} league`
          : `${displayDate(point.targetDay)}: ${point.percent}% future`;
        circle.append(pointTitle);
        svg.append(circle);
      }
    }

    addSeries(past, 'past');
    addSeries(future, 'future');
    return svg;
  }

  function renderChart() {
    chartRoot.replaceChildren();
    const section = document.createElement('section');
    section.className = 'probability-chart';
    section.setAttribute('aria-labelledby', 'chart-heading');
    const heading = document.createElement('h2');
    heading.id = 'chart-heading';
    heading.className = 'sr-only';
    heading.textContent = 'league probability chart';
    const legend = document.createElement('div');
    legend.className = 'chart-legend';
    legend.setAttribute('aria-label', 'chart legend');
    for (const [label, lineClass] of [['past', 'legend-past'], ['future', 'legend-future']]) {
      const item = document.createElement('span');
      const line = document.createElement('i');
      line.className = `legend-line ${lineClass}`;
      line.setAttribute('aria-hidden', 'true');
      item.append(line, document.createTextNode(label));
      legend.append(item);
    }
    section.append(heading, legend, createChartSvg('desktop'), createChartSvg('mobile'));
    chartRoot.append(section);
  }

  function exceptionControl() {
    const buttons = document.createElement('div');
    buttons.className = 'answer-buttons';
    const button = document.createElement('button');
    button.className = 'answer-button answer-exception';
    button.type = 'button';
    button.dataset.played = 'false';
    button.textContent = state.actionLabel || "yernar didn't play league";
    button.disabled = saving;
    buttons.append(button);
    return buttons;
  }

  function renderPrediction(statusText = '', isError = false) {
    predictionRoot.replaceChildren();
    const section = document.createElement('section');
    section.className = 'prediction';
    section.setAttribute('aria-live', 'polite');
    section.setAttribute('aria-atomic', 'true');
    const statement = document.createElement('p');
    statement.className = 'prediction-statement';
    statement.dataset.statement = '';
    statement.textContent = state.statement;
    const status = document.createElement('p');
    status.className = 'save-status';
    status.dataset.status = '';
    status.setAttribute('role', 'status');
    status.textContent = statusText;
    if (!isError) status.style.color = 'var(--muted)';
    section.append(statement);
    if (state.canRecordDidNotPlay) {
      const answerArea = document.createElement('div');
      answerArea.className = 'answer-area';
      answerArea.dataset.answerArea = '';
      answerArea.append(exceptionControl());
      section.append(answerArea);
    }
    section.append(status);
    predictionRoot.append(section);
  }

  function renderHistory() {
    historyRoot.replaceChildren();
    const section = document.createElement('section');
    section.className = 'history';
    section.setAttribute('aria-labelledby', 'history-heading');
    const heading = document.createElement('h2');
    heading.id = 'history-heading';
    heading.textContent = 'history';
    const list = document.createElement('ol');
    list.dataset.history = '';
    for (const entry of state.history) {
      const item = document.createElement('li');
      item.textContent = entry.text;
      list.append(item);
    }
    section.append(heading, list);
    historyRoot.append(section);
  }

  async function saveOutcome() {
    if (saving) return;
    saving = true;
    renderPrediction('saving...');
    try {
      const response = await fetch('/api/outcomes/today', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ played: false, expectedLeagueDay: state.activeLeagueDay })
      });
      const payload = await response.json();
      if (response.status === 409 && payload.state) {
        state = payload.state;
        saving = false;
        renderChart();
        renderPrediction('day changed. try again.');
        renderHistory();
        return;
      }
      if (!response.ok) throw new Error('save failed');
      state = payload;
      saving = false;
      renderChart();
      renderPrediction();
      renderHistory();
    } catch {
      saving = false;
      renderPrediction('could not save. try again.', true);
    }
  }

  predictionRoot.addEventListener('click', (event) => {
    const answer = event.target.closest('[data-played]');
    if (answer?.dataset.played === 'false') saveOutcome();
  });

  async function refreshState() {
    if (saving || document.visibilityState === 'hidden') return;
    try {
      const response = await fetch('/api/state', { headers: { Accept: 'application/json' } });
      if (!response.ok) return;
      const freshState = await response.json();
      if (JSON.stringify(freshState) === JSON.stringify(state)) return;
      state = freshState;
      renderChart();
      renderPrediction();
      renderHistory();
    } catch {
      // The current server-rendered state remains usable while a refresh is unavailable.
    }
  }

  setInterval(refreshState, 60_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshState();
  });
})();
