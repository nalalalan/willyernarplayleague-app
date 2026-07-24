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
