import { applyRetention, planRetention, restoreRetention } from './retention/local-history.js';
import { loadEnvironment } from './environment.js';

try {
  const [command = 'plan', argument, ...extra] = process.argv.slice(2);
  if (extra.length || !['plan', 'apply', 'restore'].includes(command)
    || (command !== 'plan' && !argument) || (command === 'plan' && argument !== undefined && !/^\d+$/.test(argument))) {
    throw new Error('Usage: npm run local:retention -- plan [days] | apply <plan-id> | restore <backup-id>');
  }
  const { dataDirectory } = loadEnvironment();
  if (command === 'plan') {
    const plan = await planRetention(dataDirectory, argument === undefined ? 30 : Number(argument));
    console.log(JSON.stringify({ planId: plan.id, cutoff: plan.cutoff, days: plan.days, eligibleCampaigns: plan.campaignIds.length,
      eligibleDeliveries: plan.deliveryIds.length, changed: false }, null, 2));
    console.log('Preview only. Stop the backend before retention. Plans expire after 24 hours or any queued-state change.');
  } else if (command === 'apply') console.log(JSON.stringify(await applyRetention(dataDirectory, argument!), null, 2));
  else console.log(JSON.stringify(await restoreRetention(dataDirectory, argument!), null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : '';
  // Filesystem errors may include private paths; only tool-authored errors are printed.
  console.error((error as NodeJS.ErrnoException).code ? 'Retention could not access private local files. Preserve state and inspect permissions, file types, and the data-directory lock.' : message || 'Retention failed.');
  process.exitCode = 1;
}
