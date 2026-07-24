'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { StateStore, atomicWriteJson } = require('../lib/state-store');
const { LeagueService, createDefaultState, migrateState, validateState } = require('../lib/state');

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yernar-store-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function initializedStore(t, options = {}) {
  const dataDir = options.dataDir || await temporaryDirectory(t);
  const store = new StateStore({ dataDir, ...options });
  await store.initialize({ createDefault: createDefaultState, migrate: migrateState, validate: validateState });
  return store;
}

test('atomic interruption leaves the previous primary file valid', async (t) => {
  const directory = await temporaryDirectory(t);
  const filePath = path.join(directory, 'state.json');
  await atomicWriteJson(filePath, { generation: 1 });
  await assert.rejects(
    atomicWriteJson(filePath, { generation: 2 }, {
      beforeCommit: async () => { throw new Error('simulated interruption'); }
    }),
    /simulated interruption/
  );
  assert.deepEqual(JSON.parse(await fs.readFile(filePath, 'utf8')), { generation: 1 });
  const leftovers = (await fs.readdir(directory)).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('serialized update failure preserves both disk and in-memory state', async (t) => {
  let interrupt = false;
  const store = await initializedStore(t, {
    beforeCommit: async () => {
      if (interrupt) throw new Error('stop before rename');
    }
  });
  const before = store.getSnapshot();
  interrupt = true;
  await assert.rejects(store.update((state) => {
    state.outcomeRevision = 99;
    return { changed: true };
  }), /stop before rename/);
  assert.deepEqual(store.getSnapshot(), before);
  assert.deepEqual(JSON.parse(await fs.readFile(store.filePath, 'utf8')), before);
});

test('backup recovery restores a valid generation and reports degraded health', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const store = await initializedStore(t, { dataDir });
  await store.update((state) => {
    state.outcomeRevision = 1;
    return { changed: true };
  });
  assert.equal((await fs.stat(`${store.filePath}.bak`)).isFile(), true);
  await fs.writeFile(store.filePath, '{broken json', 'utf8');

  const recovered = new StateStore({ dataDir });
  await recovered.initialize({ createDefault: createDefaultState, migrate: migrateState, validate: validateState });
  const health = await recovered.health();
  assert.equal(health.recoveredFromBackup, true);
  assert.equal(health.degraded, true);
  assert.equal(health.writable, true);
  assert.equal(validateState(JSON.parse(await fs.readFile(recovered.filePath, 'utf8'))), true);
});

test('a valid backup is recovered when the primary file is missing', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const store = await initializedStore(t, { dataDir });
  await store.update((state) => {
    state.outcomeRevision = 1;
    return { changed: true };
  });
  await store.update((state) => {
    state.outcomeRevision = 2;
    return { changed: true };
  });
  await fs.rm(store.filePath);

  const recovered = new StateStore({ dataDir });
  await recovered.initialize({ createDefault: createDefaultState, migrate: migrateState, validate: validateState });
  const snapshot = recovered.getSnapshot();
  const health = await recovered.health();
  assert.equal(snapshot.outcomeRevision, 1);
  assert.equal(health.recoveredFromBackup, true);
  assert.equal(health.degraded, true);
  assert.match(health.lastError, /ENOENT/);
  assert.equal(validateState(JSON.parse(await fs.readFile(recovered.filePath, 'utf8'))), true);
});

test('semantic corruption is rejected and recovered from the prior generation', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const store = await initializedStore(t, { dataDir });
  await store.update((state) => {
    state.outcomeRevision = 1;
    return { changed: true };
  });
  const corrupted = store.getSnapshot();
  corrupted.outcomes = [];
  await fs.writeFile(store.filePath, JSON.stringify(corrupted), 'utf8');

  const recovered = new StateStore({ dataDir });
  await recovered.initialize({ createDefault: createDefaultState, migrate: migrateState, validate: validateState });
  assert.equal(recovered.getSnapshot().outcomeRevision, 0);
  assert.equal((await recovered.health()).recoveredFromBackup, true);
});

test('migration restores every absent authoritative seed without overwriting present data', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const state = createDefaultState();
  delete state.outcomes['2026-07-23'];
  state.outcomes['2026-07-04'] = {
    played: true,
    source: 'answer',
    recordedAt: '2026-07-04T16:00:00.000Z',
    revision: 2
  };
  await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify(state), 'utf8');

  const store = new StateStore({ dataDir });
  await store.initialize({ createDefault: createDefaultState, migrate: migrateState, validate: validateState });
  const snapshot = store.getSnapshot();
  assert.deepEqual(Object.keys(snapshot.outcomes).sort(), [
    '2026-07-04', '2026-07-13', '2026-07-22', '2026-07-23'
  ]);
  assert.equal(snapshot.outcomes['2026-07-04'].played, true);
  assert.equal(snapshot.outcomes['2026-07-04'].source, 'answer');
  assert.equal(snapshot.outcomes['2026-07-23'].played, false);
  assert.equal(snapshot.outcomes['2026-07-23'].source, 'authoritative-seed');
});

test('write queue commits concurrent mutations in arrival order', async (t) => {
  const store = await initializedStore(t);
  const first = store.update(async (state) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    state.outcomeRevision = 1;
    return { changed: true };
  });
  const second = store.update((state) => {
    state.outcomeRevision = 2;
    return { changed: true };
  });
  await Promise.all([first, second]);
  assert.equal(store.getSnapshot().outcomeRevision, 2);
  assert.equal(JSON.parse(await fs.readFile(store.filePath, 'utf8')).outcomeRevision, 2);
});

test('health performs a disposable write probe after initialization', async (t) => {
  const dataDir = await temporaryDirectory(t);
  let probeWrites = 0;
  const fsImpl = Object.create(fs);
  fsImpl.writeFile = async (filePath, ...args) => {
    if (path.basename(String(filePath)).startsWith('.write-probe-')) probeWrites += 1;
    return fs.writeFile(filePath, ...args);
  };
  const store = new StateStore({ dataDir, fsImpl });
  await store.initialize({ createDefault: createDefaultState, migrate: migrateState, validate: validateState });
  const before = probeWrites;
  const health = await store.health();
  assert.equal(health.writable, true);
  assert.ok(probeWrites > before);
});

test('concurrent health probes cannot collide and clear transient errors after success', async (t) => {
  const store = await initializedStore(t);
  store.status.lastError = 'transient probe failure';
  const originalNow = Date.now;
  Date.now = () => 12345;
  try {
    const healthResults = await Promise.all(Array.from({ length: 12 }, () => store.health()));
    assert.ok(healthResults.every((health) => health.writable));
    assert.ok(healthResults.every((health) => health.lastError === null));
  } finally {
    Date.now = originalNow;
  }
});

test('restart and reopen preserve the answer, history, and frozen official forecast', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const clock = () => new Date('2026-07-24T16:00:00.000Z');
  const firstStore = await initializedStore(t, { dataDir });
  const firstService = new LeagueService({ store: firstStore, clock });
  await firstService.getState();
  await firstService.setTodayOutcome(true);
  const officialBefore = firstStore.getSnapshot().forecasts.official['2026-07-24'];

  const reopenedStore = new StateStore({ dataDir });
  await reopenedStore.initialize({ createDefault: createDefaultState, migrate: migrateState, validate: validateState });
  const reopenedService = new LeagueService({ store: reopenedStore, clock });
  const state = await reopenedService.getState();
  assert.equal(state.todayOutcome, true);
  assert.equal(state.history[0].text, '7/24/26: yernar played league');
  assert.deepEqual(reopenedStore.getSnapshot().forecasts.official['2026-07-24'], officialBefore);
});
