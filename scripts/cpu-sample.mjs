#!/usr/bin/env node
/**
 * Repeated sampler for Memory.stats (the profiler EMAs).
 *
 * Each `avg` in Memory.stats is an EMA with alpha 0.1, so a single read reflects only
 * the last ~10-20 samples and is noisy by about +-1 CPU. Averaging many reads spread
 * over time gives a number you can compare before/after a change.
 *
 * Usage:
 *   node scripts/cpu-sample.mjs [--n 30] [--interval 10] [--keys a,b,c] [--label name]
 *
 *   --n         number of reads (default 30; ~15 min at the default interval)
 *   --interval  seconds between reads (default 30, ~10 ticks: the EMA memory, so reads are ~independent)
 *   --keys      comma list of stat keys (default main.loop,rooms,towers,spawner,construction)
 *   --label     optional tag printed in the header
 *
 * Reads are spaced by wall clock, not ticks, and reads that land on the same tick are
 * dropped (checked via the `samples` counter of main.loop), so the mean is over distinct
 * moments. Needs Memory.profiling = true in-game. Auth: SCREEPS_TOKEN from .env.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try {
  for (const line of readFileSync(resolve(root, '.env'), 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    if (!process.env[k]) process.env[k] = t.slice(eq + 1).trim();
  }
} catch {
  // rely on environment
}

const TOKEN = process.env.SCREEPS_TOKEN;
const API = (process.env.SCREEPS_API || 'https://screeps.com').replace(/\/$/, '');
if (!TOKEN || TOKEN === 'your-token-here') {
  console.error('Error: SCREEPS_TOKEN not set. Add it to .env.');
  process.exit(1);
}

const args = process.argv.slice(2);
function opt(name, dflt) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
}
const n = Number(opt('n', 30));
const interval = Number(opt('interval', 30));
const shard = opt('shard', process.env.SCREEPS_SHARD || 'shard3');
const label = opt('label', '');
const keys = opt('keys', 'main.loop,rooms,towers,spawner,construction').split(',');
if (!Number.isFinite(n) || n < 1 || !Number.isFinite(interval) || interval < 1) {
  console.error('Error: --n and --interval must be positive numbers.');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readStats() {
  const q = `path=stats&shard=${encodeURIComponent(shard)}`;
  const res = await fetch(`${API}/api/user/memory?${q}`, { headers: { 'X-Token': TOKEN } });
  const json = await res.json();
  if (!res.ok || json.ok !== 1) throw new Error(`API failed (${res.status})`);
  const d = json.data;
  if (typeof d === 'string' && d.startsWith('gz:')) {
    return JSON.parse(gunzipSync(Buffer.from(d.slice(3), 'base64')).toString('utf8'));
  }
  return d;
}

const series = Object.fromEntries(keys.map((k) => [k, []]));
let lastSamples = -1;
let kept = 0;
let skipped = 0;

for (let i = 0; i < n; i++) {
  try {
    const s = await readStats();
    const marker = s?.['main.loop']?.samples;
    if (marker === undefined) {
      console.error('main.loop missing - is Memory.profiling on?');
      process.exit(1);
    }
    if (marker === lastSamples) {
      skipped++;
    } else {
      lastSamples = marker;
      kept++;
      for (const k of keys) {
        const v = s[k]?.avg;
        if (typeof v === 'number') series[k].push(v);
      }
    }
  } catch (e) {
    console.error(`read ${i + 1} failed: ${e.message}`);
  }
  if (i < n - 1) await sleep(interval * 1000);
}

function stats(a) {
  if (a.length === 0) return null;
  const mean = a.reduce((x, y) => x + y, 0) / a.length;
  const sd = Math.sqrt(a.reduce((x, y) => x + (y - mean) ** 2, 0) / a.length);
  return { mean, sd, min: Math.min(...a), max: Math.max(...a), se: sd / Math.sqrt(a.length) };
}

console.log(
  `cpu-sample${label ? ` [${label}]` : ''}: ${kept} distinct reads (${skipped} duplicate)`,
);
console.log('key'.padEnd(28) + 'mean    +-se    sd      min     max');
for (const k of keys) {
  const r = stats(series[k]);
  if (!r) {
    console.log(k.padEnd(28) + '(no data)');
    continue;
  }
  const f = (x) => x.toFixed(2).padEnd(8);
  console.log(k.padEnd(28) + f(r.mean) + f(r.se) + f(r.sd) + f(r.min) + f(r.max));
}
