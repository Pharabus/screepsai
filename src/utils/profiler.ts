/**
 * Lightweight CPU profiler.
 *
 * Wrap any function with `profile(name, fn)` to record its CPU cost. Samples
 * are folded into exponential moving averages stored in `Memory.stats`, so
 * memory footprint is one slot per distinct `name` regardless of tick count.
 *
 * Profiling is gated by `Memory.profiling` so production ticks pay ~nothing
 * when it's disabled. Toggle at runtime from the console:
 *
 *   Memory.profiling = true
 *   stats()        // print current numbers
 *   resetStats()   // clear
 *   Memory.profiling = false
 */

const ALPHA = 0.1; // EMA weight for the latest sample

function recordSample(name: string, cpu: number): void {
  const stats = (Memory.stats ??= {});
  const slot = stats[name];
  if (!slot) {
    stats[name] = { avg: cpu, last: cpu, max: cpu, samples: 1 };
    return;
  }
  slot.avg = slot.avg * (1 - ALPHA) + cpu * ALPHA;
  slot.last = cpu;
  if (cpu > slot.max) slot.max = cpu;
  slot.samples += 1;
}

export function profile<T>(name: string, fn: () => T): T {
  if (!Memory.profiling) return fn();
  const start = Game.cpu.getUsed();
  try {
    return fn();
  } finally {
    recordSample(name, Game.cpu.getUsed() - start);
  }
}

/**
 * Render the current stats table as a single multi-line string, sorted by
 * average CPU (descending).
 */
export function formatStats(): string {
  const stats = Memory.stats ?? {};
  const entries = Object.entries(stats).sort((a, b) => b[1].avg - a[1].avg);
  if (entries.length === 0) return 'no profiling samples yet';

  const lines = ['name                          avg     last    max     n'];
  for (const [name, s] of entries) {
    lines.push(
      `${name.padEnd(30)}${s.avg.toFixed(2).padEnd(8)}${s.last.toFixed(2).padEnd(8)}${s.max
        .toFixed(2)
        .padEnd(8)}${s.samples}`,
    );
  }
  return lines.join('\n');
}

export function resetStatsNow(): void {
  Memory.stats = {};
}
