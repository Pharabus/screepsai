/**
 * Evaluate and select adjacent rooms for remote mining.
 * Called periodically to update Memory.rooms[homeRoom].remoteRooms.
 */

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

  // Reject rooms with no sources
  if ((rmem.scoutedSources ?? 0) === 0) return -1;

  // Score: more sources = better
  return rmem.scoutedSources ?? 0;
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
  // Cap at 1 remote while energy economy is still consolidating.
  // Raise to 2 once storage comfortably exceeds 100k — a second remote adds
  // ~5 e/t of spawn cost plus bootstrap drain, which can stall storage growth
  // below that threshold even though steady-state net is positive.
  mem.remoteRooms = scored.slice(0, 1).map((r) => r.name);
}
