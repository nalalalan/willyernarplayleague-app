# will yernar play league?

Minimal AO Labs daily League forecast and result history.

The active League day stays open until 6:00 AM Eastern. The only public action
records the exception that Yernar did not play. If no exception is recorded,
the closed day is finalized as played at the next cutoff. The four supplied No
outcomes on July 4, 13, 22, and 23, 2026 remain authoritative.

## Run

Requires Node.js 20 or newer.

```powershell
npm test
$env:DATA_DIR='.data'
npm start
```

The League day changes at 6:00 AM in `America/New_York`. Production stores its
state on a single Railway volume mounted at `/data`.

The public chart uses a fixed date domain from 30 days before the active League
day through 30 days after it. Its past series contains only real immutable
official forecasts within that past-30-calendar-day boundary; seeded and
backfilled outcomes never receive invented historical forecasts. The future
series contains exactly the next 30 daily forecasts, and its first point remains
the probability used by the tomorrow sentence.

Future probabilities are produced locally with deterministic recursive
marginalization. Branches remain exact while their count is small. Above 32
paths, midpoint systematic resampling selects 32 equal-weight particles from the
full normalized expansion, preserving probability-distribution diversity while
keeping runtime bounded. The method is versioned so an older cached outlook is
recomputed without changing any official forecast.

`PUT /api/outcomes/today` accepts only
`{ "played": false, "expectedLeagueDay": "YYYY-MM-DD" }`. The day value is an
equality precondition, never a writable target; a stale tab receives `409` and
fresh state instead of recording against the new day. The operation is
idempotent, and the public API does not accept Yes answers or corrections.

## Production configuration

- `NODE_ENV=production`
- `DATA_DIR=/data`
- `TIME_ZONE=America/New_York`
- `CANONICAL_ORIGIN=https://willyernarplayleague.aolabs.io`

`GET /api/health` is the Railway health-check route. Keep exactly one replica
attached to the volume.

State commits write and sync a temporary file in the same directory before the
final rename, and retain the previous generation as `state.json.bak`. Railway
runs this service on Linux, where a same-filesystem rename replaces the primary
atomically. The Windows compatibility fallback can briefly remove the primary;
startup therefore recovers a valid backup whenever the primary is missing or
unreadable. Keep `DATA_DIR` on one filesystem so the production rename retains
its atomic guarantee.
