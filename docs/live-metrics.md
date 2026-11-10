# Incremental training metrics

The hidden dashboard can receive small updates directly from each run without a
page rebuild or deployment. Existing `live.json`, answers, dataset routes and the
`LIVE_WRITE` credential retain their existing behavior. A SQLite Durable Object
coordinates one dashboard's event order and stores the events and current run
summaries; different dashboard slugs use different objects. KV is used only to
check that the hidden page already exists, never as the live metric store.

## Producer contract

`POST /p/<slug>/metrics/<run_id>` with `Content-Type: application/json` and a scoped
`Authorization: Bearer <token>` header:

```json
{
  "version": 1,
  "seq": 1,
  "step": 42,
  "time": "2026-11-10T23:00:00Z",
  "arm": "all",
  "state": "running",
  "metrics": {
    "train/loss": 1.2,
    "comparison/same_shape_own_minus_twin/mean": 0.02,
    "comparison/same_shape_own_minus_twin/n": 128
  }
}
```

- Run IDs contain 1–64 ASCII letters, digits, underscores or hyphens. Use the
  existing run ID; a scientifically new run gets a new ID and credential.
- `seq` starts at 1 and increases by exactly one for every accepted update. Persist
  the sequence and exact pending request before sending; retry that request after
  a timeout. A byte-order-independent identical retry succeeds with
  `duplicate: true`, including after a Worker restart. Reusing a sequence with
  different data or skipping a sequence returns 409 without writing anything.
- `step` is the current nondecreasing run step, not an arrival counter. A delayed
  evaluation can publish its evaluated step as a numeric metric while keeping
  `step` at the producer's current step. `time` is source UTC ISO time ending in Z.
- `arm` is `all`, `ao` or `text` and cannot change within a run. `state` is
  `running`, `finished`, `failed` or `paused`; an old replay cannot change it.
- `metrics` contains 1–128 finite numeric scalars. Accepted namespaces are
  `train/`, `dev/`, `dev_how/`, `time/`, `system/`, `opt/`, `diagnostics/`,
  `comparison/` and `gold_logp/`. Key suffixes use ASCII letters, digits,
  underscore, period, slash and hyphen, up to 120 characters. An ambiguous
  `own_minus_twin` path component is rejected: use `raw_own_minus_twin` or
  `same_shape_own_minus_twin` and publish their own support/interval fields.
  Mean, `ci_low`, `ci_high`, `n`, `clusters`, and unseen slices are separate keys.
  Missing observations are omitted, never replaced with zero or null.
- The entire request is at most 16 KiB, checked while streaming. No arbitrary
  text, config, log, prompt, path, hostname or token fields are accepted.
  Producers must choose only metrics intended for public display. Publishing a
  number does not verify its scientific meaning or authorize a holdout claim.

Success is `{ "ok": true, "duplicate": false, "cursor": 17, "seq": 3 }`.
The cursor is the dashboard's durable event revision, shared across its runs;
it is not a training step. A duplicate returns the original event's cursor.
401/403/400/409 errors require fixing the producer; transient network/5xx failures
can retry the same pending update. Do not advance the sequence on failure.

## Reader contract

`GET /p/<slug>/metrics.json` returns a snapshot:

```json
{
  "version": 1, "cursor": 17, "snapshot": true, "events": [], "has_more": false,
  "runs": [{ "run_id": "example", "seq": 3, "step": 42,
    "time": "2026-11-10T23:00:00.000Z", "received_at": "2026-11-10T23:00:00.123Z",
    "arm": "all", "state": "running", "metrics": { "train/loss": 1.2 } }]
}
```

Snapshot metrics are the latest value of each key; they are not all measurements
from the snapshot's latest step. For exact plotted step association, use events.
Bootstrap existing history once from `live.json`, then take a metrics snapshot
and poll `metrics.json?after=<cursor>` approximately every second. The incremental
response has `snapshot: false`, `events`, `cursor`, and `has_more`. Each event
contains `revision`, `run_id`, server UTC `received_at`, and every producer field.
At most 32 events are returned in revision order. Drain `has_more` using the returned
cursor, and replace the local cursor only after applying the complete response.
An unchanged poll has an empty event array. A cursor ahead of the database gives
`reset: true`; reload the snapshot. `after=0` replays the full durable event log
in pages if historical live updates are required.

All responses use `Cache-Control: no-store` and the existing hidden-page headers.
Do not add a polling cache-buster or refetch historical `live.json` every second.
The client should expose only operator-mapped runs and rerender only when its
data changes. Compare source `time` with server `received_at` for ingestion delay,
and receipt time with the browser clock for freshness.

## Credentials and deployment

Set a new random master Worker secret `LIVE_METRICS_SECRET` through Wrangler's
secret mechanism. Never put it in source, a URL, browser assets, command arguments,
or a training pod. The legacy `LIVE_WRITE` key is not accepted by this endpoint.
A run's token is the lowercase hex HMAC-SHA256 of UTF-8
`moracles-live-v1\n<slug>\n<run_id>` using the master secret's UTF-8 bytes.

`node scripts/live-metrics-token.mjs SECRET_FILE SLUG_FILE RUN_ID NEW_TOKEN_FILE`
issues a token offline, writing only a new owner-readable file and never printing
either secret. Transport only that derived token to the matching producer using
the operator's existing private channel. The token cannot write another run or
dashboard. Rotating the master secret revokes all derived tokens; issue replacements
without changing stored sequence state.

The Worker adds the `LIVE_METRICS` binding and the `v4-live-metrics` SQLite class
migration. Deploy from the site's coordinated main checkout, retaining every
existing public and private asset. Deploying a bare backend worktree can replace
the site's assets and is not the deployment procedure. Provision the secret and
enable producers only through the coordinating site operator. No training job or
queue action is part of this change.

## Validation

`node --test tests/live-metrics.test.mjs` runs the actual Worker routes and SQLite
Durable Object in the repository's installed Miniflare runtime. It covers scoped
authentication, two-page separation, malformed/oversized payloads, unchanged
legacy routes, conflicting/out-of-order updates, concurrent idempotent retries,
incremental pagination and recovery after disposing and restarting the runtime.
`node_modules/.bin/tsc --project src/server` checks the Worker binding types.
