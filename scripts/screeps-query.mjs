/**
 * Query the live Screeps bot via the HTTP API — a context-cheap alternative to
 * the screeps-mcp server for read-only inspection. The MCP read tools dump large
 * raw payloads (console buffers with log chatter, whole Memory subtrees, room
 * object lists) into the agent context; this script does the filtering in-game
 * (probe) or scopes the read to a Memory path (mem) and prints ONLY the compact
 * result to stdout, so only the small filtered object ever reaches context.
 *
 * Auth reuses the SAME pattern as scripts/deploy.mjs: SCREEPS_TOKEN from a
 * gitignored .env, sent as the X-Token header. The token is NEVER printed and
 * NEVER passed as a CLI arg (it is read from process.env only).
 *
 * Usage:
 *   node scripts/screeps-query.mjs mem <path> [--shard shard3]
 *       GET a Memory subtree (dot path, e.g. "boostStats" or "rooms.W43N58").
 *       Omit <path> (or pass "") for the whole of Memory (large — prefer a path).
 *
 *   node scripts/screeps-query.mjs probe <file.js> [--shard shard3]
 *       Run the expression in <file.js> in-game, capturing its return value into
 *       Memory._probe, then poll until the result is fresh and print it. Use for
 *       live Game.* data that is NOT in Memory (bucket, store contents, market
 *       transactions). The expression must be a single JS expression that returns
 *       the (already-filtered) payload — see scripts/probes/*.js.
 *
 * Env: SCREEPS_TOKEN (required), SCREEPS_SHARD or --shard (default shard3),
 *      SCREEPS_API (default https://screeps.com) for private servers.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { gunzipSync } from 'zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// --- env loader (identical approach to deploy.mjs) -------------------------
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
  // no .env — rely on environment variables
}

const TOKEN = process.env.SCREEPS_TOKEN;
const API = (process.env.SCREEPS_API || 'https://screeps.com').replace(/\/$/, '');

if (!TOKEN || TOKEN === 'your-token-here') {
  console.error('Error: SCREEPS_TOKEN not set. Add it to .env (see .env.example).');
  process.exit(1);
}

// --- arg parsing -----------------------------------------------------------
const argv = process.argv.slice(2);
const verb = argv[0];
let shard = process.env.SCREEPS_SHARD || 'shard3';
const positional = [];
for (let i = 1; i < argv.length; i++) {
  if (argv[i] === '--shard') {
    shard = argv[++i];
  } else {
    positional.push(argv[i]);
  }
}

const headers = { 'X-Token': TOKEN, 'Content-Type': 'application/json' };

function fail(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Decode the Screeps memory-path response payload (raw value or gz:<base64>). */
function decodeMemoryData(data) {
  if (typeof data === 'string' && data.startsWith('gz:')) {
    const buf = Buffer.from(data.slice(3), 'base64');
    const text = gunzipSync(buf).toString('utf8');
    return text === '' ? null : JSON.parse(text);
  }
  // Small payloads come back as a raw JSON value already.
  return data;
}

async function apiGet(path) {
  const res = await fetch(`${API}${path}`, { headers });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    fail(`non-JSON response (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok || json.ok !== 1) {
    fail(`API ${path} failed (${res.status}): ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json;
}

async function gameTime() {
  const json = await apiGet(`/api/game/time?shard=${encodeURIComponent(shard)}`);
  return json.time;
}

async function readMemoryPath(path) {
  const q = `path=${encodeURIComponent(path || '')}&shard=${encodeURIComponent(shard)}`;
  const json = await apiGet(`/api/user/memory?${q}`);
  return decodeMemoryData(json.data);
}

async function runMem() {
  const path = positional[0] || '';
  const value = await readMemoryPath(path);
  if (value === undefined || value === null) {
    fail(`memory path "${path || '<root>'}" is empty/undefined on ${shard}`);
  }
  console.log(JSON.stringify(value, null, 2));
}

async function runProbe() {
  const file = positional[0];
  if (!file) fail('probe requires an expression file: probe <file.js>');
  let raw;
  try {
    raw = readFileSync(resolve(process.cwd(), file), 'utf8');
  } catch {
    try {
      raw = readFileSync(resolve(root, file), 'utf8');
    } catch {
      fail(`cannot read probe file: ${file}`);
    }
  }
  // The Screeps console caps expression size, so strip the authored whitespace:
  // drop full-line `//` comments, trim each line, join with a single space.
  // We deliberately do NOT collapse intra-line spacing — that would corrupt
  // string literals like ' ' used in the output formatting. Keep probe files
  // free of inline (mid-code) comments for this reason.
  let expr = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//'))
    .join(' ')
    .trim();
  // Strip a trailing semicolon so the expression nests cleanly.
  expr = expr.replace(/;\s*$/, '');

  const baseline = await gameTime();
  // Capture the expression's value into a scratch key with a freshness stamp.
  const expression = `(Memory._probe={t:Game.time,d:(${expr})})&&'queued'`;
  const postRes = await fetch(`${API}/api/user/console`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ expression, shard }),
  });
  const postJson = await postRes.json().catch(() => ({}));
  if (!postRes.ok || postJson.ok !== 1) {
    fail(`console POST failed (${postRes.status}): ${JSON.stringify(postJson).slice(0, 300)}`);
  }

  // Poll the scratch key until its stamp passes our baseline (i.e. the queued
  // command actually ran). The console command queue has variable latency
  // (observed 12-60s), so allow generous headroom — this is why state that
  // lives in Memory should be read with `mem` instead, which has no such lag.
  for (let attempt = 0; attempt < 48; attempt++) {
    await sleep(2500);
    let scratch;
    try {
      scratch = await readMemoryPath('_probe');
    } catch {
      continue; // path not written yet
    }
    if (scratch && typeof scratch.t === 'number' && scratch.t > baseline) {
      console.log(JSON.stringify(scratch.d, null, 2));
      return;
    }
  }
  fail(
    'probe timed out (no fresh Memory._probe after ~50s). The expression may have ' +
      'thrown — check syntax, or inspect via the MCP server as a fallback.'
  );
}

switch (verb) {
  case 'mem':
    await runMem();
    break;
  case 'probe':
    await runProbe();
    break;
  default:
    fail(`unknown verb "${verb ?? ''}". Use: mem <path> | probe <file.js>`);
}
