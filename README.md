# Serverless Web Push Dashboard

A near-zero-cost Azure web push project for the dissertation. The Foundation provides a local subscriber page, a push-only service worker, private VAPID configuration, subscription ownership, and a command-line test sender.

## Start locally

Use Node.js 24, or Node.js 22.19+ for this local Foundation. Node 22.19 was used for the initial checks. The recommended Azure runtime remains Node 24.

```sh
npm ci
npm run setup
npm run dev
```

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

The sender chooses one subscription. It does not broadcast. A successful command reports push-service acceptance; verify actual display on the device separately. For a closed-tab check, subscribe first, close the tab, leave the browser running, then send from the terminal.

Stop both local services with `Ctrl+C` in the development terminal.

## Local configuration

`npm run setup` generates a VAPID pair and a local CLI token in the ignored root `.env`. It preserves existing keys when run again and never prints private values. The template is [.env.example](.env.example).

Set `VAPID_SUBJECT` to your own real `mailto:` contact address before Safari testing or cloud deployment. The generated local configuration initially uses an example address. Keep keys stable: regenerating the VAPID pair requires browsers to reconnect.

The frontend obtains only the public key from `/api/config`. Private keys, CLI tokens, and subscription files stay outside the frontend build. `.data/subscriptions.json` persists local registrations across API restarts and is ignored by Git. Browser ownership credentials are stored in that browser's local storage.

The development API binds to `127.0.0.1:8787`; Vite serves the page at `http://localhost:5173` and proxies `/api`. The API rejects foreign origins and non-loopback hosts. These development-only routes must not be deployed publicly.

If changing `API_PORT`, use `npm run dev` so the frontend proxy receives the matching port. The documented frontend origin and Vite's fixed port should remain aligned.

## Checks

```sh
npm run typecheck
npm test
npm run build
npm run check:cloud
```

The build emits frontend files in `apps/dashboard/dist/` and compiled TypeScript in root `dist/`. Neither contains the root `.env`. The Azure health handler is a v4 SDK scaffold; Azure packaging, persistent cloud storage, Entra authorization, and queue triggers belong to milestone 2.

The tests cover subscription ownership, hostile endpoint rejection, persistence, registration races, expired endpoints, send limits, fallback notifications, and safe notification clicks. The API integration tests use a fake sender; a real-browser push check remains a separate verification step.

## Local demonstration limits

- Up to 100 registered browsers.
- Five send attempts per minute, shared by the page and CLI.
- One browser per test; a five-minute provider TTL and a ten-second network inactivity timeout.
- A local file store owned by one API process. Cosmos DB and Service Bus adapters are planned for milestone 2.
- No Azure resources or paid hosting are needed to run this Foundation.

The frontend's activity feed records actual events observed in the current page session. It is not persistent campaign analytics. Read [Foundation verification and known limits](docs/foundation.md) for browser requirements, dependency notes, and cloud preflight.

## Project documents

- [Architecture](docs/architecture.md)
- [Implementation plan](docs/implementation-plan.md)
- [Foundation setup and verification](docs/foundation.md)
- [Foundation API contract](docs/api.md)
