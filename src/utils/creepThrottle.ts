/**
 * Per-creep CPU throttle — graceful bucket-pressure shedding (Hivemind pattern).
 *
 * shard3 hard-caps every player at 20 CPU regardless of subscription or GCL
 * (https://blog.screeps.com/2018/10/shard3/) — it is the deliberately level
 * "non-subscription" shard. There is no money/GCL lever for more CPU; the only
 * path to more rooms is per-creep efficiency. Live (2026-06-13): 53 creeps / 4
 * rooms, bucket idles ~5300-6500 and drains ~0.38/tick on average. Left
 * unchecked, the bucket eventually hits 0, where the engine hard-throttles us
 * unpredictably (mid-loop cutoff -> corrupt half-ticks).
 *
 * shouldThrottleCreep(creep) probabilistically skips the per-tick role logic of
 * discretionary creeps once the bucket drops into a danger band, spread evenly
 * across creeps and ticks so the bucket self-stabilizes above 0 instead of
 * draining to a hard cutoff.
 *
 * IMPORTANT: this is a stability / floor-protector mechanism, not added
 * capacity. It trades a little upgrade/repair throughput for a bucket that
 * never bottoms out. Real capacity gains (links-over-haulers, leaner remotes)
 * are tracked separately in todo.md.
 *
 * Dark-deploy flag: Memory.creepThrottle (default off/undefined). Flag-off
 * returns false unconditionally, so behaviour is byte-for-byte unchanged until
 * enabled from the console — matches the Memory.holisticEconomy convention.
 *
 * Threshold tuning is the load-bearing decision, and it must track the
 * colony's ACTUAL operating bucket, not a stale assumption. Originally tuned
 * assuming a ~5500 idle bucket (throttleAt 4000/2500, both below it, so
 * nothing throttled at "normal"). That assumption broke down 2026-07-14: a
 * CPU-margin investigation (fleet growth to 50+ creeps, main.loop avg
 * ~18-19/20) left the colony's real operating bucket sitting at ~3000-5100
 * even after fixing an actual bug (an uncached room-wide flood-fill in
 * runConstruction) — live-observed main.loop consistently AT or ABOVE the
 * 20-CPU limit. At the old thresholds TIER_LIGHT (hauler/remoteHauler/
 * courier/reserver/mineralMiner/harvester — the largest role population)
 * never engaged in that range at all, so the single biggest lever provided
 * zero relief exactly when it was needed. Raised both tiers' throttleAt to
 * actually cover the current range (see below) — this is a deliberate
 * recalibration to the new normal, not a one-off patch; revisit again if the
 * operating baseline shifts (fleet trimmed back down, more CPU-per-creep
 * savings land, etc.) rather than assuming these values are permanent. The
 * historical warning about not raising toward the *construction* manager's
 * gate no longer applies at the same value — that gate moved from 8000
 * (THROTTLE_LOW) to 5000 (THROTTLE_NORMAL) in the same investigation — but
 * the underlying principle holds: don't raise these into the range where the
 * colony is genuinely CPU-healthy, only into the range that's actually
 * distressed.
 */

import { isInRoomInterior } from './movement';

interface ThrottleTier {
  /** Bucket at/above which this tier never throttles. */
  throttleAt: number;
  /** Bucket at/below which this tier always throttles. */
  stopAt: number;
}

/**
 * Income-adjacent logistics. Only throttled once the bucket is genuinely low —
 * skipping these directly reduces income/delivery throughput. throttleAt
 * raised 2500 -> 4500 (2026-07-14) to actually reach the colony's current
 * ~3000-5100 operating range — see module header.
 */
const TIER_LIGHT: ThrottleTier = { throttleAt: 4500, stopAt: 500 };

/**
 * Discretionary work — shed first. Skipping an upgrade/repair/build tick for
 * one creep on one tick is the least harmful place to claw back CPU.
 * throttleAt raised 4000 -> 6000 (2026-07-14), keeping it comfortably above
 * TIER_LIGHT's new threshold so heavy work still sheds first as bucket falls.
 */
const TIER_HEAVY: ThrottleTier = { throttleAt: 6000, stopAt: 1500 };

/**
 * Role -> throttle tier. `null` = NEVER throttled.
 *
 * NEVER (null):
 *  - defender, rangedDefender, healer, hunter, keeperKiller — combat must act
 *    every tick.
 *  - miner — stationary, ~1 cheap intent, and a skipped harvest is
 *    irreplaceable income (energy regen is time-gated, not bankable).
 *  - claimer, colonyBuilder — claim lifecycle is time-sensitive.
 *
 * This is a Record<CreepRoleName, ...> — the TypeScript compiler enforces that
 * every role in the CreepRoleName union (src/types.d.ts) is covered. A missing
 * role is a compile error.
 */
const ROLE_TIERS: Record<CreepRoleName, ThrottleTier | null> = {
  // NEVER
  defender: null,
  rangedDefender: null,
  healer: null,
  hunter: null,
  keeperKiller: null,
  miner: null,
  claimer: null,
  colonyBuilder: null,

  // TIER_LIGHT — income-adjacent logistics
  hauler: TIER_LIGHT,
  remoteHauler: TIER_LIGHT,
  courier: TIER_LIGHT,
  reserver: TIER_LIGHT,
  mineralMiner: TIER_LIGHT,
  harvester: TIER_LIGHT,
  depositMiner: TIER_LIGHT,

  // TIER_HEAVY — discretionary work, shed first
  upgrader: TIER_HEAVY,
  repairer: TIER_HEAVY,
  builder: TIER_HEAVY,
  remoteBuilder: TIER_HEAVY,
  scout: TIER_HEAVY,
  dismantler: TIER_HEAVY,
};

// ---------------------------------------------------------------------------
// Van der Corput even-spread sequence (faithful port of Hivemind's
// src/utils/throttle.ts generateEvenSequence + normalization).
//
// Built once at module load on the JS heap (not Memory) — a global reset
// simply rebuilds it from this fixed algorithm, no persisted state needed.
//
// generateEvenSequence(power, base) walks a base-N counter (here base=2,
// power=8 -> 256 entries) and emits the counter's value-as-a-number after each
// increment, starting from the "all digits maxed -> overflow" case (the
// largest value, pushed first as `max`). The resulting sequence visits every
// integer in [1, base^power] in an order that is maximally spread out — i.e.
// consecutive ticks land on very different positions in the [0,1] range below,
// rather than sweeping monotonically. That's what makes per-tick skip
// decisions decorrelate across creeps with adjacent offsets.
//
// Normalization mirrors Hivemind exactly:
//   SPREAD[i] = 1 - sequence[i] / sequence[0]   (sequence[0] === max)
//   SPREAD[0] = 1  (overridden — the heaviest-pressure slot always skips)
// ---------------------------------------------------------------------------

function generateEvenSequence(power: number, base: number): number[] {
  const numbers: number[] = [];
  const digits: number[] = [];
  for (let i = 0; i < power; i++) {
    digits[i] = 0;
  }

  function increase(digit: number): void {
    if (digit >= power) return;

    digits[digit] = (digits[digit] ?? 0) + 1;
    if ((digits[digit] ?? 0) >= base) {
      digits[digit] = 0;
      increase(digit + 1);
    }
  }

  function getNumber(): number {
    let sum = 0;
    for (let i = 0; i < power; i++) {
      sum *= base;
      sum += digits[i] ?? 0;
    }
    return sum;
  }

  increase(0);
  let number = getNumber();
  const max = number * base;
  numbers.push(max);
  while (number !== 0) {
    numbers.push(number);
    increase(0);
    number = getNumber();
  }

  return numbers;
}

/**
 * SPREAD[slot] is a value in (0,1]. In shouldThrottleCreep(), `ratio` (0..1,
 * higher = healthier bucket) is compared against SPREAD[slot]: a creep skips
 * when `ratio < SPREAD[slot]`. SPREAD[0] = 1 means slot 0 always skips
 * regardless of ratio (short of ratio >= 1, i.e. bucket >= throttleAt, which
 * is handled separately and never reaches this comparison).
 */
const SPREAD: number[] = (() => {
  const sequence = generateEvenSequence(8, 2); // 256 entries, sequence[0] = max
  const max = sequence[0] as number;
  const spread = sequence.map((n) => 1 - n / max);
  spread[0] = 1;
  return spread;
})();

// ---------------------------------------------------------------------------
// Per-creep offset — mirrors colonyPlanner.ts's heap-cache pattern. Lives on
// the JS heap, NOT in Memory: a global reset clears it and the first
// shouldThrottleCreep() call per creep post-reset reassigns an offset cheaply.
// Assigning offsets in first-seen order spreads each creep's throttle "phase"
// across SPREAD so the colony degrades smoothly rather than all creeps
// skipping in lockstep on the same tick.
// ---------------------------------------------------------------------------

const _creepOffsets = new Map<string, number>();
let _nextOffset = 0;

function creepOffset(name: string): number {
  let offset = _creepOffsets.get(name);
  if (offset === undefined) {
    offset = _nextOffset++;
    _creepOffsets.set(name, offset);
  }
  return offset;
}

/**
 * Returns true if `creep` should skip its per-tick role logic this tick.
 *
 * A throttled creep issues no intents and idles one tick — since moveTo() is
 * called per-tick with nothing engine-queued, it simply pauses. Minor
 * throughput loss is the intended trade for bucket stability.
 */
export function shouldThrottleCreep(creep: Creep): boolean {
  if (!Memory.creepThrottle) return false;

  const tier = ROLE_TIERS[creep.memory.role];
  if (!tier) return false;

  // Never skip a border creep — the engine can auto-evict a creep that ends
  // a tick on an exit tile without moving inward (see isInRoomInterior).
  if (!isInRoomInterior(creep)) return false;

  // Emergency brake: this tick is already blowing the per-tick CPU allowance
  // (only bites when the bucket is low and tickLimit has collapsed toward
  // ~20; at a healthy bucket tickLimit is ~500 and this never fires).
  if (Game.cpu.getUsed() > Game.cpu.tickLimit * 0.85) return true;

  const bucket = Game.cpu.bucket;
  if (bucket >= tier.throttleAt) return false; // healthy, run normally
  if (bucket <= tier.stopAt) return true; // starved, always skip

  // Probabilistic even-spread skip: ratio falls from 1 (at throttleAt) to 0
  // (at stopAt) as the bucket drains. Skip more often as ratio falls.
  const ratio = (bucket - tier.stopAt) / (tier.throttleAt - tier.stopAt);
  const slot = (Game.time + creepOffset(creep.name)) % SPREAD.length;
  return ratio < (SPREAD[slot] as number);
}
