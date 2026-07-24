'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function clone(value) {
  return structuredClone(value);
}

async function pathExists(fsImpl, filePath) {
  try {
    await fsImpl.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function replaceFile(fsImpl, source, destination) {
  try {
    await fsImpl.rename(source, destination);
  } catch (error) {
    if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error;
    await fsImpl.rm(destination, { force: true });
    await fsImpl.rename(source, destination);
  }
}

async function atomicWriteJson(filePath, value, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const backupPath = options.backupPath || `${filePath}.bak`;
  const directory = path.dirname(filePath);
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const temporaryPath = `${filePath}.${nonce}.tmp`;
  const backupTemporaryPath = `${backupPath}.${nonce}.tmp`;
  const serialized = `${JSON.stringify(value, null, 2)}\n`;

  await fsImpl.mkdir(directory, { recursive: true });
  try {
    const handle = await fsImpl.open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    if (typeof options.beforeCommit === 'function') {
      await options.beforeCommit({ filePath, temporaryPath, backupPath });
    }

    if (!options.skipBackup && await pathExists(fsImpl, filePath)) {
      await fsImpl.copyFile(filePath, backupTemporaryPath);
      await replaceFile(fsImpl, backupTemporaryPath, backupPath);
    }
    await replaceFile(fsImpl, temporaryPath, filePath);
  } finally {
    await fsImpl.rm(temporaryPath, { force: true }).catch(() => {});
    await fsImpl.rm(backupTemporaryPath, { force: true }).catch(() => {});
  }
}

async function readJson(fsImpl, filePath) {
  const raw = await fsImpl.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

class StateStore {
  constructor(options = {}) {
    this.fs = options.fsImpl || fs;
    this.dataDir = options.dataDir;
    this.filePath = path.join(this.dataDir, options.filename || 'state.json');
    this.backupPath = `${this.filePath}.bak`;
    this.beforeCommit = options.beforeCommit;
    this.current = null;
    this.writeQueue = Promise.resolve();
    this.status = {
      initialized: false,
      writable: false,
      recoveredFromBackup: false,
      degraded: false,
      lastWriteAt: null,
      lastError: null
    };
  }

  async verifyWritable() {
    await this.fs.mkdir(this.dataDir, { recursive: true });
    const probe = path.join(this.dataDir, `.write-probe-${process.pid}-${Date.now()}-${randomUUID()}`);
    await this.fs.writeFile(probe, 'ok', { flag: 'wx' });
    await this.fs.rm(probe, { force: true });
    this.status.writable = true;
    if (!this.status.degraded) this.status.lastError = null;
  }

  async initialize({ createDefault, migrate, validate }) {
    await this.verifyWritable();
    let state;
    let source = 'primary';
    let shouldWrite = false;

    const prepare = (candidate, label) => {
      let prepared = clone(candidate);
      let changed = false;
      if (migrate) {
        const migrated = migrate(prepared);
        prepared = migrated.state;
        changed = Boolean(migrated.changed);
      }
      if (validate && !validate(prepared)) throw new Error(`${label} state failed validation.`);
      return { state: prepared, changed };
    };

    try {
      const primary = prepare(await readJson(this.fs, this.filePath), 'Primary');
      state = primary.state;
      shouldWrite = primary.changed;
    } catch (primaryError) {
      const primaryExists = await pathExists(this.fs, this.filePath);
      const backupExists = await pathExists(this.fs, this.backupPath);
      if (backupExists) {
        try {
          const backup = prepare(await readJson(this.fs, this.backupPath), 'Backup');
          state = backup.state;
          source = 'backup';
          shouldWrite = true;
          this.status.recoveredFromBackup = true;
          this.status.degraded = true;
          this.status.lastError = `primary state invalid: ${primaryError.message}`;
        } catch (backupError) {
          throw new Error(`State and backup are invalid: ${primaryError.message}; ${backupError.message}`);
        }
      } else if (primaryExists) {
        throw new Error(`Primary state is invalid and no backup exists: ${primaryError.message}`);
      } else {
        const created = prepare(createDefault(), 'Default');
        state = created.state;
        source = 'new';
        shouldWrite = true;
      }
    }

    this.current = state;
    if (shouldWrite) {
      await atomicWriteJson(this.filePath, this.current, {
        fsImpl: this.fs,
        backupPath: this.backupPath,
        beforeCommit: this.beforeCommit,
        skipBackup: source === 'backup'
      });
      this.status.lastWriteAt = new Date().toISOString();
    }
    this.status.initialized = true;
    return this.getSnapshot();
  }

  getSnapshot() {
    if (!this.current) throw new Error('State store is not initialized.');
    return clone(this.current);
  }

  async update(mutator) {
    const operation = async () => {
      const draft = this.getSnapshot();
      const mutation = await mutator(draft) || {};
      if (mutation.changed) {
        await atomicWriteJson(this.filePath, draft, {
          fsImpl: this.fs,
          backupPath: this.backupPath,
          beforeCommit: this.beforeCommit
        });
        this.current = draft;
        this.status.lastWriteAt = new Date().toISOString();
        this.status.lastError = null;
      }
      return {
        state: this.getSnapshot(),
        result: mutation.result,
        changed: Boolean(mutation.changed)
      };
    };

    const queued = this.writeQueue.then(operation, operation);
    this.writeQueue = queued.then(() => undefined, (error) => {
      this.status.lastError = error.message;
      return undefined;
    });
    return queued;
  }

  async health() {
    try {
      await this.verifyWritable();
    } catch (error) {
      this.status.writable = false;
      this.status.lastError = error.message;
    }
    return { ...this.status };
  }
}

module.exports = {
  StateStore,
  atomicWriteJson,
  pathExists,
  readJson
};
