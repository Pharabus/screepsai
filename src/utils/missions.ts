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
 * Sentinel targetAmount meaning "drain the source fully" for a TransportMission.
 * NOT Infinity — JSON.stringify(Infinity) === 'null', which would corrupt the
 * value on the next Memory parse. With this cap the delivered>=target completion
 * never fires; the mission ends via the source-exhausted path instead.
 */
export const TRANSPORT_DRAIN_ALL = Number.MAX_SAFE_INTEGER;

/**
 * Return the live MissionRegistry, initialising Memory.missions if absent.
 * All public helpers call this instead of touching Memory.missions directly,
 * so the registry is always properly shaped.
 */
export function getMissionRegistry(): MissionRegistry {
  if (!Memory.missions)
    Memory.missions = { remoteMining: {}, colony: {}, defense: {}, transport: {} };
  // Backfill sub-maps for registries created before a type was added (e.g. live
  // memory from an earlier step that lacks colony/defense/transport).
  if (!Memory.missions.remoteMining) Memory.missions.remoteMining = {};
  if (!Memory.missions.colony) Memory.missions.colony = {};
  if (!Memory.missions.defense) Memory.missions.defense = {};
  if (!Memory.missions.transport) Memory.missions.transport = {};
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
  Memory.missions = { remoteMining: {}, colony: {}, defense: {}, transport: {} };
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
 * Defense missions ARE reclaimed by this predicate: a cleared engagement is set
 * 'retiring' and has no haulerIds/reserverId, so it deletes once it ages past 300.
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

      // Type-agnostic liveness checks: don't reclaim a mission that still owns
      // live creeps. remoteMining tracks haulerIds/reserverId; transport tracks
      // courierIds. A future type with its own creep list adds a check here.
      //
      // Count LIVE creeps, not the stored array length — a mission's id arrays
      // are only refreshed while its sync runs, and a retiring transport mission
      // is skipped by the spawner's sync (it continues past retiring missions),
      // so its courierIds keep pointing at dead couriers forever. Trusting the
      // raw length then blocks GC permanently (observed: W42N59→W43N58 transport
      // stuck 'retiring' with 3 dead courierIds after the hoard drained). Live
      // counting makes GC self-sufficient regardless of sync cadence.
      const rm = mission as Partial<RemoteMiningMission> & Partial<TransportMission>;
      const liveCount = (ids?: string[]) =>
        Array.isArray(ids) ? ids.filter((n) => Game.creeps[n] != null).length : 0;
      const hasHaulers = liveCount(rm.haulerIds) > 0;
      const hasReserver = rm.reserverId != null && Game.creeps[rm.reserverId] != null;
      const hasCouriers = liveCount(rm.courierIds) > 0;
      if (hasHaulers || hasReserver || hasCouriers) continue;

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

// ---------------------------------------------------------------------------
// Transport helpers (manual cross-room energy delivery)
// ---------------------------------------------------------------------------

/** Build the stable mission id / courier missionId key for a source→dest route. */
export function getTransportMissionKey(sourceRoom: string, destRoom: string): string {
  return `transport:${sourceRoom}->${destRoom}`;
}

/**
 * Create (or refresh the target of) a transport mission for a source→dest route.
 * Idempotent: re-running with a new amount on an existing route resets its
 * targetAmount/deliveredAmount and re-activates it (so an operator can re-issue
 * a drained route without manual cleanup).
 *
 * `amount` is a CAP — the mission completes on delivered >= amount OR when the
 * source is exhausted. Pass Infinity (the deliverEnergy default) to drain fully.
 */
export function createTransportMission(
  sourceRoom: string,
  destRoom: string,
  amount: number,
  resource: ResourceConstant = RESOURCE_ENERGY,
  spawnRoom?: string,
): TransportMission {
  const missions = getMissionsOfType<TransportMission>('transport');
  const id = getTransportMissionKey(sourceRoom, destRoom);
  const existing = missions[id];
  if (existing) {
    existing.targetAmount = amount;
    existing.deliveredAmount = 0;
    existing.resource = resource;
    existing.status = 'active';
    existing.lastSynced = Game.time;
    existing.spawnRoom = spawnRoom;
    return existing;
  }
  missions[id] = {
    type: 'transport',
    id,
    sourceRoom,
    destRoom,
    resource,
    targetAmount: amount,
    deliveredAmount: 0,
    status: 'active',
    createdAt: Game.time,
    lastSynced: Game.time,
    courierIds: [],
    spawnRoom,
  };
  return missions[id];
}

/** Fetch a transport mission by its id, or undefined. */
export function getTransportMission(id: string): TransportMission | undefined {
  return Memory.missions?.transport?.[id];
}

/** All transport missions (active and retiring). */
export function getTransportMissions(): TransportMission[] {
  return Object.values(Memory.missions?.transport ?? {});
}

/** Number of live couriers serving a transport mission (after syncTransportMission). */
export function getActiveCourierCount(id: string): number {
  return Memory.missions?.transport?.[id]?.courierIds.length ?? 0;
}

/**
 * Refresh a transport mission: rebuild courierIds from live creeps, and retire it
 * when the goal is met. Completion (→ 'retiring') triggers on EITHER:
 *  - deliveredAmount >= targetAmount (operator's cap reached), OR
 *  - the source's withdrawable store is visible-and-empty AND no courier is still
 *    carrying the resource (source exhausted — delivers whatever was available,
 *    never hangs waiting for energy that isn't coming).
 *
 * The source-empty check requires vision of the source room (a courier in COLLECT
 * provides it); when the source is dark we hold (a courier will arrive and grant
 * vision), so we never retire prematurely on a transient lack of visibility.
 */
export function syncTransportMission(id: string): void {
  const mission = Memory.missions?.transport?.[id];
  if (!mission) return;

  mission.courierIds = Object.values(Game.creeps)
    .filter((c) => c.memory.missionId === id && c.memory.role === 'courier')
    .map((c) => c.name);
  mission.lastSynced = Game.time;

  if (mission.status === 'retiring') return;

  if (mission.deliveredAmount >= mission.targetAmount) {
    mission.status = 'retiring';
    return;
  }

  const source = Game.rooms[mission.sourceRoom];
  if (source) {
    const bank =
      (source.storage?.store.getUsedCapacity(mission.resource) ?? 0) +
      (source.terminal?.store.getUsedCapacity(mission.resource) ?? 0);
    const carrying = mission.courierIds.some((name) => {
      const c = Game.creeps[name];
      return c ? c.store.getUsedCapacity(mission.resource) > 0 : false;
    });
    if (bank === 0 && !carrying) {
      mission.status = 'retiring';
    }
  }
}
