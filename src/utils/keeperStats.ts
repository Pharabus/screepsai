import { getStructuresByType } from './tickCache';
import { logCombat } from './combatLog';

/**
 * Source Keeper engagement tracker.
 *
 * The combat log only sees hostiles in rooms we own, so keeper fights never reach
 * it. This keeps per-SK-room counters in `Memory.keeperStats` so the question
 * "how are we doing against the keepers?" has an answer before SK engagement is
 * re-enabled (see `keeperEngagementReady` in remotePlanner.ts).
 *
 * Signals:
 *  - kills: a keeper lair's `ticksToSpawn` appears while we have vision, meaning the
 *    keeper that guarded it just died. Only keeperKillers fight keepers, so a kill is
 *    attributed to them.
 *  - killer ends: classified when the dead creep's memory is purged. A killer that
 *    dies before its natural lifetime without having started RETREAT was lost in
 *    combat; one in RETREAT was recycled; one that outlived CREEP_LIFE_TIME expired.
 *  - patrol ticks: ticks a killer spent in PATROL in the room, the denominator for
 *    kills per 1000 patrol ticks.
 *
 * Kills are deliberately not written to `Memory.combatLog` (four lairs respawn every
 * 300 ticks, so they would evict the raid history from its 100-entry ring); a lost
 * killer is rare and significant, so that one is.
 */

/** A lair respawn timer this high means the keeper died within the last few ticks. */
const FRESH_KILL_TICKS = 290;

/** Heap-only: last seen `ticksToSpawn` per lair id (undefined = keeper alive). */
const lastLairTimer = new Map<string, number | undefined>();

export type KeeperKillerEnd = 'lost' | 'retired' | 'expired';

/** Spawn tick is the numeric suffix of the creep name (`<role>_<room>_<tick>`). */
export function spawnTickFromName(name: string): number | undefined {
  const m = /_(\d+)$/.exec(name);
  return m ? Number(m[1]) : undefined;
}

/**
 * Pure classification of how a keeperKiller's life ended.
 * `age` is death tick minus the spawn tick parsed from the name; it includes the
 * 3 ticks/part spawn time, so a creep that lived its full TTL has age >= CREEP_LIFE_TIME.
 */
export function classifyKeeperKillerEnd(
  state: string | undefined,
  age: number | undefined,
): KeeperKillerEnd {
  if (state === 'RETREAT') return 'retired';
  if (age !== undefined && age >= CREEP_LIFE_TIME) return 'expired';
  return 'lost';
}

function statFor(room: string): KeeperRoomStat {
  const all = (Memory.keeperStats ??= {});
  return (all[room] ??= {
    kills: 0,
    lost: 0,
    retired: 0,
    expired: 0,
    patrolTicks: 0,
    lostAgeSum: 0,
  });
}

/** Called from the dead-creep memory purge, before the memory is deleted. */
export function recordKeeperKillerEnd(name: string, mem: CreepMemory): void {
  if (mem.role !== 'keeperKiller' || !mem.targetRoom) return;
  const spawned = spawnTickFromName(name);
  const age = spawned !== undefined ? Game.time - spawned : undefined;
  const end = classifyKeeperKillerEnd(mem.state, age);
  const stat = statFor(mem.targetRoom);
  stat[end]++;
  if (end !== 'lost') return;
  stat.lastLostTick = Game.time;
  if (age !== undefined) stat.lostAgeSum += age;
  logCombat({
    tick: Game.time,
    room: mem.targetRoom,
    event: 'keeper_killer_lost',
    details: `${name} died after ${age ?? '?'} ticks (state ${mem.state ?? '?'})`,
  });
}

/** Called from keeperKiller PATROL each tick. */
export function recordKillerPatrolTick(room: string): void {
  statFor(room).patrolTicks++;
}

/**
 * Detects keeper deaths in every visible SK room by watching lair respawn timers.
 * Cheap: one cached structure lookup per visible keeper room.
 */
export function observeKeeperLairs(): void {
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (!room || !Memory.rooms[roomName]?.scoutedHasKeepers) continue;
    const lairs = (getStructuresByType(room)[STRUCTURE_KEEPER_LAIR] ?? []) as StructureKeeperLair[];
    for (const lair of lairs) {
      const now = lair.ticksToSpawn;
      const had = lastLairTimer.has(lair.id) ? lastLairTimer.get(lair.id) : undefined;
      const seen = lastLairTimer.has(lair.id);
      lastLairTimer.set(lair.id, now);
      if (now === undefined) continue;
      // Keeper alive last tick, dead now - or first sight of a very fresh timer.
      const fresh = seen ? had === undefined : now >= FRESH_KILL_TICKS;
      if (!fresh) continue;
      const stat = statFor(roomName);
      stat.kills++;
      stat.lastKillTick = Game.time;
    }
  }
}

export function formatKeeperStats(): string {
  const stats = Memory.keeperStats;
  if (!stats || Object.keys(stats).length === 0) return 'no keeper activity recorded';
  const lines: string[] = [];
  for (const room of Object.keys(stats).sort()) {
    const s = stats[room];
    if (!s) continue;
    const per1k = s.patrolTicks > 0 ? ((s.kills * 1000) / s.patrolTicks).toFixed(1) : '-';
    const avgLost = s.lost > 0 ? Math.round(s.lostAgeSum / s.lost) : '-';
    const flag = s.lost > s.retired + s.expired ? ' ⚠ LOSING KILLERS' : '';
    const last =
      (s.lastKillTick !== undefined ? ` (lastKill @${s.lastKillTick})` : '') +
      (s.lastLostTick !== undefined ? ` (lastLost @${s.lastLostTick})` : '');
    lines.push(
      `${room}: kills=${s.kills} patrolTicks=${s.patrolTicks} kills/1k=${per1k} ` +
        `killers lost=${s.lost} (avg age ${avgLost}) retired=${s.retired} expired=${s.expired}` +
        `${last}${flag}`,
    );
  }
  return lines.join('\n');
}
