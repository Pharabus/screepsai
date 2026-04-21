/**
 * Deploy dist/main.js to Screeps world servers via the HTTP API.
 * Reads SCREEPS_TOKEN and SCREEPS_BRANCH from .env or environment variables.
 *
 * Usage: node scripts/deploy.mjs
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// Load .env file if present
try {
  const envFile = readFileSync(resolve(root, '.env'), 'utf8');
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
} catch {
  // no .env file, rely on environment variables
}

const token = process.env.SCREEPS_TOKEN;
const branch = process.env.SCREEPS_BRANCH || 'default';

if (!token || token === 'your-token-here') {
  console.error('Error: SCREEPS_TOKEN not set.');
  console.error('Create a .env file from .env.example and add your auth token.');
  console.error('Get a token at: https://screeps.com/a/#!/account/auth-tokens');
  process.exit(1);
}

// Read the built main.js
const mainJs = readFileSync(resolve(root, 'dist/main.js'), 'utf8');

const body = JSON.stringify({
  branch,
  modules: { main: mainJs },
});

console.log(`Deploying to branch "${branch}" (${mainJs.length} chars)...`);

const res = await fetch('https://screeps.com/api/user/code', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Token': token,
  },
  body,
});

if (res.ok) {
  const data = await res.json();
  console.log('Deploy successful:', data);
} else {
  const text = await res.text();
  console.error(`Deploy failed (${res.status}): ${text}`);
  process.exit(1);
}
