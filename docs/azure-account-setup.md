# Prepare a different Azure account

Local Docker operation needs no Azure account and creates no Azure resources. The optional `azure` Compose service provides Microsoft's [Azure CLI container](https://learn.microsoft.com/en-us/cli/azure/run-azure-cli-docker?view=azure-cli-latest). Its authentication cache is stored in a separate named volume, rather than mounting this laptop's previous Azure sign-in or any historical smoke-test state. Each installer's Compose project has its own volumes.

The default cloud deployment policy remains **off**. The commands below prepare or inspect an account. They do not create resources, registrations, assignments, or budgets. Changing Azure accounts does not establish a new authorization to incur cloud charges.

## Sign in and select the intended account

These commands work in PowerShell, macOS Terminal, and Linux shells. Replace the uppercase placeholders with the new account's actual identifiers; do not enter the angle brackets from other examples.

```text
docker compose run --rm azure login --use-device-code --tenant NEW-TENANT-ID
docker compose run --rm azure account set --subscription NEW-SUBSCRIPTION-ID
docker compose run --rm azure account show --subscription NEW-SUBSCRIPTION-ID --query "{subscription:id,tenant:tenantId,name:name,state:state}" --output json
```

Complete the device-code prompt in the intended account. Verify both tenant and subscription before any resource operation. This does not change the host Azure CLI's default account. For another account, use `docker compose run --rm azure logout`, then sign in again; keep separate private profiles for distinct environments. [Microsoft's account-selection guidance](https://learn.microsoft.com/en-us/cli/azure/manage-azure-subscriptions-azure-cli?view=azure-cli-latest) explains tenants and subscriptions.

If you already use Azure CLI on the host, the equivalent login is `az login --tenant NEW-TENANT-ID`, followed by `az account set --subscription NEW-SUBSCRIPTION-ID`. Host and container sign-ins are separate.

## Save an account-specific target

Create the ignored `.azure-profiles` directory, copy `infra/azure-target.example.json` to `.azure-profiles/new-account.json`, and fill its `tenantId`, `subscriptionId`, and `location`. Keep the public example blank. With host Node/npm and Azure CLI installed, run:

```text
npm run check:cloud -- --azure --profile .azure-profiles/new-account.json
```

This preflight rejects a tenant/subscription mismatch and disabled subscription before resource queries, then checks Cosmos free-tier allocation and Node runtime availability in the selected region. Every subscription-scoped command includes the profile's subscription explicitly. It never selects the previous CLI default implicitly. Without host Node, use the container's `account show` command above, then these read-only checks:

```text
docker compose run --rm azure cosmosdb list --subscription NEW-SUBSCRIPTION-ID --query "[].{name:name,freeTier:enableFreeTier}" --output table
docker compose run --rm azure functionapp list-flexconsumption-runtimes --subscription NEW-SUBSCRIPTION-ID --location NEW-REGION --runtime node --output table
```

An unused Cosmos free-tier slot is one prerequisite; it does not guarantee offer eligibility, regional availability or zero charges.

## Prepare new environment parameters

Copy `infra/parameters.example.json` to `.azure-profiles/new-account.parameters.json`. It is visible inside the optional CLI container at `/workspace/profiles/new-account.parameters.json`. Enter the new environment's values:

| Field | Required value |
| --- | --- |
| `tenantId` | The intended new tenant, matching the target profile. |
| `apiClientId`, `spaClientId` | API and SPA app registration IDs in that tenant. Old-tenant application IDs cannot be reused as new registrations. |
| `administratorObjectId` | The administrator's object ID in the intended tenant; a guest's home-tenant ID may differ. |
| `webOrigin` | The actual new HTTPS frontend origin, without a trailing slash. Register its `/admin` redirect URI on the SPA. |
| `vapidPublicKey`, `vapidPrivateKey` | A matching environment-specific VAPID pair. Preserve a pair when migrating an existing environment/subscriptions; generate a new pair for an independent demo. |
| `vapidSubject` | The new operator's real `mailto:` contact. |
| `location` and limits | A checked region, one maximum Functions instance, at most 100 subscribers and 1,000 attempts/day by default. These limits do not cap currency spend. |

Once cloud provisioning is separately authorized, configure the new API registration to issue v2 access tokens, expose `api://API-CLIENT-ID/access_as_user`, configure the SPA's delegated permission and `/admin` redirect, and grant consent/preauthorization as the tenant requires. Only then supply the resulting IDs. Managed identities and role assignments are recreated for the new deployment; they are not copied from the removed historical environment. The Bicep file uses the selected subscription/resource group rather than a previous account's IDs.

To check Bicep syntax without provisioning:

```text
docker compose run --rm azure bicep build --file /workspace/infra/main.bicep --stdout
```

The public infra mount is read-only. A first Bicep invocation may download its compiler into the CLI's own auth/config volume. No resource group, app registration, deployment, or registry publication is performed by application startup or CI.

Before any later live deployment, choose a new owned resource group, verify Entra/resource permissions and billing eligibility, agree the spend policy, and create alerts for that new subscription/group and its chosen recipient. The old smoke-test email budget is tied to the previous subscription/group and does not follow the project. A new account still cannot guarantee a custom INR 100 hard cap through delayed billing alerts. See [the deployment policy](../infra/deployment-policy.json).

Keep `.azure-profiles`, Azure CLI caches, private parameters, VAPID keys and any future deployment credentials out of Git, images and shared source bundles. These paths are ignored by Git and the Docker build. The local app image contains neither Azure CLI credentials nor the removed cloud environment's settings.
