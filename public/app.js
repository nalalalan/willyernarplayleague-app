(() => {
  'use strict';

  const initial = document.getElementById('initial-state');
  let state = JSON.parse(initial.textContent);
  let mutating = false;
  let historyEditing = false;
  let confirmingDeleteDay = null;

  const chartRoot = document.querySelector('[data-chart-root]');
  const predictionRoot = document.querySelector('[data-prediction-root]');
  const historyRoot = document.querySelector('[data-history-root]');
  const chartRenderer = globalThis.YernarLeagueChart;

  if (!chartRenderer) throw new Error('chart renderer unavailable');

  function renderChart() {
    chartRoot.innerHTML = chartRenderer.renderChart(state.chart);
  }

  function outcomeControls() {
    const buttons = document.createElement('div');
    buttons.className = 'answer-buttons';
    if (state.canChangeMind) {
      const changeMindButton = document.createElement('button');
      changeMindButton.className = 'answer-button answer-change-mind';
      changeMindButton.type = 'button';
      changeMindButton.dataset.played = 'true';
      changeMindButton.textContent = state.changeMindLabel || 'he changed his mind';
      changeMindButton.disabled = mutating;
      buttons.append(changeMindButton);
      return buttons;
    }
    const yesButton = document.createElement('button');
    yesButton.className = 'answer-button answer-affirmative';
    yesButton.type = 'button';
    yesButton.dataset.played = 'true';
    yesButton.textContent = state.yesActionLabel || 'yes league';
    yesButton.disabled = mutating;
    const noButton = document.createElement('button');
    noButton.className = 'answer-button answer-exception';
    noButton.type = 'button';
    noButton.dataset.played = 'false';
    noButton.textContent = state.actionLabel || 'no league';
    noButton.disabled = mutating;
    buttons.append(yesButton, noButton);
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
    if (state.canRecordOutcome || state.canChangeMind) {
      const answerArea = document.createElement('div');
      answerArea.className = 'answer-area';
      answerArea.dataset.answerArea = '';
      answerArea.append(outcomeControls());
      section.append(answerArea);
    }
    section.append(status);
    predictionRoot.append(section);
  }

  function renderHistory(statusText = '', isError = false) {
    historyRoot.replaceChildren();
    const section = document.createElement('section');
    section.className = 'history';
    section.setAttribute('aria-labelledby', 'history-heading');
    section.dataset.historySection = '';
    section.dataset.editing = historyEditing ? 'true' : 'false';
    const headingRow = document.createElement('div');
    headingRow.className = 'history-heading-row';
    const heading = document.createElement('h2');
    heading.id = 'history-heading';
    heading.textContent = 'history';
    const edit = document.createElement('button');
    edit.className = 'history-edit';
    edit.type = 'button';
    edit.dataset.historyToggle = '';
    edit.setAttribute('aria-expanded', String(historyEditing));
    edit.setAttribute('aria-controls', 'history-list');
    edit.textContent = historyEditing ? 'done' : 'edit';
    edit.disabled = mutating || state.history.length === 0;
    headingRow.append(heading, edit);
    const list = document.createElement('ol');
    list.id = 'history-list';
    list.dataset.history = '';
    for (const entry of state.history) {
      const item = document.createElement('li');
      item.dataset.historyDay = entry.dateKey;
      const text = document.createElement('span');
      text.className = 'history-entry-text';
      text.textContent = entry.text;
      const action = document.createElement('span');
      action.className = 'history-entry-action';
      if (confirmingDeleteDay === entry.dateKey) {
        action.classList.add('history-confirm');
        const prompt = document.createElement('span');
        prompt.className = 'history-confirm-label';
        prompt.textContent = 'delete this entry?';
        const confirm = document.createElement('button');
        confirm.className = 'history-confirm-delete';
        confirm.type = 'button';
        confirm.dataset.confirmDeleteDay = entry.dateKey;
        confirm.textContent = mutating ? 'deleting...' : 'delete';
        confirm.disabled = mutating;
        const cancel = document.createElement('button');
        cancel.className = 'history-cancel-delete';
        cancel.type = 'button';
        cancel.dataset.cancelDelete = '';
        cancel.textContent = 'cancel';
        cancel.disabled = mutating;
        action.append(prompt, confirm, cancel);
      } else {
        const remove = document.createElement('button');
        remove.className = 'history-delete';
        remove.type = 'button';
        remove.dataset.deleteDay = entry.dateKey;
        remove.dataset.deleteRevision = String(entry.revision);
        remove.setAttribute('aria-label', `delete ${entry.date} entry`);
        remove.textContent = 'delete';
        remove.disabled = mutating;
        action.append(remove);
      }
      item.append(text, action);
      list.append(item);
    }
    const status = document.createElement('p');
    status.className = 'history-status';
    status.dataset.historyStatus = '';
    status.dataset.error = isError ? 'true' : 'false';
    status.setAttribute('role', 'status');
    status.textContent = statusText;
    section.append(headingRow, list, status);
    historyRoot.append(section);
  }

  async function saveOutcome(played) {
    if (mutating) return;
    mutating = true;
    renderPrediction('saving...');
    renderHistory();
    try {
      const response = await fetch('/api/outcomes/today', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ played, expectedLeagueDay: state.activeLeagueDay })
      });
      const payload = await response.json();
      if (response.status === 409 && payload.state) {
        state = payload.state;
        mutating = false;
        renderChart();
        renderPrediction('day changed. try again.');
        renderHistory();
        return;
      }
      if (!response.ok) throw new Error('save failed');
      state = payload;
      mutating = false;
      renderChart();
      renderPrediction();
      renderHistory();
    } catch {
      mutating = false;
      renderPrediction('could not save. try again.', true);
      renderHistory();
    }
  }

  async function deleteOutcome(entry) {
    if (mutating) return;
    mutating = true;
    confirmingDeleteDay = entry.dateKey;
    renderPrediction();
    renderHistory('deleting...');
    try {
      const response = await fetch(`/api/outcomes/${encodeURIComponent(entry.dateKey)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          expectedRevision: entry.revision,
          expectedLeagueDay: state.activeLeagueDay
        })
      });
      const payload = await response.json();
      if (response.status === 409 && payload.state) {
        state = payload.state;
        mutating = false;
        confirmingDeleteDay = null;
        renderChart();
        renderPrediction();
        renderHistory('history changed. try again.', true);
        return;
      }
      if (!response.ok) throw new Error('delete failed');
      state = payload;
      mutating = false;
      confirmingDeleteDay = null;
      renderChart();
      renderPrediction();
      renderHistory();
    } catch {
      mutating = false;
      renderPrediction();
      renderHistory('could not delete. try again.', true);
    }
  }

  predictionRoot.addEventListener('click', (event) => {
    const answer = event.target.closest('[data-played]');
    if (answer?.dataset.played === 'true' || answer?.dataset.played === 'false') {
      saveOutcome(answer.dataset.played === 'true');
    }
  });

  historyRoot.addEventListener('click', (event) => {
    const toggle = event.target.closest('[data-history-toggle]');
    if (toggle) {
      historyEditing = !historyEditing;
      confirmingDeleteDay = null;
      renderHistory();
      return;
    }

    const remove = event.target.closest('[data-delete-day]');
    if (remove) {
      historyEditing = true;
      confirmingDeleteDay = remove.dataset.deleteDay;
      renderHistory();
      historyRoot.querySelector(`[data-confirm-delete-day="${confirmingDeleteDay}"]`)?.focus();
      return;
    }

    if (event.target.closest('[data-cancel-delete]')) {
      confirmingDeleteDay = null;
      renderHistory();
      return;
    }

    const confirm = event.target.closest('[data-confirm-delete-day]');
    if (confirm) {
      const entry = state.history.find((item) => item.dateKey === confirm.dataset.confirmDeleteDay);
      if (entry) deleteOutcome(entry);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !confirmingDeleteDay || mutating) return;
    const cancelledDay = confirmingDeleteDay;
    confirmingDeleteDay = null;
    renderHistory();
    historyRoot.querySelector(`[data-delete-day="${cancelledDay}"]`)?.focus();
  });

  async function refreshState() {
    if (mutating || document.visibilityState === 'hidden') return;
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
