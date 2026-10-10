import { config } from './config';
import { installEgressGuard } from './egress';

installEgressGuard({ allowHosts: config.egressAllowHosts, logDir: config.logDir });

import { buildApp } from './app';
import { getMeta } from './db';
import { startScheduler } from './jobs';
import { runSeed } from './seed';

if (config.seedOnStart || !getMeta('seed_hash')) {
  const seeded = runSeed();
  console.log(`seeded ${seeded.seed_version} ${seeded.seed_hash.slice(0, 12)}`);
}
if (config.schedulerEnabled) startScheduler();

buildApp().listen(config.port, config.host, () => {
  console.log(`ReferralDesk listening on http://${config.host}:${config.port} (build ${config.buildSha.slice(0, 12)}, ${config.environmentName})`);
});
