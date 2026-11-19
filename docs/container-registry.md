# Install a prebuilt image on another laptop

The project publishes to GitHub Container Registry (GHCR):

```text
ghcr.io/mentorbay2810/serverless-web-push-dashboard:0.1.0-rc.8
```

Each published image index contains Linux AMD64 and ARM64 variants. Docker selects the host architecture automatically: Windows Docker Desktop uses Linux containers, Intel/AMD Linux uses AMD64, and Apple Silicon uses ARM64. No host Node/npm, source checkout, GitHub token or Azure account is needed for the local app once the package is public.

## First publication: package visibility

The publishing workflow creates the actual package and checks both architecture manifests. GitHub creates new container packages as **Private**, even when their linked source repository is public. A package administrator must then open [the package settings](https://github.com/users/mentorbay2810/packages/container/serverless-web-push-dashboard/settings), choose **Change visibility → Public**, and confirm the package name. This is a one-time setting; public images can be downloaded without a GitHub sign-in. See [GitHub's visibility instructions](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility).

An unauthenticated pull must succeed before treating the image as available to everyone. If Docker reports denied/unauthorized, check package visibility first. App secrets are generated on the installing computer and are not included in the public image.

## Windows: PowerShell

Install/start Docker Desktop with Linux containers, open PowerShell in a new installation folder, and run:

```powershell
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/mentorbay2810/Serverless-Web-Push-Dashboard/SWPD/container-and-azure-portability/compose.image.yaml" -OutFile compose.yaml
docker compose pull
docker compose up -d --wait
docker compose exec webpush node dist/tools/admin-login.js
```

## macOS or Linux

With Docker and Compose available, open a terminal in a new installation folder:

```sh
curl -fsSL "https://raw.githubusercontent.com/mentorbay2810/Serverless-Web-Push-Dashboard/SWPD/container-and-azure-portability/compose.image.yaml" -o compose.yaml
docker compose pull
docker compose up -d --wait
docker compose exec webpush node dist/tools/admin-login.js
```

The download currently uses the reviewed container branch while PR #18 is open. After merging, the same file is available from `main`. The image reference is versioned independently of the source download URL.

Open [http://localhost:5173](http://localhost:5173) to subscribe. Open the private administrator link printed by the final command to manage campaigns. Browser permission and real notification display are still device-specific.

If the source is already checked out, keep its build-based Compose file and select the prebuilt installation explicitly:

```text
docker compose -f compose.image.yaml pull
docker compose -f compose.image.yaml up -d --wait
docker compose -f compose.image.yaml exec webpush node dist/tools/admin-login.js
```

The standalone file contains only the local application. For the optional Azure CLI and Bicep templates, download the full repository and follow [Azure account setup](azure-account-setup.md).

## Persistence and upgrades

Both installation methods use the same project/service/volume names. Stop an existing installation before changing methods. Never run two app containers against the same volume. Ordinary `docker compose down` preserves keys, subscribers and campaigns; `down --volumes` removes them. The [container operations guide](containers.md) covers private backups, recovery and port changes.

The port and contact address can be set in a local `.env` next to the downloaded file:

```dotenv
SWPD_WEB_PORT=5180
SWPD_VAPID_SUBJECT=mailto:your-address@example.org
```

For an upgrade, choose the desired published version by setting `SWPD_IMAGE`, then run `docker compose pull` and `docker compose up -d --wait`. These preserve the existing data volume. A different localhost port changes the browser origin and requires reconnecting.

For dissertation reproducibility, pin `SWPD_IMAGE` to the published `sha-<full-source-commit>` tag or an image digest, and retain that reference with the test evidence. The `latest` tag is updated only by publishing from `main`; the initial approved container branch publishes candidate/version and source-commit tags.

## Publishing and verification

The `Publish container image` workflow:

1. Runs only in this public repository on `main`, the explicitly authorized initial container branch, or manual dispatch on those refs. Pull requests and forks do not publish.
2. Builds AMD64 and ARM64 images and runs the full container smoke against both Compose files on each architecture. ARM64 runs under QEMU on the standard Linux runner.
3. Authenticates to GHCR with the repository's short-lived `GITHUB_TOKEN`, scoped to package publishing. No personal registry token or Azure credential is stored in the repository.
4. Publishes a combined image index with version and full source-commit tags, adds source/version/revision labels, and verifies both uploaded platforms by digest.

The existing local validation workflow continues to run separately. Publishing creates no Azure resources and changes no Azure deployment policy. [GitHub's current billing documentation](https://docs.github.com/en/billing/concepts/product-billing/github-packages) states that GHCR container storage and bandwidth are currently free; the workflow uses only standard public-repository runners.
