export interface AzureTarget { schemaVersion: 1; tenantId: string; subscriptionId: string; location: string }
const guid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function parseAzureTarget(input: unknown): AzureTarget {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Provide an Azure target JSON object.');
  const value = input as Record<string, unknown>;
  if (value.schemaVersion !== 1 || Object.keys(value).some(key => !['schemaVersion', 'tenantId', 'subscriptionId', 'location'].includes(key))) throw new Error('Use the fields in infra/azure-target.example.json.');
  for (const key of ['tenantId', 'subscriptionId']) {
    if (typeof value[key] !== 'string' || !guid.test(value[key]) || value[key] === '00000000-0000-0000-0000-000000000000') throw new Error(`Set ${key} to the intended new Azure account's GUID.`);
  }
  if (typeof value.location !== 'string' || !/^[a-z][a-z0-9]{1,31}$/.test(value.location)) throw new Error('Set location to an Azure region identifier such as centralindia.');
  return { schemaVersion: 1, tenantId: (value.tenantId as string).toLowerCase(), subscriptionId: (value.subscriptionId as string).toLowerCase(), location: value.location };
}
export type AzureRead = (args: string[]) => unknown;
/** Every subscription-scoped read names the intended subscription explicitly. */
export function checkAzureTarget(input: unknown, read: AzureRead) {
  const target = parseAzureTarget(input);
  const scoped = (args: string[]) => read([...args, '--subscription', target.subscriptionId]);
  const account = scoped(['account', 'show']) as { id?: string; tenantId?: string; state?: string };
  if (account?.id?.toLowerCase() !== target.subscriptionId || account.tenantId?.toLowerCase() !== target.tenantId) throw new Error('Azure tenant/subscription does not match the target profile. Sign in to the new tenant and select its subscription.');
  if (account.state !== 'Enabled') throw new Error('The intended Azure subscription is not enabled.');
  const accounts = scoped(['cosmosdb', 'list']);
  if (!Array.isArray(accounts)) throw new Error('Cosmos free-tier eligibility could not be checked.');
  const runtimes = scoped(['functionapp', 'list-flexconsumption-runtimes', '--location', target.location, '--runtime', 'node']);
  if (!Array.isArray(runtimes)) throw new Error('Flex Consumption runtimes could not be checked.');
  return { freeTierAccountPresent: accounts.some(row => row?.enableFreeTier === true),
    nodeRuntimes: runtimes.map(row => row?.version).filter((version): version is string => typeof version === 'string') };
}
