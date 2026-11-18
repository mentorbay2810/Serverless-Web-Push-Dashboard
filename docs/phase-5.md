# Phase 5: Local release candidate

The candidate version is `0.1.0-rc.1`. This phase adds a built-application entry point, stricter private configuration validation, single-owner local data locks, graceful shutdown, paused recovery startup, repeatable release checks, source/artifact fingerprints, and a review bundle. Cloud deployment and Azure deployment automation remain off under the strict INR 100 decision.

This is a local candidate. A passing local check does not establish live Azure behavior, real Entra integration, visual UI quality, or broad cross-browser support. Those remaining checks are listed in the generated report and earlier phase notes.

## Run the built application

From a Git checkout on Node 22.19+ or the recommended Node 24:

```sh
npm ci
npm run setup
npm run doctor
npm run build
npm start
```

Open the configured `WEB_ORIGIN`, normally `http://localhost:5173`. In another terminal run `npm run admin:login` and open its one-use link. The built service uses the same subscribers and queues as `npm run dev:queued`; switching between these two does not require reconnecting a browser. Stop one service before starting another. `npm run dev` retains the separate direct Foundation profile.

The built frontend serves only build files and extensionless SPA routes. API requests use the same local handler through the frontend origin; the CLI can still reach the API port. Private dot paths, JSON/configuration files, missing asset files, escaped symlinks, foreign hosts/origins, and oversized request bodies are rejected. HTML and the service worker are not cached; hashed assets use immutable caching.

## Configuration and ownership

Setup parses quoted environment values, preserves valid existing keys and unrelated settings, writes missing generated values atomically, and restricts `.env` permissions. It rejects incomplete or mismatched VAPID pairs instead of silently replacing them. A setup lock prevents concurrent key generation.

Local origins must be HTTP on `localhost` or `127.0.0.1`, with an explicit port from 1024–65535 distinct from `API_PORT`. The Vite runner follows the configured origin and port. Project-local data must remain inside ignored `.data`; an explicitly chosen private directory outside the checkout is also supported. Keep `VITE_API_ORIGIN` empty for a local candidate.

Every local backend entry point acquires `backend.lock` before opening the data store. A second backend cannot share that directory, even on different ports. Failed startup closes listeners and releases its lock. Graceful shutdown stops workers/recovery, closes servers, and releases ownership. A crash can leave a lock: after stopping services, `npm run local:unlock` removes only locks whose recorded process is no longer alive. It refuses live or unreadable ownership records.

`npm run doctor` validates the key pair, token format, origin/ports, private file permissions, data-file readability, lock state, and build presence. It reports record/dead-letter counts without printing endpoints, subscription keys, or credentials. See [the operations runbook](operations.md) for recovery and backups.

## Repeatable verification

```sh
npm run release:check
```

The command performs preflight, the complete test suite, TypeScript/frontend/server builds, local Functions packaging, a smoke check against the compiled backend and built frontend, credential/artifact checks, and validation of the disabled deployment policy. It refuses a remote frontend API origin. If source bytes change during a run, the check fails.

The smoke check uses disposable storage, fresh test credentials, loopback ports, and an injected controlled sender. Its receipt/click requests are synthetic and confined to that disposable store. It covers built routes/assets, private path rejection, one-use sign-in, pause/resume, reviewed activation, delivery through both local queues, deduplicated observations, restart persistence, and session revocation. It does not contact Azure or real push services and does not touch the demonstration's `.data`.

The result is `.cache/release/report.json`, with test counts, Node version, source tree SHA-256, artifact SHA-256 values, check scope, and remaining verification. Ignored per-step logs are in the same directory. A failed run removes its earlier success report so an old pass cannot be reused accidentally.

The development-time real-browser evidence remains separate. During this phase, a real notification sent through `npm start` received provider HTTP 201 on its first attempt, and the saved campaign report showed targeted 1, accepted 1, received 1, clicked 0. This establishes the built local server's provider/receipt path; it does not establish real clicking or visual inspection.

## Freeze a review bundle

Commit the intended source changes, then use a successful release report for those exact bytes:

```sh
npm run release:package
```

Packaging refuses a dirty source checkout or mismatched source/build fingerprints. It verifies copied content again and creates:

```text
.cache/releases/webpush-0.1.0-rc.1.zip
.cache/releases/webpush-0.1.0-rc.1.zip.sha256
```

The ZIP contains public `source/`, the built `dashboard/`, a review-only `azure-functions.zip`, and `RELEASE.json`. Private environment/state files, `.git`, and installed source dependencies are excluded. The manifest records the packaging commit and the exact source tree hash covered by the checks. It is a local integrity record, not a signed attestation.

For a clean reproduction, clone the candidate branch into a new directory, then run `npm ci`, `npm run setup`, and `npm run release:check`. Do not copy the existing `.env`, `.data`, `node_modules`, or build directories. A bundle's extracted `source/` can run the app after installation/build, but Git-based fingerprinting commands require a Git checkout.

Verify the ZIP checksum from its containing directory using `shasum -a 256 -c webpush-0.1.0-rc.1.zip.sha256` on macOS, or `sha256sum -c` on Linux. Packaging is not deployment or publication.

## Test-only continuous integration

The workflow uses standard public GitHub-hosted Ubuntu runners, read-only repository permissions, immutable official action pins, and Node 22.19/24 jobs. It installs from the lockfile, generates fresh local test credentials, runs the release check, and audits production dependencies. It has no Azure identity, deployment step, artifact upload, or dependency cache. Private repositories skip the jobs. GitHub documents included standard-runner usage for public repositories in [Actions billing and usage](https://docs.github.com/en/actions/concepts/billing-and-usage).

## Known limits

- The full dependency audit reports four high development-tool findings through picomatch 4.0.7. The [reviewed advisory](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) lists no patched version; the registry's latest version was also 4.0.7 when checked. The suggested Vite downgrade was not applied. The built entry point does not run Vite. This remains an open development dependency issue; the production audit is checked separately.
- The local JSON adapters remain single-process stores with manual retention. Local locks do not change Azure's concurrency semantics.
- Browser interaction/viewport QA, real notification clicks, broader cross-browser trials, and all live Azure/Entra checks remain unverified. Historical provider/receipt evidence is not substituted for those checks.
- Budgets and pause controls are not monetary hard caps. No billable project cloud infrastructure is created by these commands; independent Azure commands remain outside this local release gate.

Next comes broader functional/security validation and a controlled benchmark harness, with cloud experiments deferred until a compatible billing approach is authorized.
