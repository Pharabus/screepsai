/**
 * Bucket-aware run gate for managers.
 *
 * shouldRun() returns false when the CPU bucket is too low for the given
 * priority, or when the requested interval hasn't elapsed. Wrap optional
 * or periodic managers to shed load automatically before the bucket drains.
 *
 * Priority ladder (lower number = more important):
 *   THROTTLE_CRITICAL  — always runs; never gated by bucket
 *   THROTTLE_HIGH      — skipped when bucket < 2 000
 *   THROTTLE_NORMAL    — skipped when bucket < 5 000
 *   THROTTLE_LOW       — skipped when bucket < 8 000
 *
 * Typical usage:
 *   if (shouldRun({ priority: THROTTLE_LOW })) profile('visuals', runVisuals);
 *   if (shouldRun({ interval: 5, priority: THROTTLE_LOW })) profile('construction', runConstruction);
 */

export const THROTTLE_CRITICAL = 0;
export const THROTTLE_HIGH = 1;
export const THROTTLE_NORMAL = 2;
export const THROTTLE_LOW = 3;

// Bucket thresholds — skips everything at or below the given priority.
const BUCKET_HIGH_FLOOR = 2000; // below here: skip HIGH, NORMAL, LOW
const BUCKET_NORMAL_FLOOR = 5000; // below here: skip NORMAL, LOW
const BUCKET_LOW_FLOOR = 8000; // below here: skip LOW

export function shouldRun({
  interval = 1,
  priority = THROTTLE_NORMAL,
  phase = 0,
}: {
  interval?: number;
  priority?: number;
  phase?: number;
} = {}): boolean {
  // Interval gate — cheapest check, done first.
  if (interval > 1 && Game.time % interval !== phase) return false;

  // Bucket gate — higher priority numbers are shed first.
  const bucket = Game.cpu.bucket;
  if (priority >= THROTTLE_LOW && bucket < BUCKET_LOW_FLOOR) return false;
  if (priority >= THROTTLE_NORMAL && bucket < BUCKET_NORMAL_FLOOR) return false;
  if (priority >= THROTTLE_HIGH && bucket < BUCKET_HIGH_FLOOR) return false;

  return true;
}
