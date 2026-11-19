# Serverless Web Push Dashboard

A near-zero-cost Azure web push project for the dissertation. It includes browser subscription, persistent queued delivery, campaign drafts, tag targeting, scheduling, cancellation, recovery, and an administrator dashboard with separate acceptance, receipt, and click metrics. Azure adapters and Microsoft Entra authorization are prepared for future cloud verification.

Cloud deployment is disabled: the project has a strict INR 100 monthly ceiling, and Azure billing-triggered shutdown cannot guarantee that custom hard cap. Local development and local push tests use no Azure resources. The decision is recorded in [infra/deployment-policy.json](infra/deployment-policy.json).

## Start locally

The local candidate is `0.1.0-rc.4`. Use Node.js 24, or Node.js 22.19+. The recommended Azure runtime remains Node 24.

```sh
npm ci
npm run setup
npm run build
npm start
```

`npm start` serves the built dashboard and persistent queued backend without Vite. For editing with hot reload, use `npm run dev:queued` instead. To run the original direct-send Foundation profile, use:

```sh
npm run dev
```

Run only one backend at a time. Entry points lock the local data directory. The built and queued development profiles share subscribers; switching to or from the direct Foundation profile for the first time requires reconnecting because its subscriber store is separate.

Open [http://localhost:5173](http://localhost:5173) in a supported browser. Choose **Enable notifications**, allow the browser prompt, and wait for the connection badge to say **Connected**. Permission marked **Allowed** alone is not a saved subscription.

Use the page's **Send test notification** button, or another terminal:

```sh
npm run push:list
npm run push:send -- --latest
```

Send to a particular browser, optionally changing the text:

```sh
npm run push:send -- --id <subscription-id> --title "Foundation test" --body "Hello from the local service"
```

The sender chooses one subscription. It does not broadcast. In the Foundation profile it reports provider acceptance; in the queued profile it reports a queued campaign. Verify receipt separately in the browser. For a closed-tab check, subscribe first, close the tab, leave the browser running, then send from the terminal.

Stop both local services with `Ctrl+C` in the development terminal.

## Open the campaign dashboard

With the built service or queued development profile running, use another terminal:

```sh
npm run admin:login
```

Open its one-use sign-in link. The link expires in two minutes and creates a one-hour local administrator session. Restarting the API revokes sessions. The private CLI token stays on the backend.

The dashboard supports campaign editing and previews, tag/selected-browser targeting, scheduled sends, cancellation, subscriber tags, delivery reports, and persistent pause controls. [Phase 4](docs/phase-4.md) explains the workflow, reporting semantics, and verification limits. Local access uses its own session flow; Entra sign-in remains unprovisioned.

## Manage campaigns locally

With `npm run dev:queued` running, use `npm run campaigns -- subscribers` to find a browser, assign its `demo` tag, and preview the sample campaign:

```sh
npm run campaigns -- tags --id <subscriber-id> --tags demo
npm run campaigns -- preview --file examples/campaign.json
npm run campaigns -- create --file examples/campaign.json --key project-update-draft-001
```

Creating a draft sends nothing. Use the returned ID with `send`, `schedule`, `get`, or `cancel`. Read [the campaign workflow and commands](docs/phase-3.md) for scheduling, editing, deletion, targeting rules, and limits. These operations are also available in the dashboard.

## Local configuration

`npm run setup` generates a VAPID pair and a local CLI token in the ignored root `.env`. It preserves existing keys when run again and never prints private values. The template is [.env.example](.env.example).

Set `VAPID_SUBJECT` to your own real `mailto:` contact address before Safari testing or cloud deployment. The generated local configuration initially uses an example address. Keep keys stable: regenerating the VAPID pair requires browsers to reconnect.

The frontend obtains only the public key from `/api/config`. Private keys, CLI tokens, and subscription files stay outside the frontend build. `.data/subscriptions.json` persists Foundation registrations. The queued profile uses `.data/phase2-documents.json` and `.data/phase2-queues.json`, including persisted work and outcomes. All are ignored by Git. Browser ownership credentials are stored in that browser's local storage.

The development API binds to `127.0.0.1:8787`; Vite serves the page at `http://localhost:5173` and proxies `/api`. The API rejects foreign origins and non-loopback hosts. These development-only routes must not be deployed publicly.

The local origin must be HTTP on localhost or 127.0.0.1 with an explicit port different from `API_PORT`. The development runner follows this configuration. Project-local data stays inside ignored `.data`. Run `npm run doctor` for configuration, permission, lock, and data-format checks. After a crash, `npm run local:unlock` removes only verified stale ownership locks.

## Checks

```sh
npm run doctor
npm run validate:local
```

The build emits frontend files in `apps/dashboard/dist/` and compiled TypeScript in root `dist/`. Neither contains the root `.env`. `npm run package:cloud` builds a local ZIP containing the Azure HTTP, Service Bus, and recovery handlers. Packaging does not deploy anything.

The release check runs tests, builds, packaging, an isolated compiled-app HTTP flow with a controlled sender, credential scanning, and the disabled deployment-policy check. It writes `.cache/release/report.json`. On a clean committed checkout, `npm run release:package` creates a source/dashboard/cloud-package review ZIP and SHA-256 checksum in `.cache/releases/`.

`validate:local` includes that release check and a bounded synthetic baseline smoke. It emits validation/JUnit evidence in `.cache/validation/`. For repeated local measurements, use `npm run benchmark -- --audience 100 --repetitions 3 --warmup 1`. Read [Phase 6](docs/phase-6.md) for raw traces, metric definitions and pending browser/cloud checks. These timings use memory adapters and mock HTTP acceptance; they do not establish serverless performance or cloud costs.

For the recorded local experiment matrix, use `npm run research:run` from a clean committed checkout. It compares audiences 10/100/1,000, workers 1/2/4 and fresh/reused processes with five measured repetitions. Reports, verified raw evidence and CSV exports go to `.cache/research/<suite-uuid>/`. [Phase 7](docs/phase-7.md) explains replay, optional PNG/SVG figures and the limits of local timing and unmeasured costs.

[Phase 8](docs/phase-8.md) prepares the academic review package. Read [the review report and evidence index](docs/review/README.md), then use `npm run review:check` for public consistency checks. The editable Word draft is generated locally from the private outline; cloud/browser/scale gaps and academic approval remain explicit.

Use `npm start -- --paused` to inspect restored work before resuming. Read [the operations runbook](docs/operations.md) for shutdown, stale locks, backups, and recovery, and [Phase 5](docs/phase-5.md) for candidate checks, CI scope, and remaining verification.

The tests cover subscription ownership, hostile endpoint rejection, persistence, registration races, expired endpoints, send limits, fallback notifications, and safe notification clicks. The API integration tests use a fake sender; a real-browser push check remains a separate verification step.

## Local demonstration limits

- Up to 100 registered browsers.
- Foundation profile: five send attempts per minute, shared by the page and CLI.
- Queued profile: 100 new campaigns (including drafts and tests) and 1,000 delivery attempt reservations per UTC day; each delivery has at most five attempts.
- Browser tests target one browser. Managed campaigns support up to 100 frozen recipients, expanded in pages of 25. Provider TTL is five minutes with a ten-second network inactivity timeout.
- Local file stores owned by one API process. The Azure Cosmos DB and Service Bus adapters are implemented; live Azure verification is deferred while cloud deployment is disabled.
- No Azure resources or paid hosting are needed to run this Foundation.

The public page's activity feed records events observed in that page session. The administrator dashboard reads persistent campaign outcomes and deduplicated browser observations. Provider acceptance, browser receipt, and clicks are separate measurements. Read [Phase 4 verification](docs/phase-4.md) and [Foundation limits](docs/foundation.md) for the evidence and remaining checks.

## Project documents

- [Architecture](docs/architecture.md)
- [Implementation plan](docs/implementation-plan.md)
- [Foundation setup and verification](docs/foundation.md)
- [Phase 2 implementation and verification](docs/phase-2.md)
- [Phase 3 campaigns and reliable sending](docs/phase-3.md)
- [Phase 4 dashboard, access, and analytics](docs/phase-4.md)
- [Phase 5 local release candidate](docs/phase-5.md)
- [Phase 6 validation and local benchmark](docs/phase-6.md)
- [Phase 7 local experiments and analysis](docs/phase-7.md)
- [Phase 8 academic review preparation](docs/phase-8.md)
- [Local operations runbook](docs/operations.md)
- [Foundation API contract](docs/api.md)
