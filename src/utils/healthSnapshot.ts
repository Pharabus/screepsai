import { formatBoostStats } from './boost';
import { myStorage, myTerminal } from './ownership';

/**
 * How often (ticks) writeHealthSnapshot() refreshes Memory._health. A health
 * check is read on demand and tolerates ~tens-of-seconds staleness, so this is
 * spaced out to keep the per-tick cost negligible under the shard3 20-CPU cap.
 */
export const HEALTH_SNAPSHOT_INTERVAL = 10;

/** Non-energy contents of a store as a terse { mineral: amount } map. */
function nonEnergy(store: StoreDefinition | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!store) return out;
  for (const key of Object.keys(store) as ResourceConstant[]) {
    if (key === RESOURCE_ENERGY) continue;
    const amount = store[key];
    if (amount > 0) out[key] = amount;
  }
  return out;
}

/**
 * Refresh Memory._health with a compact, fully-filtered snapshot of live bot
 * health (CPU/bucket, GCL/credits, recent market activity, per-room storage/
 * terminal/labs, boost stats). Mirrors the three HealthCheck console probes, but
 * computed in-game so the snapshot can be read with one cheap Memory-path GET
 * (scripts/screeps-query.mjs mem _health) instead of pulling a console buffer
 * through the MCP server. Read-only telemetry — nothing consumes it.
 *
 * Uses myStorage/myTerminal so a reclaimed room reports OUR structures, not the
 * previous owner's husk.
 */
export function writeHealthSnapshot(): void {
  const rooms: HealthRoomSnapshot[] = [];
  for (const room of Object.values(Game.rooms)) {
    if (!room.controller?.my) continue;
    const mem = Memory.rooms[room.name] ?? {};
    const storage = myStorage(room);
    const terminal = myTerminal(room);
    const labs = room
      .find(FIND_MY_STRUCTURES)
      .filter((s): s is StructureLab => s.structureType === STRUCTURE_LAB)
      .map((l) => `${l.mineralType ?? '-'}:${l.mineralType ? l.store[l.mineralType] : 0}`);

    rooms.push({
      n: room.name,
      rcl: room.controller.level,
      cp: +((100 * room.controller.progress) / (room.controller.progressTotal || 1)).toFixed(1),
      sm: room.controller.safeMode ?? 0,
      se: `${room.energyAvailable}/${room.energyCapacityAvailable}`,
      stE: storage ? storage.store[RESOURCE_ENERGY] : null,
      stM: nonEnergy(storage?.store),
      tE: terminal ? terminal.store[RESOURCE_ENERGY] : null,
      tM: nonEnergy(terminal?.store),
      lab: labs,
      bl: mem.boostLabId ? (mem.boostCompound ?? '?') : null,
      rx: mem.activeReaction ? mem.activeReaction.output : null,
    });
  }

  // Only report the main-loop EMA when profiling is ON. Memory.stats is frozen
  // (not cleared) when profiling is disabled, so a non-null avg would be STALE
  // and read as a live figure. Null lets the HealthCheck skill correctly render
  // it as "profiling off" instead of a bogus current value.
  const loopSample = Memory.profiling ? Memory.stats?.['main.loop'] : undefined;
  const out = Game.market.outgoingTransactions ?? [];
  const inc = Game.market.incomingTransactions ?? [];

  Memory._health = {
    t: Game.time,
    sys: {
      b: Game.cpu.bucket,
      lim: Game.cpu.limit,
      tl: Game.cpu.tickLimit,
      gcl: Game.gcl.level,
      gp: +((100 * Game.gcl.progress) / Game.gcl.progressTotal).toFixed(1),
      cr: Math.round(Game.market.credits),
      ord: Object.keys(Game.market.orders ?? {}).length,
      loop: loopSample ? +loopSample.avg.toFixed(2) : null,
      sells: out
        .filter((x) => x.order)
        .slice(0, 5)
        .map((x) => `${x.amount}${x.resourceType}@${x.order!.price.toFixed(2)}`),
      buys: inc
        .filter((x) => x.order)
        .slice(0, 5)
        .map((x) => `${x.amount}${x.resourceType}@${x.order!.price.toFixed(2)}`),
      tr: inc
        .filter((x) => !x.order)
        .slice(0, 5)
        .map((x) => `${x.amount}${x.resourceType} ${x.from}>${x.to}`),
    },
    rooms,
    boost: formatBoostStats(),
  };
}
