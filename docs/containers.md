# Run on Windows, macOS, or Linux

Install and start [Docker Desktop](https://docs.docker.com/compose/install/) on Windows or macOS. On Windows, use Linux containers with the WSL 2 backend. Linux can use Docker Engine with the Compose plugin. The app builds for Linux AMD64 and ARM64, including Intel/AMD PCs and Apple Silicon. No host Node.js, npm, Python, Azure account, or database installation is required for this local app.

Download or clone this repository, open a terminal in its root directory, and run these same commands in PowerShell, macOS Terminal, or a Linux shell:

```text
docker compose up --build -d --wait
```

Open [http://localhost:5173](http://localhost:5173). Enable notifications, allow the browser prompt, and wait for **Connected**. Real push delivery needs internet access, browser/OS notification permission, and a supported browser on the host computer. Docker runs the server; notifications appear on the computer running that browser. HTTP localhost is suitable for this local demo. LAN/IP access and public hosting need a separate HTTPS deployment.

To open the administrator dashboard:

```text
docker compose exec webpush node dist/tools/admin-login.js
```

Open the printed private one-use link within two minutes. Create a draft, select the audience, preview, and confirm a send or schedule. The same session, ownership, origin, quota, and reporting rules apply as in the native local setup.

## Configuration and ports

Only the dashboard is published, on host loopback. The internal API stays inside the container. Its 8787 port is not published. The built frontend binds to all container interfaces so Docker can forward the localhost port, while requests still need an allowed host/origin.

If 5173 is occupied, copy `docker/compose.env.example` to `.env.compose`, edit `SWPD_WEB_PORT` to a free port such as 5180, then use this command consistently:

```text
docker compose --env-file .env.compose up --build -d --wait
docker compose --env-file .env.compose exec webpush node dist/tools/admin-login.js
```

Open the matching localhost URL. Choose a port from 1024–65535 other than 8787. Changing the origin requires subscribing in the new origin. Set `SWPD_VAPID_SUBJECT` to your own real `mailto:` contact before Safari or public testing. The defaults work without creating `.env.compose`.

The native root `.env`, its keys and `.data` are excluded from the Docker build. The container generates a separate VAPID pair and CLI token on its first startup. These are kept in the named `webpush-data` volume along with subscribers, campaigns, controls and queues. Restarting/rebuilding preserves this volume and its keys. Local browser sessions are revoked on restart. Running the native app and Docker on different ports creates independent demonstrations. If this browser previously used the native app at the same localhost origin, choose **Reconnect** to subscribe with the container's separate keys.

The service runs as UID 1000 with a read-only image and a writable data volume. A kernel `flock` provides exclusive volume ownership across containers and releases after a crash. Startup removes the old container's PID lock only under that volume lock. Keep the supplied entrypoint and use one application container per volume; do not bind-mount a running native app's data directory or launch the container entry directly with `exec`.

## Operations

```text
docker compose ps
docker compose logs --tail 100 webpush
docker compose stop
docker compose start --wait
docker compose down
```

`stop`/`down` preserve the data volume. **`docker compose down --volumes` permanently removes local subscriber data, keys, and any Azure sign-in volume for this Compose project.** Do not use it for routine shutdown. Restore a backup with its original keys, or reconnect browsers after intentionally resetting.

For a paused recovery start, stop the service first, then run:

```text
docker compose run --rm --service-ports webpush node dist/tools/container.js --paused
```

The entrypoint still acquires the volume lock. Open an administrator session from a second terminal using `docker compose exec` only when the regular service is running; for a one-off recovery container, use its container name with `docker exec` instead. Resume controls deliberately in the dashboard after inspection.

To back up a stopped regular service on any host OS:

```text
docker compose stop webpush
docker compose cp webpush:/app/.data ./.container-backup
```

This backup includes private keys and credentials: keep it private and out of shared source archives. Do not edit JSON stores or copy a live volume. A different browser/PC must still opt in; copying server data cannot copy browser permission or subscriptions into another browser. See [operations](operations.md) for the data model and retention restrictions.

## Validation and image updates

```text
docker compose build --pull webpush
npm run container:smoke
```

The optional smoke command needs host Node 22.19+ (the actual app does not). It creates a uniquely named temporary Compose project, tests non-root startup, HTTP/admin access, persistent keys/subscriber/draft, crash recovery and revoked sessions, and removes only that temporary project's volumes afterward. It never activates a campaign or calls Azure/a real push service. Run native release checks separately as documented in the README.

Builds use the locked npm dependencies and the maintained Node 24 Debian image. Rebuild with `--pull` to pick up base-image security updates. Do not treat a locally built image as a pre-published multi-platform image; [Buildx](https://docs.docker.com/build/building/multi-platform/) can build a distribution image for both architectures when a registry is chosen.

For each installer's Azure account, use the optional [isolated Azure setup](azure-account-setup.md). It is not required for local Docker operation.
