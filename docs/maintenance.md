# Post-review local maintenance

Recorded 19 November 2026 (Asia/Kolkata), candidate `0.1.0-rc.5`. This work follows the eight planned local phases. Cloud deployment remains disabled under the strict INR 100 decision; it adds no hosting or Azure resources.

## Dependency audit

`npm audit --json` completed with exit code 0 against the rc.5 lockfile, including production and development dependencies. All severity counters are zero across 254 total dependencies. The [unmodified JSON response](maintenance/dependency-audit-2026-11-19.json) contains the audit result and dependency counts.

| Evidence | SHA-256 |
| --- | --- |
| `package-lock.json` | `cee9cfa01fd9f52344b088bb2c1dbeb4a98ee5dc6db2ced764d25cd27ade269c` |
| Audit JSON | `0b611fcb36ae264325a6e5efe33be804c8de8a5c36ee6d684061b19a31096861` |

The earlier review recorded development advisories involving picomatch. [GitHub's advisory record](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) now marks that advisory withdrawn on 18 November 2026 and still lists no patched version. Dependencies were not upgraded in this maintenance change: the fresh registry result reflects the current advisory data, without establishing a code fix. The lockfile changes only its root candidate version. Audit results are time-specific and should be repeated before release.

CI now runs `npm audit --audit-level=high` across the complete dependency graph on both Node versions. Audit failures fail the job; there is no advisory exemption or ignored exit status. The existing public-runner-only, read-only workflow and disabled deployment policy remain in effect.

## Retention and recovery rehearsal

`npm run local:retention` previews old terminal queued history. Apply requires the exact fresh preview, locks the store, creates a private durable recovery backup, and atomically replaces only the document file. Minimal archive identities block old creation retries. Undo requires unchanged post-retention document/queue bytes. [The operations runbook](operations.md#retain-terminal-history-offline) documents selection rules, commands, recovery and backup limits.

Thirteen new tests exercise real filesystem fixtures: preview preservation, atomic apply and byte-exact undo, archived-key refusal, active/recent work, capabilities and leases, queue/dead-letter references including missing children, cancelled/failed groups, orphan preservation, source drift, damaged backups, plan expiry/tampering, corrupt formats, active/stale locks, private permissions, links, backup failure, repeat apply, and absent queues. These are local adapter checks; they provide no cloud or browser evidence.

The complete local validation passed 109 tests, with matching TAP and JUnit counts, type checks/build, the compiled HTTP smoke, cloud ZIP packaging, credential/artifact scanning, the disabled-budget policy check, and a 20-recipient synthetic baseline smoke. Fresh validation binds its own source and raw evidence under ignored `.cache/validation/`; it does not replace the frozen Phase 7 study.

A preview against the existing private local store found zero eligible campaigns and deliveries at the 30-day cutoff. Preview was the only retention command run on that store. Apply/undo were exercised exclusively on disposable test data. The actual application's history, subscriptions and queues were preserved. Private plans and backups are ignored by Git.

## Remaining work

G06 is partially addressed. An operator still needs to set and record a policy for disposing of private backup copies and record future operational use. No scheduled cleanup or erasure of backup copies is claimed. The [gap register](review/gaps.csv) continues to track browser/OS and dashboard interaction evidence, larger/cloud trials, literature review and academic decisions. The original research data, Word draft and rc.4 review archive remain unchanged historical artifacts.
