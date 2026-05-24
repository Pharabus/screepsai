/**
 * Evaluate and select adjacent rooms for remote mining.
 * Called periodically to update Memory.rooms[homeRoom].remoteRooms.
 */

import { hostilesSeen, getNeighbor } from './neighbors';
import { getMyUsername } from './identity';

// Auto-scale cap: hold at 1 remote room until home storage clears this bar so
// a second remote's spawn/bootstrap cost doesn't stall storage growth.
export const REMOTE_ROOM_SCALE_THRESHOLD = 100_000;

export function evaluateRemoteRoom(targetRoomName: string, allowKeeperRooms = false): number {
  const rmem = Memory.rooms[targetRoomName];
  if (!rmem?.scoutedAt) return -1;

  // Reject owned rooms or rooms reserved by other players
  if (rmem.scoutedOwner) return -1;
  const myUsername = getMyUsername();
  if (rmem.scoutedReservation && rmem.scoutedReservation !== myUsername) return -1;

  // Reject rooms with recent hostile presence (stale sightings are likely transient invaders)
  const hostiles = rmem.scoutedHostiles ?? 0;
  const scoutAge = Game.time - (rmem.scoutedAt ?? 0);
  if (hostiles > 0 && scoutAge < 1500) return -1;

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

export function selectRemoteRooms(homeRoom: Room): void {
  // Remote mining only pays off once there's storage to accumulate the energy.
  // Before that the room's 550-cap spawn/extensions fill quickly and the remote
  // spawn costs outweigh the gain.
  if (!homeRoom.storage) return;

  const exits = Game.map.describeExits(homeRoom.name);
  if (!exits) return;

  const allowKeeperRooms = homeRoom.energyCapacityAvailable >= 5300;
  const scored: { name: string; score: number }[] = [];
  for (const roomName of Object.values(exits)) {
    const score = evaluateRemoteRoom(roomName, allowKeeperRooms);
    if (score > 0) {
      scored.push({ name: roomName, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  const mem = (Memory.rooms[homeRoom.name] ??= {});
  // Auto-scale with hysteresis: scale up at 100k, scale down only below 70k.
  // Prevents churn when storage oscillates near the threshold — a room that
  // was selected stays selected until storage is well below the scale-up bar.
  const stored = homeRoom.storage?.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0;
  const currentCount = mem.remoteRooms?.length ?? 0;
  const SCALE_DOWN_THRESHOLD = Math.round(REMOTE_ROOM_SCALE_THRESHOLD * 0.7);
  const cap =
    stored >= REMOTE_ROOM_SCALE_THRESHOLD || (currentCount >= 2 && stored >= SCALE_DOWN_THRESHOLD)
      ? 2
      : 1;
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

  // Cache round-trip distance for each selected remote room.
  // roundTripTicks = pathLength × 2 (round trip) × 2 (conservative: no roads yet)
  // Recomputed on first selection or when >5000 ticks stale.
  if (!mem.remoteDistance) mem.remoteDistance = {};
  if (!mem.remoteDistanceUpdated) mem.remoteDistanceUpdated = {};
  // Evict entries for rooms that are no longer selected
  for (const key of Object.keys(mem.remoteDistance)) {
    if (!mem.remoteRooms.includes(key)) {
      delete mem.remoteDistance[key];
      delete mem.remoteDistanceUpdated[key];
    }
  }
  const homeSpawn = homeRoom.find(FIND_MY_SPAWNS)[0] as StructureSpawn | undefined;
  if (homeSpawn) {
    for (const { name } of selected) {
      const updatedAt = mem.remoteDistanceUpdated[name];
      const isStale = updatedAt === undefined || Game.time - updatedAt > 5000;
      if (!isStale) continue;
      const remoteMem = Memory.rooms[name];
      const sources = remoteMem?.scoutedSourceData;
      let targetPos: RoomPosition;
      if (sources && sources.length > 0) {
        const avgX = Math.floor(sources.reduce((s, p) => s + p.x, 0) / sources.length);
        const avgY = Math.floor(sources.reduce((s, p) => s + p.y, 0) / sources.length);
        targetPos = new RoomPosition(avgX, avgY, name);
      } else {
        targetPos = new RoomPosition(25, 25, name);
      }
      const result = PathFinder.search(
        homeSpawn.pos,
        { pos: targetPos, range: 1 },
        { maxRooms: 3, maxOps: 2000 },
      );
      mem.remoteDistance[name] = result.path.length * 4;
      mem.remoteDistanceUpdated[name] = Game.time;
    }
  }
}
