# Phase 7: local experiments and analysis

Candidate `0.1.0-rc.3` adds a bounded experiment matrix, raw-evidence verification, descriptive analysis, CSV exports and Matplotlib figures. This is the locally executable part of Phase 7. A formal serverless/always-on cloud comparison, cloud usage/cost evidence and real-browser trials remain pending. The strict INR 100 decision keeps cloud deployment off.

## Recorded plan

`experiments/local-baseline-v1.json` fixes the experiment before data collection:

| Factor | Values |
| --- | --- |
| Audience | 10, 100, 1,000 synthetic recipients |
| Delivery workers | 1, 2, 4 |
| Process condition | Fresh processes; reused processes after warm-up |
| Repetitions | Five measured per scenario |
| Warm-up | One excluded trial per reused scenario |
| Provider | Healthy loopback HTTP acceptance, requested delay 2 ms |
| Dataset/order seeds | 42 / 20261118 |

The 18 scenario blocks yield 90 measured trials, 33,300 measured mock acceptances and nine excluded warm-ups (3,330 acceptances). Scenario order is deterministically shuffled; repetitions stay within each block. This reduces a fixed ascending-size order but does not eliminate scheduling, thermal or time drift. All execution IDs and the actual order are saved.

Fresh-process repetitions each start a new driver/mock process and child host with no workload warm-up. Reused scenarios use one driver/mock and child host, exclude warm-ups, then execute five measured trials with fresh in-memory datasets. Both sides change driver/mock and host reuse, so their difference cannot be attributed solely to the child host. A fresh process is not a cold machine or an Azure cold start.

The Phase 6 pipeline, payload, memory adapters, phased fan-out and loopback mock remain the same. Audiences above 100 use multiple campaigns of at most 100 recipients. Real application subscriber and attempt limits remain unchanged. These experiments omit real push encryption, browsers, internet transport, durable queue/storage I/O and cloud trigger interleaving.

## Run and replay

With dependencies installed, use a clean committed checkout and stop other development/test workloads before collecting measurements:

```sh
npm run validate:local
npm run research:run
```

`research:run` builds before measuring. A ten-minute suite bound, per-trial timeout, sequential execution and a research ownership lock bound local resource use. Plans accept at most three distinct audiences up to 1,000, three worker settings up to four, two to five repetitions and one or two reused warm-ups. A plan exceeding 50,000 total synthetic deliveries is rejected. No Azure credentials or resources are needed. The strict disabled-cloud policy is checked before execution.

For a small functional check, build then run `npm run research:smoke`. It exercises both process conditions using three recipients, two measured repetitions per condition and one excluded warm-up: four measured trials, 12 measured acceptances, 15 including warm-up. Public test-only CI runs this smoke on Node 22.19 and 24; it does not run the full matrix or install plotting libraries.

Each suite writes a unique `.cache/research/<suite-uuid>/` directory. `.cache/research/latest.json` explicitly records running, passed or failed. Failed suites retain their completed executions/logs and cannot issue a passing analysis. Partial underlying benchmark traces remain in `.cache/benchmarks/`. Do not edit source or rebuild tools during collection; source/compiled digests must remain stable.

If forcibly interrupted, inspect the PID in `.cache/research/active.lock` before removing a stale research lock. Do not delete an active lock or terminate unrelated processes. The child host now shuts down on IPC disconnect as well as normal stop/signals, preventing an orphan if its driver exits or times out.

Replay or verify a completed suite, replacing the example path with its real UUID:

```sh
npm run research:analyze -- .cache/research/<suite-uuid>
npm run research:analyze -- .cache/research/<suite-uuid> --verify
```

Analysis reads the suite's copied raw evidence, independently checks all hashes and workload/source/compiled/environment identities, then cross-checks attempts, deterministic recipient IDs, provider observations and final outcomes. It recomputes latency distributions, throughput and aggregate counts. Missing trials, duplicates, altered CSV/NDJSON, failed/nonterminal outcomes and incompatible settings invalidate the result. Hashes detect changed content; they are not an authenticity signature. Use the recorded source commit when reproducing an earlier result.

## Files and figures

| Artifact | Contents |
| --- | --- |
| `inputs.json` | Plan, scenario order, source/compiled fingerprints, executions, UTC start/end timestamps |
| `raw/<experiment-id>/` | Copied Phase 6 summary, trial JSON, attempt/provider NDJSON, outcome CSV and driver log |
| `evidence.json` | Hashes for inputs and every copied raw file |
| `analysis.json` | Conditions, measured/warm-up samples, resource distributions and explicit limitations |
| `trials.csv`, `conditions.csv` | Per-trial values including warm-up flags, and per-condition descriptive statistics |
| `costs.csv` | Unmeasured monetary components with blank values and reasons |
| `report.md`, `analysis-files.json` | Readable results/limitations and hashes of derived files |
| `figures/` | Performance, resources and startup figures in PNG/SVG, plus plotting provenance |

Plotting is optional and separate from application/runtime dependencies. Use Python 3.10+ and an isolated environment:

```sh
python3 -m venv .cache/research-python
.cache/research-python/bin/python -m pip install -r tools/research/requirements.txt
.cache/research-python/bin/python tools/research/plot.py .cache/research/<suite-uuid>
```

Matplotlib is pinned; its resolved dependencies are recorded separately when preserving an experiment environment (for example, `pip freeze`). The plot manifest records the Python/Matplotlib versions, plot-script hash, analysis hash and figure hashes. Plotting verifies evidence/derived-file hashes before rendering. Figures show measured trial dots, nearest-rank medians and observed ranges, with no confidence-interval claim. The performance figure uses **per-trial** p95 values; the report's condition table uses **pooled delivery** p95 values, so they answer different questions. Resource figures use worker count two when available. Startup shows the sample counts explicitly.

## Interpret the results

Pipeline elapsed excludes seeding and startup, starts before submission and ends after final campaign refresh. Per-delivery end-to-end ends after the persisted outcome read. Queue wait includes remaining fan-out before dequeue. Provider-request time includes loopback HTTP and the requested delay. CPU includes seeding and processing; RSS values are snapshots, not peak memory. Adapter calls are not Cosmos RU.

Five repetitions describe the session; report medians, ranges and raw observations. Per-delivery samples in one trial are correlated. Pooled percentiles are recomputed from raw latencies rather than averaged from trial percentiles. Nearest-rank p50 selects the lower middle value for even-sized smoke samples. Do not infer statistical significance, production capacity or causality from these local results. Different audiences also change campaign count and adapter work.

Startup is one child readiness observation per reused scenario and five per fresh scenario. It is separate from processing elapsed, not an end-user latency measure, and is not compared as though the sample sizes matched. Warm-up removes the first workload trial from measured reused statistics but does not prove steady state.

No cloud usage/invoice, local electricity use or monetary rates are queried. Azure and local monetary values stay null/blank rather than zero. The suite provisions no Azure resources; that fact does not establish the user's overall account bill. A monetary break-even point, usage-based cost comparison, Azure cold/warm result and formal serverless conclusion are unavailable under the current constraints.

The next phase can prepare review/submission material from these local results while carrying forward the explicit browser/cloud gaps. Actual hosted/comparative claims require new evidence and an authorized billing approach compatible with the spending constraint.
