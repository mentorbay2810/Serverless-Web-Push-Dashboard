# Serverless Web Push Dashboard Implementation Plan

Build a working Azure serverless notification service with a management dashboard, keep routine development local, and use free cloud allowances for a small demonstration. Deliver a reproducible comparison with an always-on server for the dissertation.

The local Foundation is implemented, including a verified browser Web Push round trip. See [Foundation verification](foundation.md) for evidence and the cloud-readiness checks still needed before milestone 2. The dates below are proposed targets beginning 18 November 2026 and follow the supplied outline's development, testing, review, and submission windows. They assume focused daily development. They are planning targets, not measured delivery estimates.

Phase 2 now has a local implementation of durable queued delivery and administrator token validation. Its live Azure smoke deployment is deferred by the user's strict INR 100 budget decision. See [Phase 2 status and verification](phase-2.md); do not treat local adapter checks as cloud validation.

Phase 3 is implemented locally: campaign CRUD, tag targeting, frozen audiences, one-time UTC scheduling, paginated dispatch checkpoints, cancellation, retry delays, and final campaign states. All 51 tests and builds pass, and a scheduled campaign survived an API restart and received real provider acceptance. See [Phase 3 commands and evidence](phase-3.md). Cloud deployment remains off; the next milestone is the campaign dashboard and analytics.

Phase 4 is implemented locally with the campaign dashboard, expiring browser administrator sessions, reviewed activation, separate persistent acceptance/receipt/click metrics, failure details, and durable pause controls. All 68 tests and builds pass. A live local API flow produced provider acceptance and a real browser receipt. Automated visual/UI interaction checks and live Azure/Entra checks remain unverified; see [Phase 4 evidence and limits](phase-4.md). Cloud deployment remains off under the strict INR 100 ceiling.

Phase 5 prepares `0.1.0-rc.1` as a local candidate with a built server, configuration/data ownership safeguards, paused recovery startup, a repeatable release gate, source/artifact fingerprints, a review bundle, and test-only public CI. Verification output is saved in `.cache/release/report.json`; see [Phase 5](phase-5.md) and [operations](operations.md). Hosted deployment and cloud automation remain deferred by the strict budget decision, and UI/cross-browser/cloud checks remain explicitly unverified.

## Scope and completion criteria

The first release supports one website and a small administrator group. It includes subscriber opt-in and opt-out, subscriber tags, basic segment filters, campaign creation and preview, immediate and scheduled sending, queue-based fan-out, bounded retries, and campaign analytics. The public subscriber page and administrator dashboard can share one static frontend deployment.

A complete demonstration must show a browser subscribing, an administrator sending a campaign to a segment, the service worker displaying the notification, and the dashboard showing send outcomes. A scheduled campaign, expired subscription, transient failure, and queued duplicate must also be demonstrated.

Native mobile push, billing, multiple customer organizations, visual workflow builders, recurring campaigns, A/B testing, and production high-availability infrastructure are outside the first release. Simulated audiences up to 100,000 remain part of the dissertation evaluation.

## Technology decisions

| Area | Planned implementation | Reason |
| --- | --- | --- |
| Frontend | React, Vite, and TypeScript | Static build for the free hosting plan; one application for public and admin routes. |
| Backend | TypeScript, Node.js 24, Azure Functions runtime 4 with Node programming model v4 | Shared language and a currently supported Azure runtime. Verify regional runtime support during setup and lock dependency versions. |
| Data | Azure Cosmos DB for NoSQL lifetime free tier | One region, one shared-throughput database, and total provisioned throughput within the free allowance. |
| Messaging | Service Bus Basic with campaign and delivery queues | Durable buffering and dead-letter handling without the Standard tier base charge. Implement duplicate handling in application code. |
| Web Push | Established Web Push library using VAPID and payload encryption | Keep protocol cryptography in a maintained implementation. |
| Administrator access | Single-tenant Microsoft Entra sign-in, SPA authorization-code flow with PKCE, and backend token validation | No browser-held client secret; backend checks the intended API audience and administrator identity or role. Verify tenant access in the first phase. |
| Infrastructure | Bicep and one deployment pipeline using short-lived Azure identity credentials | Repeatable deployment, explicit service tiers, and no long-lived Azure deployment secret. |
| Validation | Unit and integration tests, browser automation, manual real-browser push checks, and a scriptable load harness | Cover delivery behavior and collect dissertation evidence. |

Microsoft currently recommends the Node.js v4 programming model and Node.js 24 for new Functions applications. [Azure Functions Node.js reference](https://learn.microsoft.com/en-us/azure/azure-functions/functions-reference-node).

Use Microsoft's maintained browser authentication library for the SPA authorization-code flow with PKCE. [Microsoft identity platform authentication flows](https://learn.microsoft.com/en-us/entra/identity-platform/msal-authentication-flows).

Host only the static frontend on Static Web Apps Free. It calls the separately deployed Functions API directly over HTTPS with configured CORS. Do not depend on linking an existing Functions app through Static Web Apps, because that integration requires the paid hosting plan. [Static Web Apps plans](https://learn.microsoft.com/en-us/azure/static-web-apps/plans).

## Delivery milestones

| Milestone | Target window | Work and deliverables | Completion check |
| --- | --- | --- | --- |
| 1. Foundation and first push | 18–20 November 2026 | Workspace structure, local commands, environment templates, VAPID key generation, shared validation, subscriber page, service worker, and a local test-send command. Check Azure free-tier eligibility, available region, and Entra tenant access. | A real supported browser subscribes and displays one notification sent from the local backend. Secrets are absent from source control and the frontend build. |
| 2. Durable backend and access | 21–24 November 2026 | Subscription APIs, Entra authentication, administrator authorization, Cosmos schema and indexes, Azure adapters, Basic queues, and a small Azure smoke deployment using Bicep. | Subscription survives a backend restart; unauthorized campaign requests fail; one campaign moves through both Azure queues and reaches a real browser. |
| 3. Campaigns and reliable sending | 25–28 November 2026 | Campaign CRUD, tag-based targeting, one-time scheduling, fan-out pagination, dispatch recovery, delivery state, retries, expiry handling, cancellation, and send limits. | Scheduled work is not sent early; duplicate queue deliveries are handled; expired subscriptions are deactivated; interrupted fan-out resumes. |
| 4. Dashboard and analytics | 29 November–2 December 2026 | Subscriber list, campaign editor and preview, segment selection, schedule controls, campaign status, aggregate analytics, failure inspection, and pause controls. | An administrator completes subscribe-to-send-to-report flows through the UI. Counts distinguish provider acceptance, browser receipt, and clicks. |
| 5. Release candidate | 3–4 December 2026 | Finish deployment pipeline, run cloud smoke checks, fix integration issues, document setup and operations, and freeze the dissertation prototype. | A clean checkout builds and can be deployed from documented configuration. The hosted demonstration works and resource tiers match the cost plan. |
| 6. Functional and security validation | 5–12 December 2026 | Complete failure and authorization tests, real cross-browser checks, always-on baseline host, and benchmark harness. | Reproducible test report and a small baseline run with comparable inputs are available. |
| 7. Benchmarking and analysis | 13 December 2026–3 January 2027 | Run bounded experiments at increasing audience sizes, compare cold and warm behavior, collect usage and cost data, and prepare results and limitations. | Saved experiment inputs, raw results, plots, cost breakdown, and conclusions support the dissertation. |
| 8. Review and submission | 4–30 January 2027 | Supervisor and examiner review on 4–19 January; incorporate feedback and prepare final submission on 20–30 January. | Final report, source, deployment instructions, and demonstration evidence are complete. |

Each milestone depends on the previous completion check. Begin automated verification with the first working flow and add behavior tests alongside features throughout development. Use the later validation window to broaden coverage and collect formal evidence.

If the December development window becomes tight, simplify dashboard styling, keep segments to tags, retain one-shot scheduling, and show a small set of analytics. Preserve authentication, reliable queue processing, cost controls, and the benchmark methodology.

## Repository layout

```text
apps/
  dashboard/          Public subscriber page and administrator frontend
  functions/          HTTP endpoints, timer, fan-out, and delivery workers
packages/
  core/               Campaign rules, shared types, validation, and interfaces
  adapters/           Cosmos DB, Service Bus, Web Push, and local test adapters
tools/
  benchmark/          Seed data, mock push endpoint, load driver, and reports
  baseline/           Always-on host reusing the same core sending logic
infra/                Bicep templates and deployment parameters
tests/                Integration and browser scenarios
docs/                 Architecture, setup, API contract, and research evidence
```

Use a simple npm workspace and a single lockfile. Local data and queue adapters make routine development possible without Azure credentials; they do not establish Azure persistence, settlement, or scaling correctness. Verify those behaviors against real Azure resources in milestone 2. Use a local worker runner to invoke the same core handlers when cloud queue triggers are disabled locally.

## Backend contracts and data

Design the request schemas and query patterns in milestone 1, then validate Cosmos partition keys, indexes, and request-unit costs in milestone 2 before expanding the dataset. Use one shared-throughput database so containers share the free allowance. Keep point lookups and audience reads paginated, and retain only bounded operational history.

| Record | Required information |
| --- | --- |
| Subscription | ID, website ID, endpoint, encryption keys, tags, active status, consent and update timestamps, and scoped opt-out capability. |
| Campaign | ID, notification title and body, allowed destination URL, segment definition, UTC send time, state, and creator. |
| Dispatch progress | Campaign ID, pending enqueue status, dispatch lease, and audience continuation checkpoint. |
| Delivery | Deterministic campaign/subscription ID, attempt count, lease or processing state, next retry time, outcome, timestamps, and expiry. |
| Client event | Delivery ID, authenticated event capability, event type, event ID, and timestamp for deduplication. |
| Campaign aggregate | Counts derived from unique delivery outcomes and events, with a last-updated timestamp. |

Use a fixed target definition for a campaign and document when subscriber membership is evaluated. Make audience expansion resumable. Do not increment one shared campaign counter on every attempt; aggregate unique outcomes in bounded batches to avoid a write bottleneck and double-counting retries.

| API group | Planned operations | Access |
| --- | --- | --- |
| Public configuration | Read the public VAPID key and website configuration. | Public, bounded response. |
| Subscriptions | Register, refresh, or deactivate a subscription. | Registration is validated and rate-limited; changes require the subscription's scoped capability. |
| Subscribers and segments | List subscribers, manage tags, and preview a target audience. | Administrator. |
| Campaigns | Create, edit drafts, list, preview, send, schedule, and cancel. | Administrator; state-changing requests use idempotency keys where appropriate. |
| Reporting | Read campaign status and aggregates; receive deduplicated receipt and click events. | Reports require administrator access; event submission requires a delivery-scoped capability. |
| Operations | Pause dispatch and sending; inspect and deliberately replay recoverable failed jobs. | Administrator. |

Store schedules in UTC and display the selected timezone explicitly. Start with simple tag filters and audience-count previews. Avoid unrestricted query expressions in the first release.

## Delivery correctness

Campaign state progresses through `draft`, `scheduled` or `queued`, `dispatching`, and `sending`, followed by `completed`, `completed_with_failures`, `cancelled`, or `failed`. Delivery outcomes include `accepted`, `expired`, `failed`, and `cancelled`; receipt and click events are separate observations.

Persist a pending-dispatch marker with the campaign and reconcile pending work. Database writes and queue publication are not one atomic operation. Resumable fan-out and deterministic delivery IDs must tolerate publishing the same work again after a crash.

Workers check current campaign and subscription state before sending. Use bounded concurrency, request timeouts, message expiry, and bounded retries. Treat provider acceptance as the end of that send attempt; do not label it confirmed display. Deactivate endpoints with confirmed expiry responses. Handle throttling and transient failures using backoff and `Retry-After` when supplied, and leave unprocessable queue work in dead-letter handling after its limit.

Service Bus Basic does not provide broker duplicate detection. Use persisted delivery state and client notification identifiers to reduce duplicate sends and displays. A crash after a provider accepts a request can leave an ambiguous outcome, so the implementation and report must not claim exactly-once delivery. [Service Bus duplicate detection](https://learn.microsoft.com/en-us/azure/service-bus-messaging/duplicate-detection).

Cancellation stops new dispatch and queued attempts after their state check; a notification already accepted by a browser push service cannot be recalled.

## Cost controls

- Develop and run routine tests locally. Keep one small hosted demo environment, one region, one Functions app, and one Basic namespace with two queues.
- Use Flex Consumption on demand with zero Always Ready instances. Plan around its shared monthly grant and measure actual execution duration and memory usage.
- Enable Cosmos lifetime free tier at account creation, keep shared provisioned throughput within 1,000 RU/s and storage within 25 GB, and avoid adding regions or dedicated throughput. Serverless Cosmos accounts do not receive this free tier. [Cosmos DB free tier](https://learn.microsoft.com/en-us/azure/cosmos-db/free-tier).
- Start the demo profile with up to 100 real subscribers and a configurable ceiling of 1,000 send attempts per day, including retries. Make benchmark configuration separate from these routine defaults.
- Keep a dispatch pause switch, retry limits, worker concurrency controls, bounded data retention, and sampled logs. Record quota rejections so skipped sends are visible.
- Before the first cloud deployment, estimate the selected region's charges for the demo workload, check free-allowance eligibility, and choose a low monthly budget-alert threshold. Budgets are notifications, not automatic spending stops.
- Retain the Functions host storage account in the estimate. Queue operations, storage, and possible telemetry or network charges remain billable even when compute and database use fit free allowances.
- Run benchmark infrastructure only for fixed-duration experiments and remove temporary compute, disks, and other billable resources afterward. Trial or student credits can help but are not a dependency of the design.

The running-cost target is near zero for development and small demonstrations. The plan does not claim that 100,000 active production subscribers or repeated large campaigns will remain free. Detailed pricing references are in [the architecture document](architecture.md).

## Validation and dissertation evidence

| Area | Evidence to collect |
| --- | --- |
| Subscriber journey | Allow and deny permission, subscribe and unsubscribe, permission changes, and notification display with the tab closed where supported. Record actual browser and OS versions. |
| Campaign workflow | Draft validation, exact targeting, immediate and scheduled sends, timezone conversion, cancellation, and overlapping scheduler invocations. |
| Recovery | Duplicate deliveries, worker restart, a crash around queue publication, interrupted audience expansion, throttling, expired endpoints, exhausted retries, and dead-letter inspection. |
| Access and input handling | Unauthorized and wrong-audience tokens, non-admin access, subscription ownership, forged events, malformed payloads, and unsafe destination URLs or push endpoints. Reject private-network targets and redirects; allow mock targets only in explicit test configuration. |
| Cost behavior | Send ceilings, pause controls, log volume, actual service tiers, Cosmos request-unit consumption, and charges inside and outside free grants. |
| Performance | Queue waiting time, provider request latency, total campaign processing time, throughput, p50/p95/p99 latency, cold starts, transient failures, and Cosmos throttling. |

Exercise Chromium, Firefox, and Safari/WebKit where actual supported devices are available. A browser automation engine is useful for page flows, but it does not by itself validate that browser's real operating-system push delivery. Treat receipt and click reporting as best effort, and never present a click or provider acceptance as proof that a person read a notification.

Run synthetic audiences of 100, 1,000, 10,000, and 100,000 against a controlled mock push endpoint. Report those pipeline measurements separately from small real-browser trials. Use the same core sending logic, payloads, audience definitions, database and queue configuration, provider behavior, and comparable concurrency limits for the Functions and always-on baseline. Run both from a comparable cloud region for the formal comparison; local exploratory runs are labeled separately.

Repeat measurements and record run IDs, configuration, warm/cold conditions, attempted and accepted counts, failures, and raw timestamps. Calculate both observed invoice impact after free allowances and usage-based cost before free allowances, since a free grant can conceal the underlying scaling cost. Do not attribute a database bottleneck or a different test environment solely to serverless compute.

## Final deliverables

- Working subscriber demonstration page and administrator dashboard.
- Functions API, scheduler, fan-out, workers, and deployment templates.
- Documented local setup, environment configuration, API contract, and operational commands.
- Behavior test results and real-browser demonstration evidence.
- Always-on comparison host and reproducible benchmark harness.
- Experiment inputs, raw data, charts, measured cost analysis, and limitations.
- Dissertation material aligned with the outline's review and submission milestones.

## First implementation task

The Foundation and local implementations of milestones 2–5 are prepared. Next, broaden functional/security and real UI/cross-browser validation, then build the controlled benchmark harness. Retain the strict INR 100 budget decision: cloud deployment, deployment automation, and live Azure/Entra checks stay deferred until the user authorizes a compatible billing approach.
