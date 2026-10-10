import fs from 'node:fs';
import path from 'node:path';

/**
 * Removes working files. Evidence and reports are kept unless --evidence is
 * given, because sealed evidence is the product of a review.
 *
 *   npm run clean                 working directories and build output
 *   npm run clean -- --evidence   also evidence/, evidence-archive/ and reports/
 */

const root = path.resolve(__dirname, '..');
const targets = ['.review-tmp', '.candidates', 'dist', 'test-results', 'playwright-report'];
if (process.argv.includes('--evidence')) targets.push('evidence', 'evidence-archive', 'reports');

// Sealed evidence is read-only; make it writable before removing it.
function unlock(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      fs.chmodSync(full, 0o755);
      unlock(full);
    } else fs.chmodSync(full, 0o644);
  }
}

for (const name of targets) {
  const dir = path.join(root, name);
  if (!fs.existsSync(dir)) continue;
  if (name !== '.candidates') unlock(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`[clean] removed ${name}/`);
}
