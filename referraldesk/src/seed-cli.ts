import { config } from './config';
import { runSeed } from './seed';

const result = runSeed();
console.log(`Seeded ${config.dbPath}`);
console.log(JSON.stringify(result, null, 2));
