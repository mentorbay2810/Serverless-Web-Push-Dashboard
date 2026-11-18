import { projectRoot } from './environment.js';
import { setupLocal } from './setup-local.js';

setupLocal(projectRoot).then(({ created }) => {
  console.log(created ? 'Created private local configuration in .env. No keys were printed.' : 'Local configuration is valid. Existing keys and subscriptions were preserved.');
  console.log('Run npm run dev:queued, then open the configured WEB_ORIGIN.');
}).catch(error => { console.error(error.message); process.exitCode = 1; });
