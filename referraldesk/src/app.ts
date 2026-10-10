import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { attachAuth } from './auth';
import { APP_VERSION, config } from './config';
import { getMeta } from './db';
import { api } from './routes/api';
import { ops } from './routes/ops';
import { patients } from './routes/patients';
import { ui } from './routes/ui';

export function buildApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '200kb' }));
  app.use(express.urlencoded({ extended: false }));

  fs.mkdirSync(config.logDir, { recursive: true });
  const accessLog = path.join(config.logDir, 'access.jsonl');

  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
    next();
  });
  app.use(attachAuth);
  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      // Path only: query strings and bodies are never logged, and neither are credentials.
      const entry = { ts: new Date().toISOString(), method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - started, tenant_id: req.auth?.user.tenant_id ?? null, user_id: req.auth?.user.id ?? null, role: req.auth?.user.role ?? null };
      fs.appendFile(accessLog, JSON.stringify(entry) + '\n', () => undefined);
    });
    next();
  });

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', application: 'ReferralDesk', version: APP_VERSION, build_sha: config.buildSha, environment: config.environmentName, seed_version: getMeta('seed_version'), seed_hash: getMeta('seed_hash') });
  });

  app.use('/ops', ops);
  app.use('/api', patients);
  app.use('/api', api);
  app.use('/api', (_req, res) => void res.status(404).json({ error: 'NOT_FOUND' }));
  app.use('/', ui);

  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    console.error(`${req.method} ${req.path} failed:`, err);
    if (res.headersSent) return;
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  });
  return app;
}
