#!/usr/bin/env node
/**
 * Secret scan (PRD §22 "automated secret scan"). Fails if a tracked file, or the built web
 * bundle, contains something that looks like a credential:
 *
 * - platform secrets: ingestion keys (`aop_<id>.<secret>`) and webhook signing secrets (`whsec_…`)
 * - connection strings with an embedded password, private keys, AWS access keys
 * - any committed `.env` file other than `.env.example`
 * - the actual values of the secrets in your local `.env`, if present, anywhere in tracked files
 *   or in apps/web/dist (the browser bundle must never contain server secrets)
 *
 *   npm run scan:secrets
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const PATTERNS = [
  ['ingestion API key', /\baop_[A-Za-z0-9]{8,}\.[A-Za-z0-9_-]{20,}/],
  ['webhook signing secret', /\bwhsec_[A-Za-z0-9_-]{20,}/],
  [
    'connection string with password',
    /\b(?:mongodb(?:\+srv)?|rediss?|postgres(?:ql)?):\/\/[^\s/:@'"]+:[^\s@'"]+@/,
  ],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
];
const SECRET_VARS = [
  'SESSION_SECRET',
  'TELEMETRY_KEY_PEPPER',
  'OPERATOR_TOKEN',
  'WEBHOOK_ENCRYPTION_KEY',
  'MONGODB_URI',
  'REDIS_URL',
];

// Tracked files plus new files that are not git-ignored (what the next commit could include).
const tracked = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  {
    encoding: 'utf8',
  },
)
  .split('\0')
  .filter(Boolean)
  .filter((f) => existsSync(f));

const bundle = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else bundle.push(full);
  }
};
if (existsSync('apps/web/dist')) walk('apps/web/dist');

// Real secret values from the local .env (never printed).
const localSecrets = [];
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (!m || !SECRET_VARS.includes(m[1])) continue;
    const value = m[2].replace(/^["']|["']$/g, '');
    // Local defaults such as mongodb://localhost are not secrets.
    if (
      value.length >= 16 &&
      !/^(change-me|mongodb:\/\/localhost|redis:\/\/localhost)/.test(value)
    ) {
      localSecrets.push([m[1], value]);
    }
  }
}

const findings = [];
for (const file of tracked) {
  if (/(^|\/)\.env(\.|$)/.test(file) && !file.endsWith('.env.example')) {
    findings.push(`${file}: committed environment file`);
  }
}
for (const file of [...tracked, ...bundle]) {
  let text;
  try {
    const buf = readFileSync(file);
    if (buf.includes(0)) continue; // binary
    text = buf.toString('utf8');
  } catch {
    continue;
  }
  for (const [label, pattern] of PATTERNS) {
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (pattern.test(line)) findings.push(`${file}:${i + 1}: ${label}`);
    });
  }
  for (const [name, value] of localSecrets) {
    if (text.includes(value)) findings.push(`${file}: contains the value of ${name} from .env`);
  }
}

const scanned = `${tracked.length} tracked files${bundle.length ? ` and ${bundle.length} web bundle files` : ''}`;
if (findings.length === 0) {
  process.stdout.write(
    `✔ No secrets found in ${scanned}${localSecrets.length ? ` (also checked ${localSecrets.length} .env values)` : ''}.\n`,
  );
} else {
  process.stdout.write(`✖ Possible secrets in ${scanned}:\n  ${findings.join('\n  ')}\n`);
  process.exit(1);
}
