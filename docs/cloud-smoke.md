# Temporary Azure smoke test

19 November 2026, Asia/Kolkata. The real Azure notification path passed its functional test, and Azure confirmed removal of the temporary resource group and both sign-in app registrations. [The public evidence receipt](cloud-smoke-evidence.json) records the source/package identity, checks, observed outcomes and cleanup.

The operator authorized a one-time cloud check after being told that Azure billing data can arrive late and a strict INR 100 maximum cannot be guaranteed. The operator supplied a private email for cost alerts. The default deployment policy and CI remain cloud-off; this approval is limited to a temporary test with cleanup.

The read-only preflight confirmed an enabled Azure subscription, an unused Cosmos DB free-tier slot, and Node 24 in Central India. The Bicep template compiles. A subscription-level INR 100 monthly actual-cost email alert was created and verified, filtered to the isolated test resource group. The billing currency was checked through the current Billing API. Alert contact details and subscription identifiers remain in ignored private records. The alert is retained through month-end to cover delayed cost reporting after deletion of test services.

The proposed test uses:

- One newly tagged resource group, a dedicated VAPID pair, and two temporary single-tenant Entra application registrations.
- Static Web Apps Free in East Asia; the separately hosted API is called directly over HTTPS. SPA fallback supports `/admin`, and the service worker is served with `Cache-Control: no-store`.
- Functions Flex Consumption in Central India, Node 24, 512 MB, zero Always Ready instances, and a maximum of one instance per function scale group. That maximum is not an overall single-instance guarantee or a currency cap.
- Cosmos free tier, one region and a 400 RU/s shared database; Service Bus Basic with campaign/delivery queues; LRS storage.
- Five subscriber slots and ten daily delivery attempt reservations for this check. Ordinary prototype defaults remain 100 and 1,000.

The template now exposes the instance/subscriber/attempt limits as bounded parameters and explicitly permits the selected frontend origin in the Functions platform CORS settings. Current Microsoft guidance permits a minimum Flex maximum-instance setting of one. The first provisioning attempt also established that the subscription's Web, Service Bus and Cosmos resource providers need registration.

The deployment used clean source commit `9497dc2e3c9f5b9dcbce60d79d4f7979ccd27e0c`, candidate `0.1.0-rc.6`. The full ARM deployment validated and provisioned successfully. The reviewed Functions ZIP was deployed and its exact bytes preserved privately before later packaging. The frontend was built in isolated output with only the public API origin; all nine files passed the credential scan. The ordinary localhost build, credentials and subscriber files were preserved.

| Check | Recorded result |
| --- | --- |
| Hosted root, `/admin` SPA route and service worker | HTTP 200; expected application content |
| Cloud API health and public configuration | HTTP 200; Azure mode and five-subscriber limit |
| Administrator request without credentials | HTTP 401 |
| Request with a foreign website origin | HTTP 403 |
| Browser CORS GET and authenticated JSON POST preflight | Exact frontend origin and required headers accepted |
| Live Cosmos disposable registration, owned read and removal | HTTP 201 / 200 / 200; no push sent for this storage fixture |
| Actual subscribed browser | One |
| Real campaigns | Two, both completed |
| Provider acceptance | Two HTTP 201 responses, one attempt per delivery |
| Browser receipt reports | Two |
| Browser click reports | One |
| OS notification display | Reported by the operator after opening the Azure URL |
| Resource tiers and scale limits | Read back and matched the reviewed small-test settings |

The two real browser receipt times were `2026-11-19T09:12:17.758Z` and `2026-11-19T09:12:35.520Z`; one click was reported at `09:12:39.126Z`. These are actual cloud records, not simulated provider responses or manually posted observation events. Read-only operator inspection of this temporary Cosmos account captured the redacted counts. That temporary inspection role is removed with the account; it does not stand in for a hosted administrator sign-in test.

The provider/receipt/click reports support the successful Azure queue and database round trip. The operator separately confirmed visible notification display. Browser/OS versions, keyboard/viewport trials, permission/offline cases and a live Microsoft administrator browser sign-in were not recorded. This small functional check is not a cloud load test or the formal serverless/always-on comparison. The original local research data, frozen report, Word draft and earlier review archives are unchanged.

Two deployment-tool details mattered: publish the Entra API permission scope before configuring SPA preauthorization, and run the Static Web Apps deployment tool outside both the Git-ignored build area and the artifact directory itself. A clean temporary staging parent with a separate `site` child avoided the native client's path/default-file and self-including ZIP failures. The CLI was pinned to Microsoft Static Web Apps CLI 2.1.0 in an ignored tools directory, separate from application dependencies.

Cleanup verified the experiment ownership tag and deleted only the new group and the two known temporary app registrations. Azure took additional time to finish Cosmos deletion; the group was confirmed absent before the handoff. The temporary frontend, Functions app, queues, storage and database are all removed. The test URL is therefore historical, not an ongoing hosted demo.

The subscription-level monthly INR 100 email budget alert remains, filtered to this test's resource group, until 1 December 2026. It can evaluate delayed billing records after application cleanup. Initial cost queries returned Azure HTTP 429 throttling. The final query succeeded but returned no billing rows yet, so the reported amount is **not available**, not zero. There is no final invoice or guaranteed custom spending stop.

The exact deployed backend ZIP and the frontend build files are preserved under ignored `.cache/cloud-smoke/evidence/` with a hash manifest. The public receipt excludes the alert email, account/tenant/administrator identifiers, private keys, deployment credentials, browser endpoints, ownership tokens and notification content. Private operational records are not part of a public review bundle.

References: [Azure spending limits](https://learn.microsoft.com/en-us/azure/cost-management-billing/manage/spending-limit), [Flex scaling limits](https://learn.microsoft.com/en-us/azure/azure-functions/event-driven-scaling), [managed-identity connections](https://learn.microsoft.com/en-us/azure/azure-functions/manage-connections), [Static Web Apps deployment](https://learn.microsoft.com/en-us/azure/static-web-apps/static-web-apps-cli-deploy), [budget API](https://learn.microsoft.com/en-us/rest/api/consumption/budgets/create-or-update?view=rest-consumption-2024-08-01).
