/**
 * Evaluate and select adjacent rooms for remote mining.
 * Called periodically to update Memory.rooms[homeRoom].remoteRooms.
 */

import { hostilesSeen, getNeighbor } from './neighbors';
import { getMyUsername } from './identity';
import { myStorage } from './ownership';

// Auto-scale cap: hold at 1 remote room until home storage clears this bar so
// a second remote's spawn/bootstrap cost doesn't stall storage growth.
export const REMOTE_ROOM_SCALE_THRESHOLD = 100_000;

/** Selection rejection window after a scouted NPC-only (invader/keeper) sighting — short, because hunters clear invaders fast. */
export const NPC_SCOUT_REJECT_TICKS = 300;
/** Selection rejection window after a scouted player sighting — long, players warrant caution. */
export const PLAYER_SCOUT_REJECT_TICKS = 1500;

/**
 * Source count dominates the remote score: one extra source outweighs distance
 * up to this many tiles. So a 2-source room always beats a 1-source room, but
 * among equal source counts the closer room wins (distance is subtracted raw).
 */
const SOURCE_SCORE_WEIGHT = 100;
/**
 * Hard reject a remote whose one-way path exceeds this. Beyond it the round-trip
 * haul cost swamps a single source's ~10 energy/tick even with roads.
 */
export const REMOTE_MAX_PATH_TILES = 120;
/** Recompute a cached remote path distance when older than this many ticks. */
const REMOTE_DISTANCE_STALE_TICKS = 5000;

export function evaluateRemoteRoom(targetRoomName: string, allowKeeperRooms = false): number {
  const rmem = Memory.rooms[targetRoomName];
  if (!rmem?.scoutedAt) return -1;

  // Reject owned rooms or rooms reserved by other players
  if (rmem.scoutedOwner) return -1;
  const myUsername = getMyUsername();
  if (rmem.scoutedReservation && rmem.scoutedReservation !== myUsername) return -1;

  // Reject rooms with recent hostile presence. NPC-only sightings get a short
  // window (hunters clear invaders fast); player sightings get a long one.
  const hostiles = rmem.scoutedHostiles ?? 0;
  if (hostiles > 0) {
    const scoutAge = Game.time - (rmem.scoutedAt ?? 0);
    // Missing flag (legacy memory) → treat as player (long window), matching remoteThreat's fail-safe.
    const isPlayer = rmem.scoutedHostileIsPlayer !== false;
    const window = isPlayer ? PLAYER_SCOUT_REJECT_TICKS : NPC_SCOUT_REJECT_TICKS;
    if (scoutAge < window) return -1;
  }

  // Reject rooms where aggressive players (not mere scouts) have been seen recently
  const aggressiveInRoom = hostilesSeen(targetRoomName, 20_000).some(
    (name) => getNeighbor(name)?.hostility === 'aggressive',
  );
  if (aggressiveInRoom) return -1;

  // Reject rooms with no sources
  if ((rmem.scoutedSources ?? 0) === 0) return -1;

  // Source Keeper rooms: only opt in when a killer is already alive there.
  // Score 3× to reflect 3× source capacity (3000 vs 1000 per regen cycle).
  if (rmem.scoutedHasKeepers) {
    if (!allowKeeperRooms) return -1;
    const hasKiller = Object.values(Game.creeps).some(
      (c) => c.memory.role === 'keeperKiller' && c.memory.targetRoom === targetRoomName,
    );
    if (!hasKiller) return -1;
    return (rmem.scoutedSources ?? 0) * 3;
  }

  // Score: more sources = better
  return rmem.scoutedSources ?? 0;
}

function classifyRemoteType(targetRoomName: string): 'remote' | 'reserved' | 'keeperRoom' {
  const rmem = Memory.rooms[targetRoomName];
  if (rmem?.scoutedHasKeepers) return 'keeperRoom';
  // Rooms with a controller are worth reserving (doubles source capacity)
  if (rmem?.scoutedHasController) return 'reserved';
  return 'remote';
}

/**
 * Storage-gated cap on how many remote rooms this colony should run.
 * Hysteresis: scale up to 2 at REMOTE_ROOM_SCALE_THRESHOLD (100k), but a colony
 * already running 2 keeps them until storage falls below 70% of that — prevents
 * churn when storage oscillates near the threshold. Below the bar: 1.
 *
 * Exported so the spawner can gate scouting on remote demand: a colony already
 * at its cap gains nothing from more remotes and must not burn spawn bandwidth
 * re-scouting territory it cannot exploit.
 */
export function remoteRoomCap(homeRoom: Room): number {
  // myStorage (not room.storage): a reclaimed room's foreign storage is
  // owner-agnostic and would otherwise inflate the cap on a colony that can't
  // yet exploit a second remote.
  const stored = myStorage(homeRoom)?.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0;
  const currentCount = Memory.rooms[homeRoom.name]?.remoteRooms?.length ?? 0;
  const scaleDown = Math.round(REMOTE_ROOM_SCALE_THRESHOLD * 0.7);
  return stored >= REMOTE_ROOM_SCALE_THRESHOLD || (currentCount >= 2 && stored >= scaleDown)
    ? 2
    : 1;
}

/**
 * Cached one-way path length (tiles) from the home spawn to a remote room's
 * source cluster. Stored as round-trip ticks (path × 4) in mem.remoteDistance
 * for reuse by the hauler-count scaler (remoteHaulersWanted); this returns the
 * one-way tile count. Recomputed when missing or stale. Returns undefined on an
 * incomplete/empty path so the caller can fall back to a source-only score
 * rather than caching a bogus distance.
 */
function ensureRemotePathLength(
  mem: RoomMemory,
  homeSpawn: StructureSpawn,
  roomName: string,
): number | undefined {
  const dist = (mem.remoteDistance ??= {});
  const updated = (mem.remoteDistanceUpdated ??= {});
  const lastUpdated = updated[roomName];
  const fresh = lastUpdated !== undefined && Game.time - lastUpdated <= REMOTE_DISTANCE_STALE_TICKS;
  const cached = dist[roomName];
  if (fresh && cached !== undefined) return cached / 4;

  const remoteMem = Memory.rooms[roomName];
  const sources = remoteMem?.scoutedSourceData;
  let targetPos: RoomPosition;
  if (sources && sources.length > 0) {
    const avgX = Math.floor(sources.reduce((s, p) => s + p.x, 0) / sources.length);
    const avgY = Math.floor(sources.reduce((s, p) => s + p.y, 0) / sources.length);
    targetPos = new RoomPosition(avgX, avgY, roomName);
  } else {
    targetPos = new RoomPosition(25, 25, roomName);
  }
  const result = PathFinder.search(
    homeSpawn.pos,
    { pos: targetPos, range: 1 },
    { maxRooms: 3, maxOps: 2000 },
  );
  if (result.incomplete || result.path.length === 0) return undefined;
  dist[roomName] = result.path.length * 4;
  updated[roomName] = Game.time;
  return result.path.length;
}

/**
 * True when a SIBLING owned colony already claims this remote room and is at
 * least as close to it as we are — so it keeps it (de-confliction; prevents two
 * colonies double-mining one room). Only colonies with their own storage count:
 * a colony without one will not actually run remotes (selectRemoteRooms gates on
 * myStorage). Incumbent-stable: an equal- or shorter-path claimant holds the
 * room, and an unknown distance yields to the incumbent (conservative).
 */
function claimedByCloserColony(
  homeName: string,
  remoteName: string,
  myOneWayPath: number,
): boolean {
  for (const otherName of Object.keys(Memory.rooms)) {
    if (otherName === homeName) continue;
    const other = Game.rooms[otherName];
    if (!other || !myStorage(other)) continue; // not a remote-capable colony
    const otherMem = Memory.rooms[otherName];
    if (!otherMem?.remoteRooms?.includes(remoteName)) continue; // doesn't claim it
    const otherRt = otherMem.remoteDistance?.[remoteName];
    if (otherRt === undefined) return true; // claims it, distance unknown → yield
    if (otherRt / 4 <= myOneWayPath) return true;
  }
  return false;
}

export function selectRemoteRooms(homeRoom: Room): void {
  const mem = (Memory.rooms[homeRoom.name] ??= {});

  // Remote mining only pays off once OUR OWN storage exists to accumulate the
  // energy. Guard on myStorage, not room.storage: in a reclaimed room the
  // latter is owner-agnostic and returns the previous owner's full storage,
  // which would otherwise make a freshly-claimed RCL2 colony spin up remotes it
  // cannot afford. Clear any stale selection so those remotes are freed for
  // sibling colonies (de-confliction).
  if (!myStorage(homeRoom)) {
    mem.remoteRooms = [];
    return;
  }

  const exits = Game.map.describeExits(homeRoom.name);
  if (!exits) return;
  // Initialise distance caches up front so they exist even on a no-spawn /
  // source-only pass (consumers and eviction below rely on their presence).
  mem.remoteDistance ??= {};
  mem.remoteDistanceUpdated ??= {};
  const homeSpawn = homeRoom.find(FIND_MY_SPAWNS)[0] as StructureSpawn | undefined;

  const allowKeeperRooms = homeRoom.energyCapacityAvailable >= 5300;
  const scored: { name: string; score: number }[] = [];
  for (const roomName of Object.values(exits)) {
    const sourceScore = evaluateRemoteRoom(roomName, allowKeeperRooms);
    if (sourceScore <= 0) continue;

    // Distance-aware: needs a spawn to path from. Falls back to a source-only
    // score when there's no spawn, the room is dark, or PathFinder fails — so
    // selection is never stalled on a transient/degenerate condition.
    const oneWayPath = homeSpawn ? ensureRemotePathLength(mem, homeSpawn, roomName) : undefined;
    if (oneWayPath === undefined) {
      scored.push({ name: roomName, score: sourceScore * SOURCE_SCORE_WEIGHT });
      continue;
    }
    if (oneWayPath > REMOTE_MAX_PATH_TILES) continue; // too far to be worth it
    if (claimedByCloserColony(homeRoom.name, roomName, oneWayPath)) continue; // sibling owns it

    // Source count dominates; distance breaks ties and penalises far rooms.
    scored.push({ name: roomName, score: sourceScore * SOURCE_SCORE_WEIGHT - oneWayPath });
  }

  scored.sort((a, b) => b.score - a.score);

  // Auto-scale with hysteresis (see remoteRoomCap).
  const cap = remoteRoomCap(homeRoom);
  const selected = scored.slice(0, cap);
  mem.remoteRooms = selected.map((r) => r.name);

  // Classify each selected remote room and set default defense policy
  for (const { name } of selected) {
    const rmem = (Memory.rooms[name] ??= {});
    rmem.remoteType = classifyRemoteType(name);
    if (!rmem.defensePolicy) {
      rmem.defensePolicy = rmem.remoteType === 'reserved' ? 'defend' : 'flee';
    }
  }

  // Evict distance-cache entries for rooms that are no longer candidate exits.
  const exitSet = new Set<string>(Object.values(exits));
  for (const key of Object.keys(mem.remoteDistance ?? {})) {
    if (!exitSet.has(key)) {
      delete mem.remoteDistance![key];
      delete mem.remoteDistanceUpdated![key];
    }
  }
}
