#!/usr/bin/env node
// Offline credential issuance. Neither the master secret nor derived token is logged.
import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const [secretFile, slugFile, run, output] = process.argv.slice(2);
if (!secretFile || !slugFile || !/^[a-zA-Z0-9_-]{1,64}$/.test(run || '') || !output || process.argv.length !== 6) {
  process.stderr.write('Usage: node scripts/live-metrics-token.mjs SECRET_FILE SLUG_FILE RUN_ID NEW_TOKEN_FILE\n');
  process.exit(2);
}
try {
  const secret = readFileSync(secretFile, 'utf8').trim();
  const slug = readFileSync(slugFile, 'utf8').trim();
  if (secret.length < 32 || !/^[0-9a-f]{16,64}$/.test(slug)) throw new Error('invalid credential inputs');
  const token = createHmac('sha256', secret).update(`moracles-live-v1\n${slug}\n${run}`).digest('hex');
  writeFileSync(output, `${token}\n`, { mode: 0o600, flag: 'wx' });
  process.stdout.write('Scoped credential written with owner-only permissions.\n');
} catch {
  process.stderr.write('Credential issuance failed; check inputs and use a new output file.\n');
  process.exit(1);
}
