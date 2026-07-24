'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const { StateStore } = require('./lib/state-store');
const {
  LeagueService,
  OUTLOOK_HORIZON,
  SCHEMA_VERSION,
  createDefaultState,
  migrateState,
  validateState
} = require('./lib/state');
const { renderPage } = require('./lib/view');
const { renderChartCss } = require('./public/chart');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '.data');
const CANONICAL_ORIGIN = (process.env.CANONICAL_ORIGIN || 'https://willyernarplayleague.aolabs.io').replace(/\/$/, '');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = 1024;

const STATIC_FILES = Object.freeze({
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/chart.js': ['chart.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml; charset=utf-8'],
  '/site.webmanifest': ['site.webmanifest', 'application/manifest+json; charset=utf-8']
});

const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': "default-src 'self'; img-src 'self' https://aolabs.io data:; style-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY'
});

function writeResponse(response, statusCode, headers, body = '') {
  response.writeHead(statusCode, { ...SECURITY_HEADERS, ...headers });
  response.end(body);
}

function writeJson(response, statusCode, value) {
  writeResponse(response, statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  }, JSON.stringify(value));
}

function writeText(response, statusCode, text) {
  writeResponse(response, statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store'
  }, text);
}

async function readJsonBody(request) {
  const contentType = String(request.headers['content-type'] || '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    const error = new Error('content type must be application/json');
    error.statusCode = 415;
    throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('request body is too large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('request body must be valid JSON');
    error.statusCode = 400;
    throw error;
  }
}

function requestOrigin(request) {
  const forwardedProto = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwardedProto || (request.socket.encrypted ? 'https' : 'http');
  const host = request.headers.host;
  return host ? `${protocol}://${host}` : null;
}

function isSameOriginWrite(request, canonicalOrigin = CANONICAL_ORIGIN) {
  const fetchSite = String(request.headers['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite === 'cross-site') return false;
  const origin = request.headers.origin;
  if (!origin) return false;
  if (origin === 'null') return false;
  const sameRequestOrigin = requestOrigin(request);
  return origin === canonicalOrigin || origin === sameRequestOrigin;
}

function isModelStateReady(state) {
  if (!state
    || typeof state.activeLeagueDay !== 'string'
    || typeof state.statement !== 'string'
    || !Array.isArray(state.history)
    || !state.chart
    || !Array.isArray(state.chart.issued)
    || !Array.isArray(state.chart.outlook)
    || state.chart.outlook.length !== OUTLOOK_HORIZON
    || !state.outlook
    || !Array.isArray(state.outlook.points)
    || state.outlook.points.length !== OUTLOOK_HORIZON) return false;
  const displayedProbability = state.todayOutcome === null
    ? state.todayProbability
    : state.tomorrowProbability;
  return Number.isInteger(displayedProbability)
    && displayedProbability >= 5
    && displayedProbability <= 95
    && state.outlook.points.every((point) => (
      point
      && typeof point.targetDay === 'string'
      && Number.isInteger(point.percent)
      && point.percent >= 5
      && point.percent <= 95
    ));
}

function clientAddress(request) {
  const forwarded = String(request.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || request.socket.remoteAddress || 'unknown';
}

class MemoryWriteThrottle {
  constructor({ limit = 30, windowMs = 60_000, clock = () => Date.now() } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.clock = clock;
    this.entries = new Map();
  }

  allow(key) {
    const now = this.clock();
    const recent = (this.entries.get(key) || []).filter((timestamp) => now - timestamp < this.windowMs);
    if (recent.length >= this.limit) {
      this.entries.set(key, recent);
      return false;
    }
    recent.push(now);
    this.entries.set(key, recent);
    if (this.entries.size > 5000) {
      for (const [entryKey, timestamps] of this.entries) {
        if (!timestamps.some((timestamp) => now - timestamp < this.windowMs)) this.entries.delete(entryKey);
      }
    }
    return true;
  }
}

function createRequestHandler({
  service,
  store,
  publicDir = PUBLIC_DIR,
  canonicalOrigin = CANONICAL_ORIGIN,
  throttle = new MemoryWriteThrottle()
}) {
  return async function handleRequest(request, response) {
    let url;
    try {
      url = new URL(request.url, 'http://local');
    } catch {
      writeText(response, 400, 'bad request');
      return;
    }

    try {
      if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/chart.css') {
        const body = Buffer.from(renderChartCss());
        writeResponse(response, 200, {
          'Content-Type': 'text/css; charset=utf-8',
          'Cache-Control': 'public, max-age=300',
          'Content-Length': String(body.length)
        }, request.method === 'HEAD' ? '' : body);
        return;
      }

      if ((request.method === 'GET' || request.method === 'HEAD') && STATIC_FILES[url.pathname]) {
        const [filename, contentType] = STATIC_FILES[url.pathname];
        const body = await fs.readFile(path.join(publicDir, filename));
        writeResponse(response, 200, {
          'Content-Type': contentType,
          'Cache-Control': url.pathname === '/icon.svg' ? 'public, max-age=86400' : 'public, max-age=300',
          'Content-Length': String(body.length)
        }, request.method === 'HEAD' ? '' : body);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/') {
        const state = await service.getState();
        const html = renderPage(state, { canonicalOrigin });
        writeResponse(response, 200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store'
        }, html);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/state') {
        writeJson(response, 200, await service.getState());
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/health') {
        let modelReady = false;
        let modelError = null;
        try {
          modelReady = isModelStateReady(await service.getState());
          if (!modelReady) modelError = 'model state failed readiness checks';
        } catch (error) {
          modelError = error.message;
        }
        const storage = await store.health();
        const ready = storage.initialized && storage.writable && modelReady;
        writeJson(response, ready ? 200 : 503, {
          status: ready ? (storage.degraded || storage.lastError ? 'degraded' : 'ok') : 'unhealthy',
          runtime: { node: process.version, uptimeSeconds: Math.floor(process.uptime()) },
          storage: {
            writable: storage.writable,
            recoveredFromBackup: storage.recoveredFromBackup,
            lastWriteAt: storage.lastWriteAt,
            error: storage.lastError
          },
          schemaVersion: SCHEMA_VERSION,
          modelReady,
          modelError
        });
        return;
      }

      if (request.method === 'PUT' && url.pathname === '/api/outcomes/today') {
        if (!isSameOriginWrite(request, canonicalOrigin)) {
          writeJson(response, 403, { error: 'same-origin request required' });
          return;
        }
        if (!throttle.allow(clientAddress(request))) {
          writeJson(response, 429, { error: 'too many requests; try again shortly' });
          return;
        }
        const body = await readJsonBody(request);
        if (!body
          || typeof body !== 'object'
          || Array.isArray(body)
          || body.played !== false
          || typeof body.expectedLeagueDay !== 'string'
          || !/^\d{4}-\d{2}-\d{2}$/.test(body.expectedLeagueDay)
          || Object.keys(body).some((key) => !['played', 'expectedLeagueDay'].includes(key))) {
          writeJson(response, 400, { error: 'body must be { "played": false, "expectedLeagueDay": "YYYY-MM-DD" }' });
          return;
        }
        writeJson(response, 200, await service.recordTodayNo(body.expectedLeagueDay));
        return;
      }

      const deleteOutcomeMatch = /^\/api\/outcomes\/(\d{4}-\d{2}-\d{2})$/.exec(url.pathname);
      if (request.method === 'DELETE' && deleteOutcomeMatch) {
        if (!isSameOriginWrite(request, canonicalOrigin)) {
          writeJson(response, 403, { error: 'same-origin request required' });
          return;
        }
        if (!throttle.allow(clientAddress(request))) {
          writeJson(response, 429, { error: 'too many requests; try again shortly' });
          return;
        }
        const body = await readJsonBody(request);
        if (!body
          || typeof body !== 'object'
          || Array.isArray(body)
          || !Number.isInteger(body.expectedRevision)
          || body.expectedRevision < 1
          || typeof body.expectedLeagueDay !== 'string'
          || !/^\d{4}-\d{2}-\d{2}$/.test(body.expectedLeagueDay)
          || Object.keys(body).some((key) => !['expectedRevision', 'expectedLeagueDay'].includes(key))) {
          writeJson(response, 400, {
            error: 'body must be { "expectedRevision": 1, "expectedLeagueDay": "YYYY-MM-DD" }'
          });
          return;
        }
        writeJson(response, 200, await service.deleteOutcome(
          deleteOutcomeMatch[1],
          body.expectedRevision,
          body.expectedLeagueDay
        ));
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        writeJson(response, 404, { error: 'not found' });
      } else {
        writeText(response, 404, 'not found');
      }
    } catch (error) {
      const statusCode = error.statusCode || 500;
      if (statusCode >= 500) console.error(error);
      if (url.pathname.startsWith('/api/')) {
        const payload = { error: statusCode >= 500 ? 'server error' : error.message };
        if (statusCode === 409 && error.state) payload.state = error.state;
        writeJson(response, statusCode, payload);
      } else {
        writeText(response, statusCode, statusCode >= 500 ? 'server error' : error.message);
      }
    }
  };
}

async function createApplication(options = {}) {
  const store = options.store || new StateStore({ dataDir: options.dataDir || DATA_DIR });
  if (!options.store) {
    await store.initialize({ createDefault: createDefaultState, migrate: migrateState, validate: validateState });
  }
  const service = options.service || new LeagueService({ store, clock: options.clock });
  const handler = createRequestHandler({
    service,
    store,
    publicDir: options.publicDir || PUBLIC_DIR,
    canonicalOrigin: options.canonicalOrigin || CANONICAL_ORIGIN,
    throttle: options.throttle
  });
  return { store, service, handler };
}

async function start() {
  const application = await createApplication();
  const server = http.createServer(application.handler);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`will yernar play league listening on ${PORT}`);
  });
  return server;
}

if (require.main === module) {
  start().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  MAX_BODY_BYTES,
  MemoryWriteThrottle,
  createApplication,
  createRequestHandler,
  isModelStateReady,
  isSameOriginWrite,
  readJsonBody,
  requestOrigin,
  start
};
