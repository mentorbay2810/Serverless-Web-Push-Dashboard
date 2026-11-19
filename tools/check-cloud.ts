import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { checkAzureTarget, parseAzureTarget } from './azure-target.js';

try {
  const { values } = parseArgs({ options: { azure: { type: 'boolean' }, profile: { type: 'string' } } });
  // Windows distributes these CLIs as .cmd launchers. Cloud arguments below
  // are fixed literals or values validated by parseAzureTarget before execution.
  const shell = process.platform === 'win32';
  const installed = (command: string) => spawnSync(command, ['--version'], { shell, stdio: 'ignore', timeout: 10000 }).status === 0;
  console.log(`Node.js: ${process.versions.node} (24 recommended; 22.19+ supported locally).`);
  console.log(`Azure CLI: ${installed('az') ? 'installed' : 'not installed; the optional Docker azure service is also available'}.`);
  console.log(`Functions Core Tools: ${installed('func') ? 'installed' : 'not installed'}.`);
  if (values.azure) {
    if (!values.profile) throw new Error('Use --azure --profile .azure-profiles/new-account.json. An explicit tenant and subscription prevent checking the previous account by mistake.');
    const target = parseAzureTarget(JSON.parse(await readFile(values.profile, 'utf8')));
    const result = checkAzureTarget(target, args => {
      const response = spawnSync('az', [...args, '--only-show-errors', '--output', 'json'], { encoding: 'utf8', shell, timeout: 25000 });
      if (response.status !== 0) throw new Error('Azure CLI could not verify the target. Sign in to its tenant, check permissions, and retry. No resources were created.');
      return JSON.parse(response.stdout);
    });
    console.log('Target tenant, subscription, and enabled state verified.');
    console.log(result.freeTierAccountPresent ? 'Cosmos free tier is already allocated in this subscription; inspect reuse before deployment.' : 'No free-tier Cosmos account found. Billing-offer eligibility still needs verification.');
    console.log(`Flex Consumption Node runtimes in ${target.location}: ${result.nodeRuntimes.join(', ') || 'none reported'}.`);
    console.log('New Entra API/SPA registrations, administrator identity, and billing permissions must be configured for this target.');
  } else console.log('For an account-specific read-only check, use --azure --profile .azure-profiles/new-account.json.');
  console.log('No Azure resources were created. Cloud deployment remains disabled. See docs/azure-account-setup.md.');
} catch (error) {
  console.error((error as NodeJS.ErrnoException).code ? 'Could not read the target profile or run the required CLI. Check the path and installation.' : error instanceof Error ? error.message : 'Cloud readiness check failed.');
  process.exitCode = 1;
}
