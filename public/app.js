(() => {
  'use strict';

  const initial = document.getElementById('initial-state');
  let state = JSON.parse(initial.textContent);
  let saving = false;

  const chartRoot = document.querySelector('[data-chart-root]');
  const predictionRoot = document.querySelector('[data-prediction-root]');
  const historyRoot = document.querySelector('[data-history-root]');
  const chartRenderer = globalThis.YernarLeagueChart;

  if (!chartRenderer) throw new Error('chart renderer unavailable');

  function renderChart() {
    chartRoot.innerHTML = chartRenderer.renderChart(state.chart);
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
