# will yernar play league?

Minimal AO Labs daily League forecast and answered-day history.

## Run

Requires Node.js 20 or newer.

```powershell
npm test
$env:DATA_DIR='.data'
npm start
```

The League day changes at 6:00 AM in `America/New_York`. Production stores its
state on a single Railway volume mounted at `/data`.

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
