/**
 * Evaluate and select adjacent rooms for remote mining.
 * Called periodically to update Memory.rooms[homeRoom].remoteRooms.
 */

import { hostilesSeen } from './neighbors';

// Auto-scale cap: hold at 1 remote room until home storage clears this bar so
// a second remote's spawn/bootstrap cost doesn't stall storage growth.
export const REMOTE_ROOM_SCALE_THRESHOLD = 100_000;

export function evaluateRemoteRoom(targetRoomName: string): number {
  const rmem = Memory.rooms[targetRoomName];
  if (!rmem?.scoutedAt) return -1;

  // Reject owned rooms or rooms reserved by other players
  if (rmem.scoutedOwner) return -1;
  const myUsername = Object.values(Game.spawns)[0]?.owner.username;
  if (rmem.scoutedReservation && rmem.scoutedReservation !== myUsername) return -1;

  // Reject rooms with recent hostile presence (stale sightings are likely transient invaders)
  const hostiles = rmem.scoutedHostiles ?? 0;
  const scoutAge = Game.time - (rmem.scoutedAt ?? 0);
  if (hostiles > 0 && scoutAge < 1500) return -1;

  // Reject rooms where we've seen aggressive players recently
  const aggressiveInRoom = hostilesSeen(targetRoomName, 20_000).length > 0;
  if (aggressiveInRoom) return -1;

  // Reject rooms with no sources
  if ((rmem.scoutedSources ?? 0) === 0) return -1;

  // Score: more sources = better
  return rmem.scoutedSources ?? 0;
}

function classifyRemoteType(targetRoomName: string): 'remote' | 'reserved' {
  const rmem = Memory.rooms[targetRoomName];
  // Rooms with a controller are worth reserving (doubles source capacity)
  if (rmem?.scoutedHasController) return 'reserved';
  return 'remote';
}

export function selectRemoteRooms(homeRoom: Room): void {
  const exits = Game.map.describeExits(homeRoom.name);
  if (!exits) return;

  const scored: { name: string; score: number }[] = [];
  for (const roomName of Object.values(exits)) {
    const score = evaluateRemoteRoom(roomName);
    if (score > 0) {
      scored.push({ name: roomName, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  const mem = (Memory.rooms[homeRoom.name] ??= {});
  // Auto-scale: 1 remote while storage is below 100k (a second remote adds
  // ~5 e/t spawn cost plus bootstrap drain, which can stall storage growth
  // before surplus is established), 2 remotes once storage clears that bar.
  const stored = homeRoom.storage?.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0;
  const cap = stored >= REMOTE_ROOM_SCALE_THRESHOLD ? 2 : 1;
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
}
