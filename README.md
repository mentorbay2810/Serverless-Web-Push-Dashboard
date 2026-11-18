# Serverless Web Push Dashboard

A near-zero-cost Azure web push project for the dissertation. The Foundation provides browser subscription and direct test sends. Phase 2 adds persistent queued delivery, recovery, Azure storage and messaging adapters, and Microsoft Entra authorization. Phase 3 adds campaign drafts, tags, schedules, cancellation, and resumable fan-out through the API and local management CLI.

Cloud deployment is disabled: the project has a strict INR 100 monthly ceiling, and Azure billing-triggered shutdown cannot guarantee that custom hard cap. Local development and local push tests use no Azure resources. The decision is recorded in [infra/deployment-policy.json](infra/deployment-policy.json).

## Start locally

Use Node.js 24, or Node.js 22.19+ for this local Foundation. Node 22.19 was used for the initial checks. The recommended Azure runtime remains Node 24.

```sh
npm ci
npm run setup
npm run dev
```

To run Phase 2's persistent campaign queue and delivery queue, use this instead of `npm run dev`:

```sh
npm run dev:queued
```

Run only one profile at a time. Both use the same local ports. When switching between profiles for the first time, reconnect the browser because their subscriber stores are separate.

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

## Manage campaigns locally

With `npm run dev:queued` running, use `npm run campaigns -- subscribers` to find a browser, assign its `demo` tag, and preview the sample campaign:

```sh
npm run campaigns -- tags --id <subscriber-id> --tags demo
npm run campaigns -- preview --file examples/campaign.json
npm run campaigns -- create --file examples/campaign.json --key project-update-draft-001
```

Creating a draft sends nothing. Use the returned ID with `send`, `schedule`, `get`, or `cancel`. Read [the campaign workflow and commands](docs/phase-3.md) for scheduling, editing, deletion, targeting rules, and limits. The campaign editor and analytics screens remain the next milestone.

## Local configuration

`npm run setup` generates a VAPID pair and a local CLI token in the ignored root `.env`. It preserves existing keys when run again and never prints private values. The template is [.env.example](.env.example).

Set `VAPID_SUBJECT` to your own real `mailto:` contact address before Safari testing or cloud deployment. The generated local configuration initially uses an example address. Keep keys stable: regenerating the VAPID pair requires browsers to reconnect.

The frontend obtains only the public key from `/api/config`. Private keys, CLI tokens, and subscription files stay outside the frontend build. `.data/subscriptions.json` persists Foundation registrations. The queued profile uses `.data/phase2-documents.json` and `.data/phase2-queues.json`, including persisted work and outcomes. All are ignored by Git. Browser ownership credentials are stored in that browser's local storage.

The development API binds to `127.0.0.1:8787`; Vite serves the page at `http://localhost:5173` and proxies `/api`. The API rejects foreign origins and non-loopback hosts. These development-only routes must not be deployed publicly.

If changing `API_PORT`, use `npm run dev` so the frontend proxy receives the matching port. The documented frontend origin and Vite's fixed port should remain aligned.

## Checks

```sh
npm run typecheck
npm test
npm run build
npm run check:cloud
```

The build emits frontend files in `apps/dashboard/dist/` and compiled TypeScript in root `dist/`. Neither contains the root `.env`. `npm run package:cloud` builds a local ZIP containing the Azure HTTP, Service Bus, and recovery handlers. Packaging does not deploy anything.

The tests cover subscription ownership, hostile endpoint rejection, persistence, registration races, expired endpoints, send limits, fallback notifications, and safe notification clicks. The API integration tests use a fake sender; a real-browser push check remains a separate verification step.

## Local demonstration limits

- Up to 100 registered browsers.
- Foundation profile: five send attempts per minute, shared by the page and CLI.
- Queued profile: 100 new campaigns (including drafts and tests) and 1,000 delivery attempt reservations per UTC day; each delivery has at most five attempts.
- Browser tests target one browser. Managed campaigns support up to 100 frozen recipients, expanded in pages of 25. Provider TTL is five minutes with a ten-second network inactivity timeout.
- Local file stores owned by one API process. The Azure Cosmos DB and Service Bus adapters are implemented; live Azure verification is deferred while cloud deployment is disabled.
- No Azure resources or paid hosting are needed to run this Foundation.

The frontend's activity feed records actual events observed in the current page session. It is not persistent campaign analytics. Read [Foundation verification and known limits](docs/foundation.md) for browser requirements, dependency notes, and cloud preflight.

## Project documents

- [Architecture](docs/architecture.md)
- [Implementation plan](docs/implementation-plan.md)
- [Foundation setup and verification](docs/foundation.md)
- [Phase 2 implementation and verification](docs/phase-2.md)
- [Phase 3 campaigns and reliable sending](docs/phase-3.md)
- [Foundation API contract](docs/api.md)
