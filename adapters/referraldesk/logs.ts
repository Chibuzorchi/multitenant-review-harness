import fs from 'node:fs';
import path from 'node:path';
import { environment } from '../../config/environment';
import type { AccessLogEntry, BlockedEgress, LogsAdapter } from '../logs';

function jsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

const accessFile = () => path.join(environment.logDir, 'access.jsonl');
const egressFile = () => path.join(environment.logDir, 'egress-blocked.jsonl');

export const logs: LogsAdapter = {
  access: (from, to) => jsonl<AccessLogEntry>(accessFile()).filter((entry) => entry.ts >= from && entry.ts <= to),
  blockedEgress: () => jsonl<BlockedEgress>(egressFile()),
  archive: () => [
    ['application-access.jsonl', accessFile()],
    ['application-egress-blocked.jsonl', egressFile()],
  ],
};
