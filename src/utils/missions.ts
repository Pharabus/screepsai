/**
 * Lightweight mission records for grouped goal tracking.
 *
 * A RemoteMiningMission represents the "remote mining W43N59" goal as a single
 * typed object owned by the spawner. It tracks which haulers and reserver serve
 * this remote, the lifecycle status (active / stalled / retiring), and is the
 * foundation hook for a future manager-layer migration.
 *
 * Key design decisions:
 * - miner is NOT tracked here — RoomMemory.sources[n].minerName remains canonical
 * - haulerIds and reserverId are DERIVED caches refreshed by syncMission() each tick
 * - the authoritative assignment record is memory.missionId on the creep itself
 * - Mission records coexist with the existing spawner logic; remoteHaulers without
 *   a missionId (old creeps from before this change) are not tracked here
 *
 * missionId format on CreepMemory: 'remoteMining:<remoteRoomName>'
 */

/** Ticks since last hostile sighting before a remote is considered stalled */
export const STALL_HOSTILE_TICKS = 500;

/** Build the missionId key string for a remote room's haulers/reserver */
export function getRemoteMissionKey(remoteRoom: string): string {
  return `remoteMining:${remoteRoom}`;
}

/**
 * Upsert a RemoteMiningMission for the given remote room.
 * Creates a fresh record with status 'active' on first call; returns the
 * existing one on subsequent calls (idempotent).
 */
export function ensureRemoteMiningMission(
  homeRoom: string,
  remoteRoom: string,
): RemoteMiningMission {
  if (!Memory.missions) Memory.missions = { remoteMining: {} };
  const missions = Memory.missions.remoteMining;
  if (!missions[remoteRoom]) {
    missions[remoteRoom] = {
      homeRoom,
      remoteRoom,
      status: 'active',
      createdAt: Game.time,
      lastSynced: Game.time,
      haulerIds: [],
      reserverId: null,
    };
  }
  return missions[remoteRoom];
}

/** Fetch the mission record for a remote room, or undefined if it doesn't exist. */
export function getRemoteMiningMission(remoteRoom: string): RemoteMiningMission | undefined {
  return Memory.missions?.remoteMining?.[remoteRoom];
}

/**
 * Refresh the mission record by scanning live Game.creeps.
 *
 * Updates haulerIds from all creeps whose memory.missionId matches this remote.
 * Updates reserverId by:
 *  1. Clearing it if the tracked creep is dead.
 *  2. Scanning for an alive reserver with matching targetRoom (handles pre-migration
 *     creeps that don't have missionId set, and creeps spawned before this tick).
 *
 * Must be called before getActiveMissionHaulerCount() to get fresh data.
 * Called once per remote room per tick (in buildSpawnQueue), so the O(n) scan
 * over Game.creeps is bounded by remote room count × total creeps.
 */
export function syncMission(remoteRoom: string): void {
  const mission = Memory.missions?.remoteMining?.[remoteRoom];
  if (!mission) return;

  const key = getRemoteMissionKey(remoteRoom);

  // Rebuild haulerIds from live creeps bearing this mission's key
  mission.haulerIds = Object.values(Game.creeps)
    .filter((c) => c.memory.missionId === key && c.memory.role === 'remoteHauler')
    .map((c) => c.name);

  // Validate reserverId; scan for a live reserver if none is tracked
  if (mission.reserverId && !Game.creeps[mission.reserverId]) {
    mission.reserverId = null;
  }
  if (!mission.reserverId) {
    const reserver = Object.values(Game.creeps).find(
      (c) => c.memory.role === 'reserver' && c.memory.targetRoom === remoteRoom,
    );
    mission.reserverId = reserver?.name ?? null;
  }

  mission.lastSynced = Game.time;
}

/** Set mission status (active / stalled / retiring). */
export function setMissionStatus(remoteRoom: string, status: RemoteMiningMission['status']): void {
  const mission = Memory.missions?.remoteMining?.[remoteRoom];
  if (mission) mission.status = status;
}

/**
 * Mark a mission as retiring. Called when the remote room is removed from
 * remoteRooms. The mission remains in Memory until garbageCollectMissions()
 * confirms all creeps have expired.
 */
export function retireMission(remoteRoom: string): void {
  setMissionStatus(remoteRoom, 'retiring');
}

/**
 * Number of currently-tracked active remote haulers for this mission.
 * Accurate only after syncMission() has run this tick.
 */
export function getActiveMissionHaulerCount(remoteRoom: string): number {
  return Memory.missions?.remoteMining?.[remoteRoom]?.haulerIds.length ?? 0;
}

/** Current lifecycle status of a remote mining mission. */
export function getMissionStatus(remoteRoom: string): RemoteMiningMission['status'] | undefined {
  return Memory.missions?.remoteMining?.[remoteRoom]?.status;
}

/**
 * Delete 'retiring' missions that have no live haulers, no live reserver, and
 * are at least 300 ticks old (long enough for any in-flight spawns to land).
 * Call once per 100 ticks from runSpawner().
 */
export function garbageCollectMissions(): void {
  const missions = Memory.missions?.remoteMining;
  if (!missions) return;
  for (const [remoteRoom, mission] of Object.entries(missions)) {
    if (
      mission.status === 'retiring' &&
      mission.haulerIds.length === 0 &&
      !mission.reserverId &&
      Game.time - mission.createdAt > 300
    ) {
      delete missions[remoteRoom];
    }
  }
}

/**
 * Retire missions for remotes that are no longer in the given list.
 * Called immediately after selectRemoteRooms() updates Memory.rooms[room].remoteRooms.
 */
export function syncAllMissions(currentRemoteRooms: string[]): void {
  const missions = Memory.missions?.remoteMining;
  if (!missions) return;
  const remoteSet = new Set(currentRemoteRooms);
  for (const remoteRoom of Object.keys(missions)) {
    const m = missions[remoteRoom];
    if (m && !remoteSet.has(remoteRoom) && m.status !== 'retiring') {
      retireMission(remoteRoom);
    }
  }
}
