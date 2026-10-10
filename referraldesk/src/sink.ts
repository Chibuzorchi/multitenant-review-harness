import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

/**
 * Local outbound sink. Stands in for every third-party provider (email, SMS,
 * ad platform, billing, webhook receivers). It accepts and records; it never
 * forwards anything.
 */

const port = Number(process.env.SINK_PORT ?? 4010);
const host = process.env.SINK_HOST ?? '127.0.0.1';
const file = path.resolve(process.env.SINK_LOG ?? 'data/sink/receipts.jsonl');
fs.mkdirSync(path.dirname(file), { recursive: true });

interface Receipt {
  received_at: string;
  event_id: string;
  tenant: number | null;
  type: string;
  destination: string;
  payload: unknown;
  timestamp: string;
}

const load = (): Receipt[] =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Receipt)
    : [];

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));

app.get('/healthz', (_req, res) => void res.json({ status: 'ok', service: 'outbound-sink' }));

app.post('/capture', (req, res) => {
  const receipt: Receipt = { received_at: new Date().toISOString(), ...req.body };
  fs.appendFileSync(file, JSON.stringify(receipt) + '\n');
  res.status(202).json({ captured: true });
});

app.get('/receipts', (_req, res) => void res.json({ rows: load() }));

app.delete('/receipts', (_req, res) => {
  fs.writeFileSync(file, '');
  res.json({ cleared: true });
});

app.listen(port, host, () => console.log(`outbound sink listening on http://${host}:${port}`));
