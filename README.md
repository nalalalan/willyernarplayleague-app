# will yernar play league?

Minimal AO Labs daily League forecast and result history.

The active League day stays open until 6:00 AM Eastern. `yes league`
records that Yernar played and `no league` records that he did not. After No,
`he changed his mind` can change the answer to Yes until the cutoff. Once Yes
is saved, the outcome controls disappear. If no answer is recorded, the closed
day is finalized as played. The four
supplied No outcomes on July 4, 13, 22, and 23, 2026 seed the initial history.
An explicitly deleted history entry becomes an intentional missing day and is
not recreated by seed migration or automatic Yes backfill.

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
day through 30 days after it. Its solid past series contains every recorded
outcome in that window: played is plotted at 100% and did not play at 0%. The
dashed future series contains exactly the next 30 daily probability forecasts,
and its first point remains the probability used by the tomorrow sentence.

Future probabilities are produced locally with deterministic recursive
marginalization. Branches remain exact while their count is small. Above 32
paths, midpoint systematic resampling selects 32 equal-weight particles from the
full normalized expansion, preserving probability-distribution diversity while
keeping runtime bounded. The method is versioned so an older cached outlook is
recomputed without changing any official forecast.

When the newest contiguous observed history contains at least three distinct No
clusters with a stable 4–21 day interval, the model adds a Bayesian cycle signal.
It learns play rates by cycle phase, shrinks them toward the overall rate, and
caps pattern confidence so predicted crash days become visible troughs without
ever becoming 0% or 100% forecasts. Simulated outlook paths cannot re-anchor the
observed cycle, and target-day outcomes remain excluded from their own forecast.

`PUT /api/outcomes/today` accepts
`{ "played": true|false, "expectedLeagueDay": "YYYY-MM-DD" }`. The day value is an
equality precondition, never a writable target; a stale tab receives `409` and
fresh state instead of recording against the new day. The operation is
idempotent, and the latest explicit answer before cutoff is canonical.

`DELETE /api/outcomes/:leagueDay` accepts
`{ "expectedRevision": 1, "expectedLeagueDay": "YYYY-MM-DD" }`. History
deletion is exposed through the small `edit` control and requires row-specific
confirmation. The revision and active-day preconditions prevent a stale page
from deleting a changed or newly re-recorded entry. A deletion is retained as
an audited tombstone, removes that day from model scoring and the solid past
series, and recomputes the provisional outlook without rewriting official
forecast snapshots. Duplicate identical deletion requests are idempotent.

Both write routes require same-origin JSON and share the in-memory request
throttle. They intentionally do not require an account, matching the app's
public contribution model; the inline confirmation, audit trail, backup, and
revision precondition protect against accidental or stale deletion.

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
