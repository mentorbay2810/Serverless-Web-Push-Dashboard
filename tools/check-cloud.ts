import { spawnSync } from 'node:child_process';

const version = process.versions.node;
console.log(`Node.js: ${version} (24 recommended; 22.19+ supported locally).`);
for (const [label, command] of [['Azure CLI', 'az'], ['Functions Core Tools', 'func']] as const) {
  const result = spawnSync('/usr/bin/which', [command], { encoding: 'utf8' });
  console.log(`${label}: ${result.status === 0 ? 'installed' : 'not installed'}.`);
}
console.log('Account, free-tier availability, region, and Entra tenant access require an authenticated Azure check.');
if (process.argv.includes('--azure')) {
  const index = process.argv.indexOf('--region');
  const region = index >= 0 ? process.argv[index + 1] : 'centralindia';
  if (!region || !/^[a-z]+$/.test(region)) throw new Error('Use an Azure region name such as centralindia.');
  function azure(args: string[]): string | undefined {
    const result = spawnSync('az', [...args, '--only-show-errors'], { encoding: 'utf8', timeout: 25_000 });
    return result.status === 0 ? result.stdout.trim() : undefined;
  }
  const state = azure(['account', 'show', '--query', 'state', '--output', 'tsv']);
  console.log(`Azure subscription: ${state === 'Enabled' ? 'active sign-in verified' : 'not verified; authenticate with Azure CLI before deployment'}.`);
  if (state === 'Enabled') {
    const count = azure(['cosmosdb', 'list', '--query', 'length([?enableFreeTier == `true`])', '--output', 'json']);
    console.log(`Cosmos free-tier account: ${count === undefined ? 'availability not verified' : Number(count) === 0 ? 'none currently enabled; free-tier slot appears unused' : 'already allocated; plan reuse or an alternative before deployment'}.`);
    const versions = azure(['functionapp', 'list-flexconsumption-runtimes', '--location', region, '--runtime', 'node', '--query', '[].version', '--output', 'json']);
    console.log(`Flex Consumption Node runtimes in ${region}: ${versions ? JSON.stringify(JSON.parse(versions)) : 'not verified'}.`);
    console.log('Entra application registration permissions and billing-offer eligibility still need verification before deployment.');
  }
}
console.log('No Azure resources were created. See docs/foundation.md for the deployment preflight.');
