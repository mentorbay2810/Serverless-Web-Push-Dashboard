# Phase 3: Campaigns and reliable sending

This records the Phase 3 handoff. [Phase 4](phase-4.md) adds the campaign editor, local browser administrator sessions, persistent receipt/click observations, delivery reports, and pause controls.

Phase 3 adds campaign drafts, tag targeting, immediate and scheduled sending, cancellation, paginated fan-out, and final campaign outcomes. The API and local CLI are implemented. The campaign editor, schedule controls, and analytics screens remain milestone 4 work.

The strict INR 100 budget decision remains in force: cloud deployment is off, no Azure or Entra resources were created, and no deployment workflow was added. Local files exercise the pipeline; they do not validate Azure behavior. See [the deployment policy](../infra/deployment-policy.json).

## Local workflow

Start `npm run dev:queued` and keep it running while using the management commands in another terminal. The direct Foundation profile does not provide these commands. Open `http://localhost:5173` and connect a browser if no saved subscription exists.

```sh
npm run campaigns -- subscribers
npm run campaigns -- tags --id <subscriber-id> --tags demo
npm run campaigns -- preview --file examples/campaign.json
npm run campaigns -- create --file examples/campaign.json --key project-update-draft-001
```

The example targets the `demo` tag. Preview reports actual matching IDs and count without sending. Creating a draft also sends nothing. Copy the returned campaign ID for the next commands:

```sh
npm run campaigns -- get --id <campaign-id>
npm run campaigns -- update --id <campaign-id> --file examples/campaign.json
npm run campaigns -- preview --id <campaign-id>
npm run campaigns -- send --id <campaign-id> --key project-update-send-001
```

To schedule instead of sending immediately, start with a draft and use:

```sh
npm run campaigns -- schedule --id <campaign-id> --at <ISO-time-with-timezone> --key project-update-schedule-001
```

Choose a future time within seven days. Include `Z` for UTC or an explicit timezone offset such as `+05:30`. Times without a timezone are rejected. Stored times are normalized to UTC. A schedule can run late during downtime or a recovery backlog; it cannot run before its saved time. The local scheduler checks every minute while the API is running.

```sh
npm run campaigns -- list
npm run campaigns -- list --state scheduled
npm run campaigns -- cancel --id <campaign-id>
npm run campaigns -- delete --id <draft-id>
```

Lists return one page and an optional cursor. Supply `--cursor <cursor>` for another page. Campaign pages contain up to 25 records; subscriber pages contain up to 50. Use `--tags ""` to clear a subscriber's tags. The CLI reads the current ETag before an edit or deletion and sends it in `If-Match`; a conflicting update requires a retry after reviewing the record.

For create, send, and schedule, reuse the same `--key` when retrying the same operation. The CLI generates and prints a key if omitted. Reusing a creation key with different input is rejected; retrying an activation with the same key and time returns the existing campaign.

## Targeting and state

A draft JSON file contains `name`, `content` (`title`, `body`, and a same-site `url`), and one audience definition:

| Audience | Definition |
| --- | --- |
| All active subscribers | `{"type":"all"}` |
| Subscribers with every listed tag | `{"type":"tags","tags":["demo","updates"]}` |
| Explicit selection | `{"type":"selected","subscriptionIds":["<64-character-id>"]}` |

Tags are normalized to lowercase, deduplicated, and sorted. Each subscriber has at most ten tags of 1–32 letters, digits, underscores, or hyphens. Preview excludes subscriptions with a known elapsed expiration. Missing or expired selected IDs produce a conflict instead of silently reducing the audience.

Membership is **snapshotted when a draft is sent or scheduled**. Future tag changes and new registrations do not change that campaign. Workers still check whether a saved subscription exists and is unexpired before sending. An empty audience cannot be activated.

Drafts can be read, replaced, or deleted. Activation makes content and recipient IDs immutable. A campaign progresses through `draft`, `scheduled` (when applicable), `pending`, `queued`, `dispatching`, and `sending`. Dispatch returns to `pending` between fan-out pages. Once all frozen recipients have terminal delivery outcomes, the campaign becomes `completed` if every provider accepted, or `completed_with_failures` otherwise.

Cancellation is idempotent and stops new fan-out and future send claims. Queued deliveries become cancelled when consumed or recovered. Notifications already in flight or accepted by a push provider cannot be recalled; their actual accepted outcome is retained. Completed campaigns cannot be cancelled. Provider acceptance is separate from browser receipt, display, or clicks.

## Recovery and limits

- Fan-out handles at most 25 recipients per invocation. Delivery records and the next recipient index commit in one transaction, guarded by the campaign lease/version. Overlapping workers cannot commit the same page twice.
- Deterministic delivery IDs preserve deduplication across repeated queue messages. A two-minute dispatch lease recovers a worker that stops before a page commits.
- A committed page whose queue publication fails leaves pending jobs for recovery. A missing next-page message recovers from the saved campaign checkpoint.
- Recovery scans at most 100 active campaigns and 100 active deliveries per invocation, then saves continuation cursors. Local adapters use stable ID-based pagination; the Azure adapter retains Cosmos continuation tokens. Later local pages are reached even if earlier records change state.
- Cancellation and send claims share a transaction guard. Cancellation that commits before a claim wins prevents the provider request. A later cancellation cannot revoke an in-flight request.
- Existing limits remain: 100 stored subscribers, 100 new campaigns per UTC day (including drafts and browser tests), 1,000 reserved delivery attempts per UTC day, and five attempts per delivery. Retries consume the shared attempt allowance.
- Provider `Retry-After` seconds or dates extend exponential backoff. A requested delay beyond 24 hours fails the bounded demo job rather than retrying early. See [RFC 9110, section 10.2.3](https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after).

The design remains at least once. A crash after provider acceptance can leave an ambiguous outcome and cause a duplicate on recovery. The maximum frozen audience is 100; pagination does not establish 100,000-subscriber performance. Local JSON files remain single-process adapters with manual retention. Cloud records have TTLs; local files do not simulate TTL deletion.

## API

Cloud routes require an Entra administrator API access token. The local CLI uses the same handlers through `/api/local/manage/` instead of `/api/admin/`, with the private CLI token, loopback-host validation, and origin checks. Public local `/api/admin/` access stays disabled; the cloud API has no local-token route.

| Method and path | Behavior |
| --- | --- |
| `GET /api/admin/subscriptions/:id` | Safe subscriber summary and ETag. |
| `PATCH /api/admin/subscriptions/:id/tags` | Replace tags; body `{"tags":[...]}`; requires `If-Match`. |
| `POST /api/admin/segments/preview` | Resolve body `{"audience":...}` without sending. |
| `POST /api/admin/campaigns` | Create a draft; requires `Idempotency-Key`. |
| `GET /api/admin/campaigns` | Paginated list; optional `state` and `cursor`. |
| `GET /api/admin/campaigns/:id` | Content, state, dispatch progress, outcome counts, and ETag. |
| `PATCH /api/admin/campaigns/:id` | Replace the complete draft definition; requires `If-Match`. |
| `DELETE /api/admin/campaigns/:id` | Delete a draft; requires `If-Match`; returns 204. |
| `POST /api/admin/campaigns/:id/preview` | Current draft audience or frozen activated audience. |
| `POST /api/admin/campaigns/:id/send` | Activate immediately; requires `Idempotency-Key`; returns 202. |
| `POST /api/admin/campaigns/:id/schedule` | Body `{"scheduledAt":"..."}`; requires `Idempotency-Key`; returns 202. |
| `POST /api/admin/campaigns/:id/cancel` | Stop future dispatch and attempts. |

Send the exact response ETag in `If-Match`. A missing precondition returns 428; a stale version returns 412. CORS permits PATCH and the required headers and exposes ETag to the configured frontend origin. Summaries exclude push endpoints, encryption keys, ownership hashes, and private tokens.

## Verification

All 51 tests, TypeScript checks, frontend/server builds, and local Functions packaging passed. Tests cover UTC boundaries, timezone conversion, immutable targeting, version conflicts, concurrent schedulers, cancellation races, in-flight acceptance, 60-recipient expansion, failed publication, expired dispatch leases, retry delays, and persistent recovery beyond the first 100 records.

The real CLI check tagged the existing test browser, previewed a one-recipient segment, created and scheduled a draft, restored the browser's original tags, and restarted the API. The saved schedule remained intact. The campaign was due at 13:08:51 UTC on 18 November 2026 and completed after restart at 13:10:36 UTC with one attempt, provider HTTP 201, one accepted outcome, and empty queues. This verifies the running local scheduler and persisted audience; operating-system display and browser receipt were not reverified.

Live Cosmos, Service Bus, managed identity, and project Entra sign-in remain unverified while deployment is off. No dependencies were added in this phase. The next milestone is the campaign editor, scheduling interface, and analytics with separate acceptance, receipt, and click counts.
