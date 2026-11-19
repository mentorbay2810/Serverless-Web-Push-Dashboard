# Phase 4: Campaign dashboard and analytics

[Phase 5](phase-5.md) subsequently adds the built local server, startup/data ownership safeguards, paused recovery startup, and reproducible candidate checks. The dashboard also runs with `npm start` after a build.

The administrator dashboard now manages campaign drafts, notification previews, tag or selected-browser audiences, immediate and scheduled sending, cancellation, subscriber tags, delivery details, and persistent pause controls. Reports show provider acceptance, browser receipts, and clicks separately.

The project remains local under the strict INR 100 budget decision. No Azure or Entra resources were created and no publishing or deployment workflow was added. [Deployment policy](../infra/deployment-policy.json) remains disabled.

## Open the dashboard

Use two terminals in the project directory. In the first:

```sh
npm run dev:queued
```

In the second:

```sh
npm run admin:login
```

Open the printed link. It leads to `http://localhost:5173/admin` with a one-use code in its fragment. The browser removes the fragment immediately, exchanges the code, and stores a separate session credential in session storage. The sign-in page also supports manually entering the code from the link.

The link expires after two minutes, the session after one hour. Signing out revokes the session. Restarting the API revokes every local code and session; generate a fresh link afterward. The long-lived local CLI token stays in the ignored backend environment file and is never sent to the frontend. The direct Foundation profile (`npm run dev`) does not enable this workspace.

Keep `VITE_API_ORIGIN` empty for local use so browser requests use Vite's same-origin proxy. Local management accepts the configured loopback hosts and rejects foreign origins. Browser sessions can call management routes and sign out; they cannot mint more sign-in links or use CLI-only routes. The public local `/api/admin/` routes remain disabled. Cloud handlers expose no local-session routes and retain Entra access-token validation.

## Campaign workflow

1. Connect a browser on the public page if no saved subscriber exists.
2. In **Subscribers**, choose **Edit tags** to organize a browser. Tags support the same limits as the CLI.
3. In **Campaigns**, choose **New campaign**. Enter its internal name, notification title, message, and same-site destination path. The notification preview updates as you type.
4. Choose matching tags, selected browsers, or all active subscribers. Preview the audience, then save the draft. Saving sends nothing.
5. Review an immediate send, or choose a time in the displayed browser timezone and review the schedule. Schedules must fall within seven days and are saved as UTC.
6. Confirm the recipient count and send time. Activation checks the reviewed draft version and audience fingerprint. A changed draft or recipient set requires another review instead of silently changing the send.
7. Select the campaign to inspect its report. Reports for activated campaigns refresh every ten seconds while visible. The refresh button also reloads subscribers, controls, and campaign lists.

The audience is frozen on activation. Content and recipients then become read-only. Cancel stops future work but cannot recall notifications already in flight or accepted. Draft deletion and conflicting edits retain ETag preconditions. Navigation asks before discarding an unsaved draft. Campaign lists load in pages and label the number currently shown.

## What the report measures

| Metric | Meaning |
| --- | --- |
| Targeted browsers | Frozen recipient count at activation. |
| Provider accepted | Unique deliveries with a successful push-provider response. This does not establish browser display. |
| Browser receipts | Unique deliveries whose service worker reported after `showNotification` succeeded. This does not prove that a person saw or read the notification. |
| Notification clicks | Unique deliveries with a notification-click report. A click does not prove the content was read. |

Receipt and click reporting is best effort. A click can be recorded even if a receipt report was lost. Missing reports do not establish delivery failure. Old deliveries created before observation reporting was added show no receipt or click data; the dashboard does not fabricate historical observations.

The outcome breakdown and delivery table show queued or pending work, processing, acceptance, failures, expired endpoints, and cancellation separately. Each recipient row includes attempt reservations, safe provider status/reason, next attempt time where relevant, and observation timestamps. The issue filter shows failed and expired deliveries. All displayed dates use the timezone named in the workspace footer.

Reports derive counts from unique delivery records for the bounded audience of at most 100. There is no shared per-event campaign counter that could double-count retries. This implementation does not establish performance for a 100,000-subscriber audience.

## Observation protocol

Encrypted queued push payloads include a reporting URL and a delivery-scoped capability. The backend derives the capability using a versioned HMAC with the private VAPID key, website ID, delivery ID, and saved observation expiry. Capabilities are valid for seven days from fan-out. Rotating the VAPID key invalidates outstanding observation credentials as well as affecting browser subscriptions.

The service worker reports `received` only after notification creation succeeds. It reports `clicked` separately on notification interaction. Requests omit browser cookies, reject redirects, and use a five-second timeout. Reporting failure does not prevent display or safe same-site navigation. The worker permits only the frontend origin or the API origin pinned when it is registered, with the exact delivery event path.

The API validates the capability, origin, delivery, expiry, and event type. The first server timestamp for each delivery/event pair is stored with a conditional write. Concurrent duplicates return success without incrementing any count. Observation updates preserve delivery leases and send outcomes, including when a receipt arrives before the provider request finishes.

For a future authorized Azure deployment, the reporting origin defaults to `https://WEBSITE_HOSTNAME`. Set `PUBLIC_API_ORIGIN` to the externally used API origin when using a custom domain, and align it with the frontend's `VITE_API_ORIGIN`. Public configuration and administrator reports contain no observation capabilities, ownership hashes, push endpoints, or encryption keys.

## Pause controls

**Delivery controls** independently pause campaign expansion and notification sending. State is persisted in the document store and survives API restarts. Pausing expansion retains schedules and pending fan-out; pausing sending retains delivery jobs. Resume lets recovery republish retained work. Recovery may wait for its next minute tick or an abandoned two-minute lease.

Version guards serialize pause changes with dispatch-page commits and send claims. A pause that wins before a claim or page commits prevents that work. An already acquired/in-flight request may finish. A reservation acquired just before a pause can consume an attempt allowance even if the final pre-send check postpones the request.

These controls are application controls, not an Azure monetary spending stop. Cloud deployment stays off. Existing subscriber, campaign, attempt, and retry limits remain documented in [Phase 3](phase-3.md).

## API additions

| Route | Access and behavior |
| --- | --- |
| `POST /api/local/session` | CLI token only; issue a one-use sign-in link. |
| `POST /api/local/session/exchange` | One-use code; return a separate browser session. |
| `POST /api/local/session/logout` | Revoke that browser session. |
| `GET /api/admin/operations` | Administrator; pause state and ETag. |
| `PATCH /api/admin/operations` | Administrator and `If-Match`; body includes both `dispatchPaused` and `sendingPaused`. |
| `GET /api/admin/campaigns/:id` | Adds metrics, safe delivery rows, observation timestamps, and `reportedAt`. |
| `POST /api/admin/campaigns/:id/preview` | Adds audience fingerprint and draft ETag. |
| `POST /api/admin/campaigns/:id/send` or `/schedule` | Accepts a preview `fingerprint` and `If-Match` to guard reviewed activation. Existing CLI activation remains supported. |
| `POST /api/deliveries/:id/events` | Delivery capability in `Authorization: Bearer …`; JSON `{"type":"received"}` or `{"type":"clicked"}`. |

Local administrator calls use `/api/local/manage/` in place of `/api/admin/`. Microsoft sign-in loads only when Entra is configured; the local sign-in flow does not impersonate Entra authentication.

## Verification and remaining checks

All **68 tests**, TypeScript checks, frontend/server builds, and local Functions packaging passed. Tests cover one-use/expired/revoked sessions, session scopes, event authentication and expiry, concurrent deduplication, observation/send races, persisted reports and pauses, pause/dispatch races, reviewed audience changes, dashboard validation, and service-worker reporting and navigation behavior. Service-worker unit checks use a controlled VM and are separate from real browser delivery.

The live local HTTP check served the administrator page and transformed workspace module with HTTP 200, exercised sign-in and code replay rejection, verified browser sessions cannot mint links, paused/resumed work, created and reviewed a one-recipient campaign, sent it, retrieved its report, and revoked the session on logout. On 18 November 2026 at approximately 14:01 UTC, the real provider returned HTTP 201 on the first attempt and a real browser receipt was recorded. The saved report showed targeted 1, accepted 1, received 1, clicked 0. No synthetic observation was posted to the real local database.

Browser controls were unavailable for automated UI interactions, viewport inspection, and screenshots. A preview-open request was queued in the app; this is not visual QA evidence. Real notification clicking and OS appearance were not directly inspected. Live Azure triggers, Cosmos behavior, managed identity, and project Entra sign-in remain deferred while cloud deployment is off. No new dependencies were added. Local retention is still manual; the JSON adapters do not simulate cloud TTL deletion.
