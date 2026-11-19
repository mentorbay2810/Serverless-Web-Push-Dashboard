# Local operations runbook

Keep cloud deployment off under [the recorded strict INR 100 decision](../infra/deployment-policy.json). These instructions operate the local demonstration.

For a complete local validation run, use `npm run validate:local`; results and JUnit evidence are in `.cache/validation/`. `npm run benchmark -- --audience 100 --repetitions 3 --warmup 1` starts and tears down an isolated synthetic host and mock without touching `.data`. Keep repeated timing experiments separate from application/test activity. See [Phase 6](phase-6.md) for bounds, raw trace formats and measurement limitations.

For a bounded matrix and replayable analysis, run `npm run research:run` on a clean committed checkout. It saves self-contained raw copies and derived evidence in `.cache/research/<suite-uuid>/`; see [Phase 7](phase-7.md) for plotting, verification and stale research-lock handling. Keep those research artifacts separate from the private demonstration state and from cloud claims.

## Start, stop, and sign in

Run `npm run setup` once, `npm run build`, then `npm start`. For source development, use `npm run dev:queued`. Open the configured frontend origin and generate a local administrator link with `npm run admin:login` in another terminal. The link lasts two minutes, the session one hour; restarting the API revokes sessions.

Use `Ctrl+C` in the service terminal to stop. Wait for exit before switching profiles or copying state. Every entry point locks the data directory; do not run multiple backends against it. An occupied port now fails startup and cleans up the other listener/worker resources.

## Diagnose without exposing private data

Run `npm run doctor`. It checks configuration, permissions, lock state, readable file formats, queue/dead-letter counts, and build presence. It never prints private keys, endpoint URLs, or browser ownership credentials.

| Symptom | Action |
| --- | --- |
| Missing build | Run `npm run build` before `npm start`. |
| VAPID mismatch or partial pair | Restore the matching original pair. Do not generate a new pair for existing subscribers. |
| Origin/port error | Use an HTTP loopback origin with its own port, distinct from `API_PORT`. Open that exact frontend origin. |
| Another backend owns the data | Stop it cleanly. Do not delete an active lock. |
| Stale lock after a crash | With services stopped, run `npm run local:unlock`. Live processes are never unlocked by that command. |
| Invalid lock record or retained unlock guard | Preserve it and inspect ownership manually; do not guess or delete other processes' files. |
| Administrator access expired | Run `npm run admin:login` again. |
| Queued work waits | Check both pause controls and the daily quota; recovery runs every minute and abandoned claims can take two minutes. |
| Provider 404/410 | The expired subscription is removed; reconnect that browser. |
| Failed/expired delivery | Inspect its report status and safe reason. Provider acceptance, receipt, and click counts have different meanings. |
| Dead letters | Pause work, preserve state, and diagnose the campaign/queue record. Automatic replay is not provided; replaying ambiguous work can duplicate notifications. |
| Corrupt data | Stop services and preserve the files. Restore a consistent private backup instead of editing live JSON. |

## Pause before recovery

```sh
npm start -- --paused
```

Both pause controls are saved while the exclusive data lock is held, before workers are created. The API and dashboard still open so you can inspect reports and queues. Resume deliberately from **Delivery controls**. Ordinary starts retain the last saved flags; they do not automatically unpause work. Source development also supports `npm run dev:queued -- --paused`.

Pauses stop future page commits and send claims. Provider requests already in flight may finish. Pauses and quotas control application work and do not enforce a currency limit.

## Back up and restore

After a clean stop, take one private offline snapshot of `.env` and the data files together:

- `.data/subscriptions.json` for the direct Foundation profile, if present.
- `.data/phase2-documents.json` for queued subscribers, campaigns, deliveries, observations, quotas, and controls.
- `.data/phase2-queues.json` for messages and dead letters.

These contain private subscription material and notification content. Store backups outside Git and served frontend directories with private filesystem permissions. Keep the original VAPID pair with its matching subscriber data. Do not copy transient `backend.lock`, `.env.setup.lock`, or `*.unlock` files into a restore.

With services stopped, restore the matching environment and data snapshot. Run `npm run setup` to validate and restore `.env` permissions, `npm run doctor`, then `npm start -- --paused`. Generate a fresh sign-in link, review the retained work, and resume deliberately. Registrations made after the snapshot may need to reconnect.

Restoring queued state can replay work that a provider accepted after the snapshot. The pipeline is at least once and cannot guarantee exactly-once notification display. Keep backup/restore trials in a separate private data directory if you are rehearsing recovery.

## Retain terminal history offline

Local JSON adapters do not enforce the documents' Cosmos TTL fields. Retention is an explicit offline operation for the queued profile. Stop the backend, then preview:

```sh
npm run local:retention
npm run local:retention -- plan 90
```

The default is 30 days; accepted ages are whole days from 30 to 3,650. Preview prints counts, cutoff, and a plan ID. It saves a private plan under `<LOCAL_DATA_DIR>/retention/` and leaves application history unchanged. Plans contain hashes and record identities, with no notification text or subscription keys. They expire after 24 hours, and any document/queue byte change invalidates them. An active or stale backend lock prevents every retention command; stale ownership requires the separate documented unlock procedure.

Only terminal campaigns whose known deliveries are all terminal qualify. Campaign creation/update/schedule times and delivery update/receipt/click/retry times must precede the cutoff. Live or malformed leases, unexpired observation capabilities, inconsistent children, incomplete completed campaigns, and queue or dead-letter references preserve the entire group. Cancelled/failed groups can have recipients that were never expanded. Unknown document kinds and orphan delivery history are preserved for inspection.

After inspecting the preview, apply its exact ID while services remain stopped:

```sh
npm run local:retention -- apply <plan-id>
```

Apply first writes and syncs private recovery copies of both queued files and a manifest, then replaces the document file atomically. Queue bytes stay unchanged. Removed deliveries and campaign content leave the active reports; a minimal `campaign-archive` marker retains the campaign ID and site, an ETag, and archive time. Retrying its old creation key returns HTTP 409; a new campaign needs a new key. Markers remain indefinitely to prevent replay, so this tool does not place a fixed bound on total record count.

Subscriptions, Foundation data, VAPID keys, quotas, daily counters, delivery controls, recovery cursors, queues, and dead letters remain in place. Private files must be regular files without symbolic/hard links; data and artifact directories must have no group/other permissions. Fix ownership or permissions deliberately rather than copying private data into a public location.

To undo just that retention edit, use the returned backup ID **before any other queued state changes**:

```sh
npm run local:retention -- restore <backup-id>
```

Undo verifies the backup and requires the current document and queue hashes to match the post-retention state. It restores the original document bytes without touching the queues. If state has changed, it refuses to overwrite newer work; use the full offline recovery procedure above when recovering a later operational incident. After retention or undo, run `npm run doctor`, then start paused to inspect work.

Recovery copies still contain the archived private history. Retention does not erase those backups, clean the Foundation profile, or schedule automatic deletion. Keep them outside Git and served directories, and set their disposal policy separately. See [the maintenance record](maintenance.md) for the synthetic rehearsal and audit evidence.

## Candidate verification and evidence

`npm run release:check` runs the repeatable local gate in isolated test storage and writes `.cache/release/report.json`. It never sends real push messages. After committing unchanged source, `npm run release:package` creates the candidate ZIP and checksum. See [Phase 5](phase-5.md) for contents and limits.

For a deliberate real-browser check, use `npm run push:send -- --latest` or a selected campaign. Record provider acceptance, observed receipts, and actual click/display behavior separately. Do not put endpoint URLs, keys, session links, ownership tokens, or local state in Git, screenshots, or public issue reports.
