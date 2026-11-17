# Foundation API Contract

The Foundation API is a loopback-only development service at `http://127.0.0.1:8787`. The subscriber frontend uses Vite's same-origin `/api` proxy. These routes have local file persistence and are not the cloud administrator API.

All responses are JSON with `Cache-Control: no-store`. Mutating requests require `Content-Type: application/json` when sending a body. Bodies are limited to 8 KiB. Foreign browser origins and non-loopback hostnames are rejected. No secrets are accepted in query strings.

| Method and path | Purpose | Authorization |
| --- | --- | --- |
| `GET /api/health` | Local service readiness. | Public. |
| `GET /api/config` | Public VAPID key and local demo configuration. | Public; never returns the private key or CLI token. |
| `POST /api/subscriptions` | Register a browser-generated subscription. | User opt-in in the UI; validated endpoint and encryption keys. |
| `GET /api/subscriptions/:id` | Restore this browser's connection summary. | Subscription ownership token. |
| `DELETE /api/subscriptions/:id` | Remove the stored subscription. | Subscription ownership token. |
| `POST /api/subscriptions/:id/test` | Send one test to this browser. | Subscription ownership token. |
| `GET /api/local/subscriptions` | List IDs, provider hostnames, and connection dates for the CLI. | Local administrator token. |
| `POST /api/local/send-test` | Send to one explicitly selected subscription ID. | Local administrator token. |

Use `Authorization: Bearer <token>`. Registration returns a random ownership token once; the server stores its hash. A duplicate endpoint cannot overwrite an existing registration or recover its token. Listing never returns endpoints, encryption keys, token hashes, or ownership tokens.

## Register a subscription

The browser calls `pushManager.subscribe()` using the public VAPID key and sends its `toJSON()` representation:

```json
{
  "subscription": {
    "endpoint": "https://fcm.googleapis.com/wp/<browser-generated-value>",
    "expirationTime": null,
    "keys": {
      "p256dh": "<browser-generated-public-encryption-key>",
      "auth": "<browser-generated-auth-secret>"
    }
  }
}
```

A `201` response contains `id`, `provider`, `createdAt`, and `token`. Preserve `id` and `token` in that browser. A refresh uses the authenticated summary route, rather than registering the endpoint again.

## Send a test

The owned test route accepts a title with 1–80 characters, a body with 1–240 characters, and an optional website-relative click path:

```json
{
  "title": "Foundation test",
  "body": "A message from the local service",
  "url": "/"
}
```

The CLI route accepts the same fields plus `id`. A successful response contains `status: "accepted"`, `notificationId`, and `providerStatus`. This means that the browser's push service accepted the encrypted request. Notification receipt, operating-system display, and clicks are separate observations.

The service worker uses `notificationId` as its notification tag, displays a fallback notification for a malformed payload, and restricts click navigation to the website origin. It reports `PUSH_RECEIVED` to open client pages after `showNotification()` succeeds; this is evidence of successful browser notification creation, not proof of human attention.

## Limits and failures

The local service allows 100 saved subscriptions, 20 registration attempts per minute, five push attempts per minute, and 240 API requests per minute. Limits are process-local and reset on restart. This is a local test service rather than a production rate-limit implementation.

| Status | Meaning |
| --- | --- |
| `400` | Invalid JSON, endpoint, key, notification text, or click path. |
| `401` / `403` | Missing or incorrect credentials, forbidden origin, or forbidden host. |
| `404` | Unknown route or missing subscription. |
| `409` | Endpoint is already registered. |
| `410` | Subscription expired; stored registration was removed. |
| `413` / `415` | Body is too large or has the wrong content type. |
| `429` | Local request, subscriber, or send limit reached. |
| `502` | Provider failed to accept the push; provider error bodies and endpoints are not exposed. |

These limits and routes will be revisited when cloud identity, distributed workers, and durable queues are introduced.
