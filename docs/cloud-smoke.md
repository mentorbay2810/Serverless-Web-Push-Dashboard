# Temporary Azure smoke test

19 November 2026, Asia/Kolkata. Status: preparation; no live delivery result is claimed in this revision.

The operator authorized a one-time cloud check after being told that Azure billing data can arrive late and a strict INR 100 maximum cannot be guaranteed. The operator supplied a private email for cost alerts. The default deployment policy and CI remain cloud-off; this approval is limited to a temporary test with cleanup.

The read-only preflight confirmed an enabled Azure subscription, an unused Cosmos DB free-tier slot, and Node 24 in Central India. The Bicep template compiles. A subscription-level INR 100 monthly actual-cost email alert was created and verified, filtered to the isolated test resource group. The billing currency was checked through the current Billing API. Alert contact details and subscription identifiers remain in ignored private records. The alert is retained through month-end to cover delayed cost reporting after deletion of test services.

The proposed test uses:

- One newly tagged resource group, a dedicated VAPID pair, and two temporary single-tenant Entra application registrations.
- Static Web Apps Free in East Asia; the separately hosted API is called directly over HTTPS. SPA fallback supports `/admin`, and the service worker is served with `Cache-Control: no-store`.
- Functions Flex Consumption in Central India, Node 24, 512 MB, zero Always Ready instances, and a maximum of one instance per function scale group. That maximum is not an overall single-instance guarantee or a currency cap.
- Cosmos free tier, one region and a 400 RU/s shared database; Service Bus Basic with campaign/delivery queues; LRS storage.
- Five subscriber slots and ten daily delivery attempt reservations for this check. Ordinary prototype defaults remain 100 and 1,000.

The template now exposes the instance/subscriber/attempt limits as bounded parameters and explicitly permits the selected frontend origin in the Functions platform CORS settings. Current Microsoft guidance permits a minimum Flex maximum-instance setting of one. The first provisioning attempt also established that the subscription's Web, Service Bus and Cosmos resource providers need registration.

Before metered services are created, validate the full ARM deployment with private parameters. Then deploy the packaged Functions backend, build the frontend with only the public API origin, scan packages for credentials, and publish the static assets. Verify API health/configuration, rejected foreign origins and unauthenticated administration, real Cosmos registration/read/removal, and—when a browser is connected—actual queued delivery. Record provider acceptance, browser receipt, OS display and click separately. Do not post synthetic receipt/click events as browser evidence.

Cleanup must verify the experiment ownership tag, delete only the new group and the two known temporary app registrations, and wait for Azure to confirm removal. Keep the filtered email budget alert for delayed billing. Cost queries must target this group only; absent billing rows mean unreported cost, not a zero-cost guarantee. Existing local `.env`, subscriptions, queues and frozen research artifacts are preserved.

References: [Azure spending limits](https://learn.microsoft.com/en-us/azure/cost-management-billing/manage/spending-limit), [Flex scaling limits](https://learn.microsoft.com/en-us/azure/azure-functions/event-driven-scaling), [managed-identity connections](https://learn.microsoft.com/en-us/azure/azure-functions/manage-connections), [Static Web Apps deployment](https://learn.microsoft.com/en-us/azure/static-web-apps/static-web-apps-cli-deploy), [budget API](https://learn.microsoft.com/en-us/rest/api/consumption/budgets/create-or-update?view=rest-consumption-2024-08-01).
