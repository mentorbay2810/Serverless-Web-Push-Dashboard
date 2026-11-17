# Foundation Setup and Verification

The Foundation is implemented as a local application. It includes a React/TypeScript subscriber interface, a Node API, a file-backed subscription adapter, a VAPID Web Push sender, a push-only service worker, and a command-line sender. Azure deployment remains in milestone 2.

## Run and verify

1. Use Node 24, or Node 22.19+ for local development. Run `npm ci`, `npm run setup`, then `npm run dev` from the project root.
2. Open `http://localhost:5173` in a supported browser. Use the same origin consistently; `localhost` and `127.0.0.1` have different browser storage and permissions.
3. Choose **Enable notifications** and allow the browser permission request. Wait for **Connected** in the connection badge. Allowing permission alone does not complete registration.
4. Choose **Send test notification**, or run `npm run push:send -- --latest` in another terminal. The CLI selects only the most recently registered browser.
5. Check both provider acceptance and the device's notification. An open page records **Notification received** after the service worker successfully creates the notification.
6. Reload the page to check connection restoration. Restart the API to check the local file store. Use **Disconnect browser** to remove the backend registration and unsubscribe through the browser.

`npm run setup` can be repeated without rotating keys. Do not delete or replace `.env` just to restart the app. `.env` and `.data` are private local state and are ignored by Git.

## Browser requirements and recovery

Web Push needs network access to the browser vendor's push service, notification permission, a service worker, and a secure context. Localhost is supported for development. Operating-system notification settings and focus modes can suppress a visible banner even when the browser accepts a notification creation request.

If notifications are blocked, change this site's notification permission in browser settings and use **Check connection**. If a registration is stale or the VAPID key changed, use **Enable notifications** to replace the browser subscription. If browser storage is cleared while a backend registration remains, reconnect creates a fresh browser subscription; old registrations can remain until the push provider reports expiry. This is local demonstration behavior and will be improved with cloud subscription lifecycle handling.

The backend accepts known HTTPS browser push services rather than arbitrary URLs. This includes `fcm.googleapis.com`, Google's exact alternate `jmt17.google.com` hostname, Mozilla push service subdomains, Safari's `web.push.apple.com`, and Windows notification subdomains. An unknown service is rejected with its hostname for diagnosis. The alternate Google host is documented in [Chromium's push messaging constants](https://chromium.googlesource.com/chromium/src/+/refs/tags/141.0.7390.94/components/push_messaging/push_messaging_constants.cc).

Use a real contact address for `VAPID_SUBJECT` before Safari validation or deployment. The example value is only an initial local default. [Web Push library configuration](https://github.com/web-push-libs/web-push#api-reference).

## Verification evidence

The implementation session verified the following:

- The subscriber page returned HTTP 200 and rendered in the browser preview.
- A real browser registered a Google push-service subscription and restored it after a page reload.
- The command-line sender submitted an encrypted notification and received provider acceptance.
- The page's test sender also received provider acceptance, and its service-worker event appeared as **Notification received** after `showNotification()` succeeded.
- TypeScript checking and the frontend/server build passed, and all 13 behavior tests passed.
- Behavior tests cover request origins and hosts, subscription ownership, restart persistence, duplicate registration, concurrent limits, expired endpoints, unsafe URLs, fallback notification display, and notification click navigation.
- The narrow mobile preview had matching viewport and content widths, with no horizontal overflow; the desktop preview was also visually inspected.
- The generated private VAPID key and CLI token were absent from every frontend build artifact. The local `.env` file permissions were verified as `0600`, and private state and build outputs were confirmed ignored by Git.

These observations establish a local Web Push round trip. They do not establish full cross-browser compatibility, operating-system banner visibility in every environment, closed-browser delivery, Azure scaling, or performance at 100,000 subscribers. Those are later validation activities.

## Dependency advisory

The online production-dependency audit reported zero known vulnerabilities during this implementation session. The full audit reported four high-severity development-tooling entries caused by the same transitive `picomatch` advisory in Vite's toolchain. The advisory currently lists no patched version. Keep the Vite development server on localhost and use trusted project glob configuration. The production frontend is a static build and does not run the Vite development server.

This advisory is recorded rather than treating an offline audit result as evidence that it is fixed. Recheck the toolchain before deployment or upgrading. [GitHub advisory GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf).

## Azure preflight

`npm run check:cloud` reports local tool availability. An optional read-only account check is available:

```sh
npm run check:cloud -- --azure --region centralindia
```

The implementation machine has Node 22.19 and Azure CLI installed. Functions Core Tools is not installed. Azure CLI returned an enabled cached subscription, but the remote Cosmos free-tier and Flex Consumption runtime checks could not be verified in this session. No Azure resources were created.

Before milestone 2's first cloud deployment, complete the following:

- Confirm authenticated access to the intended Azure subscription and permission to create project resources.
- Check whether the one Cosmos DB lifetime free-tier slot is available or already in use. Do not silently provision a paid database.
- Confirm a region that supports Flex Consumption, Node 24, Cosmos DB, and Service Bus Basic together. Central India is a candidate to check, not a verified deployment selection.
- Check Entra application registration rights and administrator identity setup. A cached subscription sign-in does not establish those rights.
- Verify Functions free-grant eligibility for the subscription's offer and estimate queue, storage, telemetry, and network costs for the demo profile.
- Choose a low budget-alert threshold; retain zero Always Ready instances, one region, and the free frontend plan.

These checks are read-only prerequisites for the next deployment milestone. The Foundation runs without them and incurs no Azure resource charges.
