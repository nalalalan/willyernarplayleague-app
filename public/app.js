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
      width: 680, height: 218, left: 58, right: 642, historyRight: 370,
      outlookLeft: 400, top: 22, middle: 99, bottom: 176, axisX: 47, labelY: 204
    },
    mobile: {
      width: 360, height: 170, left: 42, right: 344, historyRight: 110,
      outlookLeft: 122, top: 10, middle: 66, bottom: 122, axisX: 34, labelY: 160
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

  function svgElement(name, attributes = {}) {
    const element = document.createElementNS(svgNamespace, name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
    return element;
  }

  function chartGeometry(layoutName) {
    const layout = chartLayouts[layoutName];
    const issued = [...(state.chart.issued || [])]
      .sort((a, b) => a.targetDay.localeCompare(b.targetDay))
      .slice(-28);
    const outlook = [...(state.chart.outlook || [])]
      .sort((a, b) => a.targetDay.localeCompare(b.targetDay));
    const pointY = (item) => layout.top + (1 - item.probability) * (layout.bottom - layout.top);
    const placeSeries = (items, startX, endX, singleX = endX) => {
      if (items.length === 0) return [];
      if (items.length === 1) return [{ ...items[0], x: singleX, y: pointY(items[0]) }];
      const firstDay = items[0].targetDay;
      const lastDay = items[items.length - 1].targetDay;
      const span = Math.max(1, dayNumber(lastDay) - dayNumber(firstDay));
      return items.map((item) => ({
        ...item,
        x: startX + ((dayNumber(item.targetDay) - dayNumber(firstDay)) / span) * (endX - startX),
        y: pointY(item)
      }));
    };
    const hasIssued = issued.length > 0;
    return {
      layout,
      issued: placeSeries(issued, layout.left, layout.historyRight),
      outlook: placeSeries(
        outlook,
        hasIssued ? layout.outlookLeft : layout.left,
        layout.right,
        hasIssued ? layout.outlookLeft : layout.left
      )
    };
  }

  function createChartSvg(layoutName) {
    const { issued, outlook, layout } = chartGeometry(layoutName);
    const suffix = layoutName === 'desktop' ? '' : '-mobile';
    const svg = svgElement('svg', {
      class: `chart-svg chart-svg-${layoutName}`,
      viewBox: `0 0 ${layout.width} ${layout.height}`,
      role: 'img',
      'aria-labelledby': `chart-title${suffix} chart-description${suffix}`,
      'data-chart': layoutName
    });
    const title = svgElement('title', { id: `chart-title${suffix}` });
    title.textContent = 'league probability over time';
    const description = svgElement('desc', { id: `chart-description${suffix}` });
    const issuedText = issued.length
      ? `Issued forecasts: ${issued.map((point) => `${displayDate(point.targetDay)} ${point.percent}%`).join(', ')}.`
      : 'No issued historical forecasts yet.';
    description.textContent = `${issuedText} Seven-day outlook: ${outlook.map((point) => `${displayDate(point.targetDay)} ${point.percent}%`).join(', ')}.`;
    svg.append(title, description);

    for (const [y, label] of [[layout.top, '100%'], [layout.middle, '50%'], [layout.bottom, '0%']]) {
      svg.append(svgElement('line', { class: 'chart-grid', x1: layout.left, y1: y, x2: layout.right, y2: y }));
      const text = svgElement('text', { class: 'chart-axis-label', x: layout.axisX, y: y + 4, 'text-anchor': 'end' });
      text.textContent = label;
      svg.append(text);
    }

    function addSeries(points, kind) {
      if (points.length > 1) {
        svg.append(svgElement('polyline', {
          class: `chart-line chart-line-${kind}`,
          points: points.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ')
        }));
      }
      for (const point of points) {
        const circle = svgElement('circle', {
          class: `chart-point chart-point-${kind}`,
          cx: point.x.toFixed(2),
          cy: point.y.toFixed(2),
          r: kind === 'issued' ? 4 : 3.5
        });
        const pointTitle = svgElement('title');
        pointTitle.textContent = `${displayDate(point.targetDay)}: ${point.percent}% ${kind === 'issued' ? 'issued' : 'outlook'}`;
        circle.append(pointTitle);
        svg.append(circle);
        if (kind === 'outlook') {
          const value = svgElement('text', {
            class: 'chart-value',
            x: point.x.toFixed(2),
            y: Math.max(layout.top - 8, point.y - 11).toFixed(2),
            'text-anchor': 'middle'
          });
          value.textContent = `${point.percent}%`;
          const date = svgElement('text', {
            class: 'chart-date',
            x: point.x.toFixed(2),
            y: layout.labelY,
            'text-anchor': 'middle'
          });
          date.textContent = shortDate(point.targetDay);
          svg.append(value, date);
        }
      }
    }

    addSeries(issued, 'issued');
    addSeries(outlook, 'outlook');
    return svg;
  }

  function renderChart() {
    chartRoot.replaceChildren();
    const section = document.createElement('section');
    section.className = 'probability-chart';
    section.setAttribute('aria-labelledby', 'chart-heading');
    const headingRow = document.createElement('div');
    headingRow.className = 'chart-heading-row';
    const heading = document.createElement('h2');
    heading.id = 'chart-heading';
    heading.textContent = 'probability over time';
    const legend = document.createElement('div');
    legend.className = 'chart-legend';
    legend.setAttribute('aria-label', 'chart legend');
    for (const [label, lineClass] of [['issued', 'legend-issued'], ['7-day outlook', 'legend-outlook']]) {
      const item = document.createElement('span');
      const line = document.createElement('i');
      line.className = `legend-line ${lineClass}`;
      line.setAttribute('aria-hidden', 'true');
      item.append(line, document.createTextNode(label));
      legend.append(item);
    }
    headingRow.append(heading, legend);
    section.append(headingRow, createChartSvg('desktop'), createChartSvg('mobile'));
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
