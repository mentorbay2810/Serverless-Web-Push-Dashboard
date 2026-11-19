# Phase 2 Durable Backend and Access

This records the Phase 2 handoff. [Phase 3](phase-3.md) subsequently adds campaign management, scheduling, cancellation, and persistent recovery cursors. Its notes describe the current queued profile.

Phase 2 implements durable subscriber storage, separate campaign and delivery queues, recovery, administrator token validation, and deployable Azure Functions handlers. The active demonstration runs locally. Azure deployment is intentionally off under the user's strict INR 100 monthly spending ceiling.

## Budget decision

The user requires a strict maximum of INR 100 with automatic stopping. Azure does not offer custom hard spending limits on pay-as-you-go subscriptions. Budget evaluation relies on delayed billing data, so an automatic shutdown triggered by it can exceed the threshold. Resource storage can also continue to incur charges after compute stops. Application send quotas are not a monetary billing cap.

The user selected **keep cloud deployment off**. No project Azure resources, Entra applications, or cost-alert contacts were created. [Deployment policy](../infra/deployment-policy.json) records this decision; it is not a platform-enforced spending limit and cannot prevent someone independently running Azure commands. This phase supplies no automatic cloud deployment workflow.

References: [Azure spending limits](https://learn.microsoft.com/en-us/azure/cost-management-billing/manage/spending-limit), [budget evaluation](https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/tutorial-acm-create-budgets), [billing data delays](https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/understand-cost-mgt-data).

## Run the queued local demonstration

```sh
npm ci
npm run setup
npm run dev:queued
```

Open `http://localhost:5173`, reconnect the browser if it was previously registered in the direct Foundation profile, then send a test from the page or terminal:

```sh
npm run push:list
npm run push:send -- --latest
```

The HTTP response reports **queued**, not provider acceptance. A background worker consumes the campaign queue, persists deterministic delivery records, publishes delivery jobs, and sends encrypted Web Push requests. The service worker reports receipt only after notification creation succeeds. The local CLI selects one browser and remains protected by the private local administrator token.

Registrations, delivery state, and messages are stored separately in ignored local files. Work is acknowledged after processing. Restarting the API retains the subscriptions and queued work; an abandoned message becomes visible after its one-minute local queue lease. A delivery processing lease expires after two minutes, and the recovery loop runs every minute. Allow that recovery window when testing abrupt process termination.

The local adapters are single-process tools. They do not establish Azure partition behavior, broker settlement, managed identity permissions, cold-start behavior, or cloud scale. File retention is currently manual; Azure's per-document TTL behavior is not simulated locally.

## Storage and recovery

`DocumentDatabase` abstracts point reads, conditional writes, atomic batches, and paginated queries. The Cosmos adapter uses one logical website partition so quota changes and subscriber writes can be atomic. This is a small single-website prototype; partition and indexing design must be reassessed before the 100,000-subscriber benchmark.

- Subscriber IDs derive from endpoint hashes, so a duplicate endpoint cannot claim a second identity or overwrite ownership.
- Subscriber quota reservation and insertion happen in one transaction. Deletion releases capacity atomically.
- Campaign IDs derive from the creator and idempotency key. Reusing a key with different content or recipients is rejected.
- A saved pending campaign acts as an outbox entry. Queue publication failure leaves recoverable work rather than losing the request.
- Delivery IDs derive from campaign and subscriber IDs. Persisted claims prevent concurrent duplicate messages from causing ordinary duplicate sends.
- The daily attempt counter and delivery claim are updated in the same transaction. Retries also consume the shared attempt allowance.
- Temporary provider failures use bounded exponential backoff. The timer republishes due attempts and recovers abandoned leases; five attempts exhaust the delivery.
- Expired provider endpoints deactivate the subscription. Invalid or repeatedly unprocessable queue messages use dead-letter handling.

An ambiguous crash after provider acceptance can still produce a duplicate on recovery. This is an at-least-once delivery design, not a guarantee of exactly-once push display. The recovery scan is bounded to 100 active campaigns and 100 active deliveries per tick; larger workloads and cursor scheduling belong to the scaling work.

Operational defaults are 100 stored subscribers, 100 campaign submissions per UTC day, 1,000 delivery attempt reservations per UTC day, and 100 selected recipients per test campaign. These limits control application work and do not enforce an INR spending ceiling.

## Administrator access

The Azure API validates Microsoft Entra v2 delegated access tokens using tenant-specific signing keys and RS256. It checks signature, expiration, issuer, API audience, tenant, calling SPA client, `access_as_user` scope, and administrator identity or the `WebPush.Admin` role. An ID token is not sufficient. Unauthorized requests fail before data access or queue publication.

The `/admin` frontend uses Microsoft's browser authentication library with authorization-code flow and PKCE. It supports sign-in, authenticated subscriber listing, selection, and submitting a bounded test campaign. No browser client secret is used. Browser sign-in remains disabled in the local profile because no live Entra applications are provisioned; this is shown explicitly in the interface.

For a future authorized cloud deployment, register separate single-tenant API and SPA applications, configure API v2 tokens and the `access_as_user` delegated scope, authorize the SPA for that scope, and register the frontend's `/admin` redirect URI. Configure an administrator object ID or the `WebPush.Admin` application role. The local CLI token is never accepted by the cloud API.

References: [Microsoft token validation](https://learn.microsoft.com/en-us/entra/identity-platform/claims-validation), [SPA authentication](https://learn.microsoft.com/en-us/entra/identity-platform/msal-authentication-flows).

## Azure artifacts prepared

- `infra/main.bicep`: one region, Cosmos lifetime free tier with 400 shared RU/s, one Service Bus Basic namespace with two queues, LRS host storage, and a Flex Consumption Node 24 app with no Always Ready instances.
- Managed identity is used for Cosmos, Service Bus, and deployment storage. The template enables no shared-key database or messaging credentials.
- `apps/functions/src/azure.ts`: HTTP API, campaign trigger, delivery trigger, and minute-based recovery timer.
- `npm run package:cloud`: produces `.cache/azure-function.zip` with a bundled backend and the Azure Functions SDK runtime. Local files, secrets, and browser subscription data are excluded.
- `apps/dashboard/.env.example`: optional public `VITE_API_ORIGIN` for a future separately hosted API. Leave it empty for the local proxy.

The local preflight confirmed an unused Cosmos free-tier slot and Node 24 availability in Central India after a successful browser-based Azure sign-in. This does not validate provider quotas, deployment permissions, billing-offer eligibility, live Entra app registration, or a deployed cloud round trip. The Bicep template and package are prepared for review, not approved for provisioning under the current budget decision.

## API additions

| Route | Purpose |
| --- | --- |
| `GET /api/admin/me` | Verify administrator authorization. |
| `GET /api/admin/subscriptions` | Paginated summaries without endpoints, keys, or ownership tokens. |
| `POST /api/admin/campaigns/test` | Queue a selected-recipient campaign; requires `Idempotency-Key`. |
| `GET /api/admin/campaigns/:id` | Inspect dispatch state and delivery outcome counts. |
| `POST /api/subscriptions/:id/test` | Owned single-browser test; responds `202` with queued status and a notification ID. |

Public subscriber configuration and ownership routes retain their purpose. The local queued profile uses 64-character endpoint-derived IDs, while the original Foundation profile retains UUIDs.

## Verification and remaining work

Run `npm test`, `npm run build`, and `npm run package:cloud`. Unit and integration tests use signed test JWTs, fake provider responses, in-memory transactions, and real local files. They cover authorization failures, transaction contention, restart persistence, both queue stages, outbox recovery, abandoned leases, retry timing, attempt limits, and provider expiry.

The local check verified a saved subscriber registration after restarting the API. The CLI then queued a test campaign, both queue stages processed it, and the persisted delivery recorded provider HTTP 201 acceptance on its first attempt. The message queues drained with no dead letters. Browser controls became unavailable during this phase, so operating-system display and the final receipt indicator were not reverified for this queued run. The original Foundation browser round trip remains separately documented.

All 33 tests and the frontend/server build passed. The runtime dependency audit reported zero known vulnerabilities. The Bicep template compiled successfully without deployment, and the Azure archive built locally. Importing the archive entry point succeeded in the SDK's outside-host test mode; that is not a live Azure Functions trigger test. No live Entra sign-in was tested against this project's API; authorization tests use real cryptographic verification with controlled test signing keys.

The final source, frontend build, and packaged backend were checked for the generated local VAPID private key and CLI token; neither credential was found. Private state and local build archives remain ignored by Git. The Microsoft sign-in library is loaded only on the administrator route so the public subscriber page does not download it unnecessarily.

Live Cosmos transactions, actual Service Bus triggers, managed identity roles, and real Entra browser sign-in remain unverified until a future deployment is authorized under an acceptable billing model. Scheduling, tag segments, cancellation, larger audience expansion, and fuller analytics remain in the later project milestones.
