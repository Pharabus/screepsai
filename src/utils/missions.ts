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
 *
 * Generic layer
 * -------------
 * getMissionRegistry() / getMissionsOfType<T>() provide a typed, registry-aware
 * foundation so future mission types are uniform.  The public remote-mining API
 * (ensureRemoteMiningMission, syncMission, …) is built on top and its signatures
 * are unchanged — spawner.ts imports exactly those names and they continue to work.
 */

// ---------------------------------------------------------------------------
// Generic registry helpers
// ---------------------------------------------------------------------------

/** Ticks since last hostile sighting before a remote is considered stalled */
export const STALL_HOSTILE_TICKS = 500;

/**
 * Return the live MissionRegistry, initialising Memory.missions if absent.
 * All public helpers call this instead of touching Memory.missions directly,
 * so the registry is always properly shaped.
 */
export function getMissionRegistry(): MissionRegistry {
  if (!Memory.missions) Memory.missions = { remoteMining: {}, colony: {} };
  // Backfill sub-maps for registries created before a type was added (live memory
  // from Step 1 has only remoteMining).
  if (!Memory.missions.remoteMining) Memory.missions.remoteMining = {};
  if (!Memory.missions.colony) Memory.missions.colony = {};
  return Memory.missions;
}

/**
 * Typed accessor for a single mission sub-map.
 * Returns the Record<id, T> for the requested type.
 *
 * Usage:
 *   const rm = getMissionsOfType<RemoteMiningMission>('remoteMining');
 */
export function getMissionsOfType<T extends MissionBase>(
  type: keyof MissionRegistry,
): Record<string, T> {
  const registry = getMissionRegistry();
  return registry[type] as unknown as Record<string, T>;
}

/**
 * Reset helper for tests — wipes Memory.missions so each test starts clean.
 * Mirrors the pattern of other reset* exports in the codebase.
 */
export function resetMissions(): void {
  Memory.missions = { remoteMining: {}, colony: {} };
}

// ---------------------------------------------------------------------------
// Garbage collection (registry-aware)
// ---------------------------------------------------------------------------

/**
 * Delete 'retiring' missions across ALL registered mission types when they
 * satisfy the safe-to-remove predicate.
 *
 * Predicate for RemoteMiningMission:
 *   status === 'retiring'
 *   AND haulerIds.length === 0
 *   AND !reserverId
 *   AND Game.time - createdAt > 300
 *
 * For any future mission type that lacks haulerIds/reserverId the function
 * falls back to checking only status + age, which is the sensible default.
 *
 * Behavior is identical to the previous hard-coded implementation for the
 * remoteMining type — it iterates the same records with the same predicate.
 *
 * Colony missions are never deleted here: their status is only ever
 * claiming/bootstrapping/active (never 'retiring'), so the status guard skips them.
 *
 * Call once per 100 ticks from runSpawner().
 */
export function garbageCollectMissions(): void {
  const registry = Memory.missions;
  if (!registry) return;

  for (const typeKey of Object.keys(registry) as (keyof MissionRegistry)[]) {
    const subMap = registry[typeKey] as Record<string, MissionBase>;
    for (const [id, mission] of Object.entries(subMap)) {
      if (mission.status !== 'retiring') continue;
      if (Game.time - mission.createdAt <= 300) continue;

      // Remote-mining-specific liveness checks (fields present on the cast type)
      const rm = mission as Partial<RemoteMiningMission>;
      const hasHaulers = Array.isArray(rm.haulerIds) && rm.haulerIds.length > 0;
      const hasReserver = rm.reserverId != null;
      if (hasHaulers || hasReserver) continue;

      delete subMap[id];
    }
  }
}

// ---------------------------------------------------------------------------
// Remote-mining helpers (public API — signatures unchanged)
// ---------------------------------------------------------------------------

/** Build the missionId key string for a remote room's haulers/reserver */
export function getRemoteMissionKey(remoteRoom: string): string {
  return `remoteMining:${remoteRoom}`;
}

/**
 * Upsert a RemoteMiningMission for the given remote room.
 * Creates a fresh record with status 'active' on first call; returns the
 * existing one on subsequent calls (idempotent).
 *
 * New records are stamped with type:'remoteMining' and id == remoteRoom.
 * Pre-existing records that lack these fields are backfilled (migration).
 */
export function ensureRemoteMiningMission(
  homeRoom: string,
  remoteRoom: string,
): RemoteMiningMission {
  const missions = getMissionsOfType<RemoteMiningMission>('remoteMining');
  if (!missions[remoteRoom]) {
    missions[remoteRoom] = {
      type: 'remoteMining',
      id: remoteRoom,
      homeRoom,
      remoteRoom,
      status: 'active',
      createdAt: Game.time,
      lastSynced: Game.time,
      haulerIds: [],
      reserverId: null,
    };
  } else {
    // Backfill migration: stamp type/id onto pre-existing records that were
    // created before this field was introduced.
    const existing = missions[remoteRoom];
    if (!existing.type) existing.type = 'remoteMining';
    if (!existing.id) existing.id = remoteRoom;
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
 * Also backfills type/id on a pre-existing record that lacks them (same migration
 * path as ensureRemoteMiningMission — covers records loaded from Memory before
 * the first ensureRemoteMiningMission call this global reset).
 *
 * Must be called before getActiveMissionHaulerCount() to get fresh data.
 * Called once per remote room per tick (in buildSpawnQueue), so the O(n) scan
 * over Game.creeps is bounded by remote room count × total creeps.
 */
export function syncMission(remoteRoom: string): void {
  const mission = Memory.missions?.remoteMining?.[remoteRoom];
  if (!mission) return;

  // Backfill migration for records that pre-date the type/id fields.
  if (!mission.type) mission.type = 'remoteMining';
  if (!mission.id) mission.id = remoteRoom;

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
 * Reconcile mission lifecycle against one home room's current remote-room selection.
 * Called once per home room immediately after selectRemoteRooms() updates
 * Memory.rooms[room].remoteRooms.
 *
 * Scoped to homeRoom: only missions whose `homeRoom` matches the argument are
 * considered. This is REQUIRED because the function is invoked per-home with that
 * home's remoteRooms list — without the scope check, processing one home would
 * retire another colony's missions (their remotes aren't in this home's list),
 * causing multi-colony cross-stomp where the last home processed wins.
 *
 * Membership in currentRemoteRooms is the source of truth for the
 * retiring<->active distinction (two-way), among this home's missions:
 *  - Room IS selected and the mission is 'retiring' → recover it to 'active'.
 *    This un-latches a mission whose room was transiently dropped (e.g. an NPC
 *    invader sighting causing a temporary rejection) and later re-selected.
 *  - Room is NOT selected and the mission is not already 'retiring' → retire it.
 *
 * 'stalled' is intentionally left untouched: the spawner owns the active<->stalled
 * toggle via its hostile/isStalled detection, so we never stomp a stall here.
 */
export function syncAllMissions(homeRoom: string, currentRemoteRooms: string[]): void {
  const missions = Memory.missions?.remoteMining;
  if (!missions) return;
  const remoteSet = new Set(currentRemoteRooms);
  for (const remoteRoom of Object.keys(missions)) {
    const m = missions[remoteRoom];
    if (!m || m.homeRoom !== homeRoom) continue; // only reconcile this home's missions
    if (remoteSet.has(remoteRoom)) {
      // Re-selected after a transient drop-out (e.g. scouted-hostile rejection):
      // recover the mission. Leave 'stalled' to the spawner's active<->stalled toggle.
      if (m.status === 'retiring') setMissionStatus(remoteRoom, 'active');
    } else if (m.status !== 'retiring') {
      retireMission(remoteRoom);
    }
  }
}
