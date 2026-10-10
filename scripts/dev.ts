import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

/** Runs ReferralDesk and its outbound sink locally, on loopback only: http://127.0.0.1:3000 */

const root = path.resolve(__dirname, '..');
const appPort = process.env.PORT ?? '3000';
const sinkPort = process.env.SINK_PORT ?? '4010';
const children: ChildProcess[] = [];

function launch(entry: string, env: Record<string, string>): void {
  const child = spawn(process.execPath, ['--import', 'tsx', entry], { cwd: root, env: { ...process.env, ...env }, stdio: 'inherit' });
  child.on('exit', (code) => {
    for (const other of children) if (other !== child) other.kill();
    process.exit(code ?? 0);
  });
  children.push(child);
}

launch('referraldesk/src/sink.ts', { SINK_HOST: '127.0.0.1', SINK_PORT: sinkPort });
launch('referraldesk/src/server.ts', {
  HOST: '127.0.0.1',
  PORT: appPort,
  SINK_URL: `http://127.0.0.1:${sinkPort}`,
  SEED_ON_START: process.env.SEED_ON_START ?? 'true',
  PATIENT_MODULE_ENABLED: process.env.PATIENT_MODULE_ENABLED ?? 'false',
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    for (const child of children) child.kill(signal);
  });
}
