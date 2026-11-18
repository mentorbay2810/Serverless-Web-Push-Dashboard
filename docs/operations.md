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

## Candidate verification and evidence

`npm run release:check` runs the repeatable local gate in isolated test storage and writes `.cache/release/report.json`. It never sends real push messages. After committing unchanged source, `npm run release:package` creates the candidate ZIP and checksum. See [Phase 5](phase-5.md) for contents and limits.

For a deliberate real-browser check, use `npm run push:send -- --latest` or a selected campaign. Record provider acceptance, observed receipts, and actual click/display behavior separately. Do not put endpoint URLs, keys, session links, ownership tokens, or local state in Git, screenshots, or public issue reports.
