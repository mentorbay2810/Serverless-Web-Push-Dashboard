# Phase 6: local validation and exploratory baseline

Candidate `0.1.0-rc.2` adds functional/security evidence and a controlled always-on local baseline. Cloud deployment remains disabled under the strict INR 100 decision. The Phase 5 `rc.1` bundle remains historical; this candidate uses a separate version.

The automated part of this phase is implemented. Real UI, OS notification/click and cross-browser trials remain pending. The local baseline is not the dissertation's formal serverless comparison.

## Reproduce validation

Use Node.js 22.19 or newer (24 is the project default):

```sh
npm ci
npm run setup
npm run validate:local
```

`validate:local` runs the release gate once: configuration/data checks, all tests, TypeScript/frontend builds, cloud ZIP packaging without deployment, compiled application smoke, credential scanning and the disabled deployment-policy check. It then runs a bounded 20-recipient baseline smoke against a loopback mock. No real push is sent by these checks.

The test wrapper emits TAP to stdout and JUnit to `.cache/validation/junit.xml` from the same execution, using Node's [multiple test reporters](https://nodejs.org/api/test.html#multiple-reporters). The gate checks their counts agree and rejects failures or skipped cases. `.cache/validation/report.json` records source digest, commit at execution, whether sources were clean, check results, pending work and hashes of raw evidence. `.cache/validation/report.md` is the readable report. The benchmark smoke is a correctness check, not a throughput conclusion.

Reports are ignored by Git. Editing sources during a gate invalidates it. Rerunning `npm test` replaces JUnit and can invalidate the previous report's recorded hash; rerun `validate:local` to regenerate consistent evidence. A failed gate removes its previous success report. Benchmark directories are unique; `latest.json` is explicitly running, failed or passed.

Public-repository CI runs this gate on Node 22.19 and 24, then audits runtime dependencies. It retains the public-only guard and performs no deployment, artifact uploads or caching. Repeated timing experiments run separately from CI.

## Validation matrix

| Area | Automated evidence | Still pending |
| --- | --- | --- |
| Public input/ownership | Malformed/oversized JSON, hostile endpoints/navigation, cross-subscription capabilities, duplicates, concurrent quota enforcement | Permission denied/revoked and real reconnection |
| Administrator access | Token claims/roles, host/origin guards, pairing expiry/replay, session revocation and privilege boundaries | Live Entra browser sign-in |
| Campaign lifecycle | Versioned drafts, targeting fingerprints, frozen audiences, UTC schedules, cancellation and checkpoints | UI interaction across viewports/browsers |
| Failures/limits | Retry-After, transient errors, expiry, exhausted retries, pause races and quotas | Real Service Bus settlement and Cosmos contention |
| Reporting/privacy | Scoped/expiring event capabilities, deduplication, worker behavior, generic SDK errors and redaction | OS display and real notification click evidence |
| Local release | Compiled HTTP flow, restart, paused startup, storage ownership, static/private paths and credential scanning | Hosted operation; retention remains manual |
| Research harness | Loopback pinning, redirect/auth checks, overlapping-job rejection, multi-campaign accounting, fault/abort rejection | Comparable Azure serverless experiment |

New scenarios are in `tests/security-matrix.test.ts` and `tests/benchmark.test.ts`; existing tests supply the campaign/recovery/session/reporting coverage. Simulated Entra tests do not establish live cloud integration.

## Repeated exploratory experiment

```sh
npm run benchmark -- --audience 100 --repetitions 3 --warmup 1 --seed 42 --concurrency 2 --mock-delay-ms 2
```

This builds tools, starts an authenticated mock HTTP provider in the driver process and forks an authenticated always-on host on a temporary literal `127.0.0.1` port. The child inherits minimal launcher settings, excluding application VAPID/admin/cloud credentials. Browser Origin headers are rejected. Every send targets the pinned loopback mock and refuses redirects, regardless of the synthetic endpoint. The tools never load `.env`, open `.data` or use the real Web Push sender.

The host reuses `DeliveryPipeline` with an instrumented in-memory database and FIFO arrays for queues. Each trial has a fresh dataset and quota counters. It completes all fan-out before bounded-parallel delivery. This measures that phased scheduler; it does not exercise interleaved cloud triggers, broker settlement, JSON disk I/O, encryption, the internet, browsers or Cosmos RU. Larger audiences use campaigns of at most 100 recipients. A research-only subscription-list subclass pages across the synthetic dataset; application API limits remain unchanged.

| Option | Default | Allowed |
| --- | --- | --- |
| `--audience` | 100 | 1–1,000 synthetic recipients |
| `--repetitions` | 3 | 1–10 measured trials |
| `--warmup` | 1 | 0–2 excluded warm-ups |
| `--seed` | 42 | Integer 0–4,294,967,295 |
| `--concurrency` | 2 | 1–8 delivery workers |
| `--mock-delay-ms` | 2 | 0–25 ms requested delay |
| `--max-duration-ms` | 20,000 | 1,000–60,000 ms per trial before cancellation |

The timing profile is healthy acceptance only; fault behavior is tested separately. No virtual time or skipped retry delays are used. A failed, timed-out or nonterminal trial invalidates the experiment. An in-flight request can take up to five seconds to time out during teardown; the launcher force-stops its owned child after six seconds. The driver stops host and mock in `finally`. No cloud resources are provisioned.

Outputs under `.cache/benchmarks/<experiment-uuid>/`:

- `summary.json` and `report.md`: source/compiled fingerprints, workload hash, Node/OS/CPU information, settings, trial summaries and limits.
- `trial-NN.json`: full metrics, attempts and outcomes.
- `trial-NN-attempts.ndjson`, `trial-NN-outcomes.csv` and `trial-NN-provider.ndjson`: raw synthetic traces and matching provider observations.
- `provider-all.ndjson`: all provider observations, including partial runs. `failure.json` records controlled failures.

No real endpoints, keys, bearer tokens or pairing URLs are recorded. Synthetic recipient/delivery IDs are hashes. The driver cross-checks provider and pipeline accounting. Warm-ups remain in raw files but are excluded from aggregates. Run sequentially on an otherwise idle machine and retain failed experiments too.

## Metric definitions

| Metric | Definition |
| --- | --- |
| Seed time | Synthetic registration before submission; separate from processing elapsed time |
| Dispatch time | Campaign submission through all fan-out |
| Queue wait | Enqueue to worker dequeue, including remaining fan-out |
| Provider-request time | Request start through complete HTTP response consumption, including transport and mock delay |
| Per-delivery end-to-end | Before first submission through the delivery's persisted outcome read |
| Elapsed time | Submission through delivery outcomes and final campaign refresh |
| Throughput | Accepted deliveries / elapsed seconds, per trial |
| CPU/RSS | Child CPU includes seeding and processing; before/after RSS snapshots are not peak memory |
| Database operations | Adapter calls/transaction writes, not Cosmos RU or a price estimate |

Percentiles use nearest rank. Measured delivery latencies are pooled; trial throughput is reported separately. Percentile values are not averaged. The seed reproduces endpoint identities, not timings, dates or run IDs. Requested delay is subject to timer scheduling. Driver/mock share a parent process on the same machine; polling and host scheduling can affect measurements.

Process startup is separate. The same host serves warm-ups and measured trials; this is not an Azure cold-start measurement. There is no serverless result, billing result, production capacity claim or causal conclusion from this baseline alone. The app still caps real subscribers at 100 and daily attempts at 1,000. Proposed 10,000/100,000 audiences are deferred until the data/query model and cost-safe environment support them.

Before formal Phase 7 comparison, hold payload, workload, adapter configuration, concurrency, region and provider behavior comparable across hosts; record deliberate differences. Keep synthetic local timing, real-browser evidence and cloud measurements separate. Cloud experiments remain deferred while the strict budget decision applies.

## Browser evidence to collect

Record actual browser/OS versions, source digest and timestamp. Exercise allow/deny/revoke permission, subscribe/opt-out/reconnect, administrator pairing and reviewed sends, scheduled/cancelled work, tab-closed/offline delivery, OS display and a safe click. Record acceptance, receipt and click separately. Check narrow/wide layouts and keyboard navigation. Mark unavailable cases pending; service-worker tests or historical receipts do not substitute for observed device trials.
