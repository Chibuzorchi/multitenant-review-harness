import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Review orchestrator.
 *
 *   npm run review                      initial review of HEAD
 *   npm run review -- --sha <sha>       initial review of a specific commit
 *   npm run review:security             security stages only
 *   npm run review:retest               retest the latest fix claim against the latest initial run
 *   npm run review -- --gate            exit 1 if release-blocking findings are open
 *
 * The candidate is always a commit: it is exported with `git archive` and run
 * from that export (or built into a Docker image with REVIEW_TARGET=docker),
 * so what is reviewed is exactly what the SHA in the manifest names.
 */

const root = path.resolve(__dirname, '..');
const STAGE_IDS = ['01-baseline', '02-role-matrix', '03-sessions', '04-tenant-isolation', '05-module-denial', '06-reconciliation', '07-scheduled', '08-containment'];
const APP_PORT = Number(process.env.REVIEW_APP_PORT ?? 3100);
const SINK_PORT = Number(process.env.REVIEW_SINK_PORT ?? 4110);

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const log = (message: string) => console.log(`[review] ${message}`);

function fail(message: string, code = 2): never {
  console.error(`[review] ${message}`);
  process.exit(code);
}

function nextRunId(evidenceRoot: string): string {
  const day = new Date().toISOString().slice(0, 10);
  const prefix = `RUN-${day}-`;
  const taken = fs.existsSync(evidenceRoot) ? fs.readdirSync(evidenceRoot).filter((name) => name.startsWith(prefix)).map((name) => Number(name.slice(prefix.length))) : [];
  return `${prefix}${String(Math.max(0, ...taken.filter(Number.isFinite)) + 1).padStart(3, '0')}`;
}

function exportCandidate(sha: string): string {
  const dir = path.join(root, '.candidates', sha);
  if (!fs.existsSync(path.join(dir, 'package.json'))) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const archive = execFileSync('git', ['archive', '--format=tar', sha], { cwd: root, maxBuffer: 256 * 1024 * 1024 });
    execFileSync('tar', ['-x', '-C', dir], { input: archive });
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  }
  return dir;
}

async function waitForHealth(url: string, expect: (body: Record<string, unknown>) => boolean, seconds: number): Promise<boolean> {
  for (let attempt = 0; attempt < seconds * 4; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok && expect((await res.json()) as Record<string, unknown>)) return true;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

interface Candidate {
  mode: 'local-process' | 'docker';
  image: { ref: string | null; id: string | null; digest: string | null };
  sinkInternalUrl: string;
  allowedHosts: string;
  stop(): void;
}

function startLocal(dir: string, sha: string, targetDir: string): Candidate {
  const children: ChildProcess[] = [];
  const launch = (entry: string, env: Record<string, string>, logName: string) => {
    const out = fs.openSync(path.join(targetDir, 'logs', logName), 'a');
    const child = spawn(process.execPath, ['--import', 'tsx', entry], { cwd: dir, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env }, stdio: ['ignore', out, out] });
    children.push(child);
  };
  launch('referraldesk/src/sink.ts', { SINK_PORT: String(SINK_PORT), SINK_HOST: '127.0.0.1', SINK_LOG: path.join(targetDir, 'sink', 'receipts.jsonl') }, 'sink-stdout.txt');
  launch(
    'referraldesk/src/server.ts',
    { PORT: String(APP_PORT), HOST: '127.0.0.1', DB_PATH: path.join(targetDir, 'referraldesk.db'), LOG_DIR: path.join(targetDir, 'logs'), APP_ENV: 'review-local', BUILD_SHA: sha, SINK_URL: `http://127.0.0.1:${SINK_PORT}`, SEED_ON_START: 'true', SCHEDULER_ENABLED: 'false', PATIENT_MODULE_ENABLED: 'false' },
    'application-stdout.txt',
  );
  return {
    mode: 'local-process',
    image: { ref: null, id: null, digest: null },
    sinkInternalUrl: `http://127.0.0.1:${SINK_PORT}`,
    allowedHosts: '',
    stop: () => children.forEach((child) => child.kill('SIGTERM')),
  };
}

function startDocker(dir: string, sha: string, targetDir: string, runId: string): Candidate {
  const ref = `referraldesk-review:${sha.slice(0, 12)}`;
  const project = `rdreview-${runId.toLowerCase()}`;
  const docker = (args: string[], env: Record<string, string> = {}) => {
    const result = spawnSync('docker', args, { cwd: dir, env: { ...process.env, ...env }, stdio: ['ignore', 'inherit', 'inherit'] });
    if (result.status !== 0) fail(`docker ${args.slice(0, 2).join(' ')} failed`);
  };
  log(`building image ${ref}`);
  docker(['build', '-q', '-t', ref, '--build-arg', `BUILD_SHA=${sha}`, '.']);
  const inspect = (format: string) => execFileSync('docker', ['image', 'inspect', '--format', format, ref], { encoding: 'utf8' }).trim();
  const id = inspect('{{.Id}}');
  const digest = inspect('{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}') || null;
  fs.chmodSync(targetDir, 0o777);
  const env = { REFERRALDESK_IMAGE: ref, BUILD_SHA: sha, APP_PORT: String(APP_PORT), SINK_PORT: String(SINK_PORT), REFERRALDESK_DATA: targetDir, APP_ENV: 'review-docker', COMPOSE_PROJECT_NAME: project };
  docker(['compose', '-p', project, 'up', '-d', '--no-build'], env);
  return {
    mode: 'docker',
    image: { ref, id, digest },
    sinkInternalUrl: 'http://sink:4010',
    allowedHosts: 'sink',
    stop: () => {
      spawnSync('docker', ['compose', '-p', project, 'logs', '--no-color'], { cwd: dir, env: { ...process.env, ...env }, stdio: ['ignore', fs.openSync(path.join(targetDir, 'logs', 'containers-stdout.txt'), 'a'), 'ignore'] });
      spawnSync('docker', ['compose', '-p', project, 'down', '--remove-orphans'], { cwd: dir, env: { ...process.env, ...env }, stdio: 'ignore' });
    },
  };
}

async function main(): Promise<void> {
  const kind = arg('kind') === 'retest' ? 'retest' : 'initial';
  const stages = (arg('stages') ?? STAGE_IDS.map((id) => id.slice(0, 2)).join(',')).split(',').map((prefix) => STAGE_IDS.find((id) => id.startsWith(prefix.trim())) ?? fail(`Unknown stage "${prefix}"`));
  if (!stages.includes('01-baseline')) stages.unshift('01-baseline');
  const evidenceRoot = path.resolve(root, process.env.REVIEW_EVIDENCE_ROOT ?? 'evidence');
  const workDir = path.resolve(root, process.env.REVIEW_WORK_DIR ?? '.review-tmp');

  let sha: string;
  let baseline: string | null = null;
  if (kind === 'retest') {
    const ledgerFile = path.join(evidenceRoot, 'ledger.json');
    const ledger = fs.existsSync(ledgerFile) ? (JSON.parse(fs.readFileSync(ledgerFile, 'utf8')) as { latest_cycle: string | null; cycles: Record<string, { baseline_sha: string; fix_claims: Array<{ sha: string }> }> }) : null;
    baseline = arg('baseline') ?? ledger?.latest_cycle ?? fail('No initial review run found to retest against. Run `npm run review` first.');
    const cycle = ledger?.cycles[baseline] ?? fail(`Run ${baseline} is not an initial review run in the ledger.`);
    const claimed = arg('sha') ?? cycle.fix_claims.at(-1)?.sha ?? fail('No fix has been claimed for this run. Record one with `npm run demo:remediate` (demo) or `npm run demo:remediate -- --claim --sha <sha>`, or pass --sha.');
    sha = git('rev-parse', '--verify', `${claimed}^{commit}`);
    // A retest must be of a different build; re-running the same build proves nothing about a fix.
    if (sha === cycle.baseline_sha) fail(`The retest candidate ${sha.slice(0, 12)} is the same build as the original run. A retest needs a new build.`);
  } else {
    sha = git('rev-parse', '--verify', `${arg('sha') ?? 'HEAD'}^{commit}`);
  }

  const runId = process.env.REVIEW_RUN_ID ?? nextRunId(evidenceRoot);
  const runWork = path.join(workDir, runId);
  const targetDir = path.join(runWork, 'target');
  fs.rmSync(runWork, { recursive: true, force: true });
  fs.mkdirSync(path.join(targetDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(targetDir, 'sink'), { recursive: true });

  const dirty = git('status', '--porcelain').length > 0;
  const harnessSha = `${git('rev-parse', 'HEAD')}${dirty ? '+uncommitted-changes' : ''}`;
  const baseUrl = `http://127.0.0.1:${APP_PORT}`;
  const sinkUrl = `http://127.0.0.1:${SINK_PORT}`;

  if (await waitForHealth(`${baseUrl}/healthz`, () => true, 1)) fail(`Something is already listening on ${baseUrl}. Stop it, or set REVIEW_APP_PORT.`);

  log(`${kind} review ${runId} of ${sha.slice(0, 12)}${baseline ? ` (retest of ${baseline})` : ''}`);
  const dir = exportCandidate(sha);
  const mode = process.env.REVIEW_TARGET === 'docker' ? 'docker' : 'local';
  const candidate = mode === 'docker' ? startDocker(dir, sha, targetDir, runId) : startLocal(dir, sha, targetDir);
  let stopped = false;
  const stop = () => {
    if (!stopped) candidate.stop();
    stopped = true;
  };
  process.on('SIGINT', () => {
    stop();
    process.exit(130);
  });

  const env: Record<string, string> = {
    REVIEW_RUN_ID: runId,
    REVIEW_KIND: kind,
    REVIEW_BASE_URL: baseUrl,
    REVIEW_SINK_URL: sinkUrl,
    REVIEW_SINK_INTERNAL_URL: candidate.sinkInternalUrl,
    REVIEW_ALLOWED_HOSTS: candidate.allowedHosts,
    REVIEW_DB_PATH: path.join(targetDir, 'referraldesk.db'),
    REVIEW_LOG_DIR: path.join(targetDir, 'logs'),
    REVIEW_SINK_LOG: path.join(targetDir, 'sink', 'receipts.jsonl'),
    REVIEW_EVIDENCE_ROOT: evidenceRoot,
    REVIEW_WORK_DIR: workDir,
    REVIEW_CANDIDATE_SHA: sha,
    REVIEW_CANDIDATE_IMAGE: candidate.image.id ?? '',
    REVIEW_CANDIDATE_IMAGE_REF: candidate.image.ref ?? '',
    REVIEW_CANDIDATE_IMAGE_DIGEST: candidate.image.digest ?? '',
    REVIEW_TARGET_MODE: candidate.mode,
    REVIEW_HARNESS_SHA: harnessSha,
    REVIEW_BASELINE_RUN: baseline ?? '',
  };
  Object.assign(process.env, env);
  fs.writeFileSync(path.join(runWork, 'run-env.json'), JSON.stringify(env, null, 2) + '\n');

  // From here on this process may only talk to the review environment.
  const { installHarnessEgressGuard } = await import('../review-harness/lib/egress-guard');
  installHarnessEgressGuard('orchestrator');
  const { loadTarget } = await import('../adapters');
  const { appendJsonl, runPaths } = await import('../review-harness/lib/run');

  let exitCode = 0;
  try {
    const up = await waitForHealth(`${baseUrl}/healthz`, (body) => body.build_sha === sha, 60);
    if (!up || !(await waitForHealth(`${sinkUrl}/healthz`, () => true, 20))) {
      stop();
      fail(`The candidate did not start, or did not report build ${sha.slice(0, 12)}. See ${path.join(targetDir, 'logs')}.`);
    }
    const target = loadTarget();
    await target.outbound.clearReceived();

    for (const stage of stages) {
      // The runner blocks this process, so a pooled connection may have been closed by the server meanwhile: retry once.
      await target.control.reset().catch(() => target.control.reset());
      const invocations = stage === '08-containment' ? [{ name: stage, projects: ['api', 'desktop-chromium', 'mobile-chromium'] }, { name: `${stage}-final`, projects: ['final'] }] : [{ name: stage, projects: ['api', 'desktop-chromium', 'mobile-chromium'] }];
      let stageExit = 0;
      for (const invocation of invocations) {
        const started = new Date().toISOString();
        log(`stage ${invocation.name}`);
        const result = spawnSync(process.execPath, [path.join(root, 'node_modules', '@playwright', 'test', 'cli.js'), 'test', `review-harness/${stage}/`, ...invocation.projects.flatMap((project) => ['--project', project])], {
          cwd: root,
          env: { ...process.env, REVIEW_STAGE: invocation.name, PLAYWRIGHT_FORCE_TTY: '0', CI: '1' },
          stdio: ['ignore', has('verbose') ? 'inherit' : fs.openSync(path.join(runWork, `stage-${invocation.name}.txt`), 'w'), 'inherit'],
        });
        stageExit = Math.max(stageExit, result.status ?? 1);
        appendJsonl(runPaths.stageLog(), { stage, invocation: invocation.name, started, finished: new Date().toISOString(), exit_code: result.status });
        log(`stage ${invocation.name}: ${result.status === 0 ? 'all checks passed' : 'checks failed (see report)'}`);
      }
      if (stage === '01-baseline' && stageExit !== 0) {
        log('The baseline stage failed: the environment is not the one this review is scoped for. Later stages were not run.');
        exitCode = 2;
        break;
      }
    }
  } finally {
    stop();
  }

  log('stage 09-report');
  const report = spawnSync(process.execPath, ['--import', 'tsx', path.join(root, 'review-harness', '09-report', 'generate.ts'), '--run', runId, ...(has('gate') ? ['--gate'] : [])], { cwd: root, env: process.env, stdio: 'inherit' });
  if (report.status !== 0 && exitCode === 0) exitCode = report.status ?? 1;
  process.exit(exitCode);
}

void main();
