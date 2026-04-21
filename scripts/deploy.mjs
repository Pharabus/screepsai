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

const data = await res.json();

if (res.ok && data.ok) {
  console.log('Deploy successful.');

  // Fetch branch list to confirm and show active branch
  const branchRes = await fetch('https://screeps.com/api/user/branches', {
    headers: { 'X-Token': token },
  });
  if (branchRes.ok) {
    const branchData = await branchRes.json();
    const branches = branchData.list || [];
    console.log('\nBranches on server:');
    for (const b of branches) {
      const active = b.activeWorld ? ' [ACTIVE on world]' : '';
      const sim = b.activeSim ? ' [ACTIVE on sim]' : '';
      const marker = b.branch === branch ? ' <-- deployed here' : '';
      console.log(`  ${b.branch}${active}${sim}${marker}`);
    }
    const target = branches.find((b) => b.branch === branch);
    if (target && !target.activeWorld) {
      console.log(`\n⚠ Branch "${branch}" is NOT the active world branch.`);
      console.log('Activate it in the game code editor, or set SCREEPS_BRANCH in .env to your active branch.');
    }
  }
} else {
  console.error(`Deploy failed (${res.status}):`, data);
  process.exit(1);
}
