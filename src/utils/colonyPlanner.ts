/**
 * Colony planner — manages multi-room expansion via the claimer role.
 *
 * A "colony" is a target room we intend to claim. Lifecycle (see ColonyMission):
 *   claiming → bootstrapping → active
 *
 * Colony records live in the generic mission registry (Memory.missions.colony),
 * keyed by target room name.
 *
 * The home room (parent colony) is responsible for spawning the claimer that
 * takes the target room's controller, then sending colonyBuilders to build the
 * first spawn. Once the spawn exists, the new room runs the standard spawn
 * pipeline and the colony status flips to 'active'.
 *
 * Target selection is currently manual via the `claim(roomName)` console command.
 * Auto-selection can layer on top of scoreClaimTarget(). The 'selected' status
 * intentionally has no automatic transition — operators commit explicitly.
 *
 * Colony priority scoring: each owned room receives an investment priority score
 * (higher = more worth dedicating upgrader spawn time to right now). See
 * getColonyScore() for the formula. Scores are heap-cached every
 * SCORE_CACHE_INTERVAL ticks — not stored in Memory.
 */

import { hostilesSeen, getNeighbor } from './neighbors';
import { getMyUsername } from './identity';
import { getMissionsOfType } from './missions';
import { myStorage } from './ownership';

// ---------------------------------------------------------------------------
// Colony priority scoring
// ---------------------------------------------------------------------------

/** Ticks between score recomputation. A 500-tick window matches the labs
 *  reaction re-evaluation cadence and keeps the cache warm across most ticks. */
const SCORE_CACHE_INTERVAL = 500;

/**
 * Module-scope heap cache: { score, computedAt } keyed by room name.
 * Lives on the JavaScript heap, NOT in Memory — a global reset clears it and
 * the first call post-reset recomputes cheaply from live state.
 */
const _colonyScoreCache = new Map<string, { score: number; computedAt: number }>();

/**
 * Energy/tick produced by a single fully-saturated source.
 * Proxy: 3000 energy per 300-tick regen cycle = 10 e/t.
 * Used as the income unit in score computation.
 */
const SCORE_SOURCE_RATE = 10;

/**
 * Stored-energy level at which a room is considered "income-healthy" (factor 1.0).
 * Below this the storageFactor collapses toward 0.1, so income-starved rooms
 * never score as highly as rooms with buffer.
 */
const SCORE_INCOME_REFERENCE = 20_000;

/**
 * Per-colony investment priority score (higher → more worth upgrading now).
 * Recomputed every SCORE_CACHE_INTERVAL ticks and heap-cached (not in Memory).
 *
 * Formula:  rclFactor × incomeRate × storageFactor
 *
 *   rclFactor     = max(8 - rcl, 1)
 *                   Young rooms (RCL 4 → 4, RCL 5 → 3, RCL 6 → 2, RCL 7 → 1).
 *                   Rooms far from the RCL cap need more investment to become
 *                   self-sufficient and should be prioritised over near-maxed rooms.
 *
 *   incomeRate    = activeSources × SCORE_SOURCE_RATE   [energy/tick]
 *                   Income proxy: each source with a container and a living miner
 *                   produces ~10 e/t. Falls back to total planned sources × 10
 *                   during bootstrap (no miners yet) so young colonies still get
 *                   a non-zero income estimate rather than collapsing to 0.
 *
 *   storageFactor = clamp(storedEnergy / SCORE_INCOME_REFERENCE, 0.1, 1.0)
 *                   Collapses the score when storage is near-empty — an
 *                   income-starved room cannot absorb more upgrade drain and
 *                   should not rank highly regardless of its RCL gap.
 *                   Reads OWN storage via myStorage() — a reclaimed room's
 *                   foreign hoard (my:false) must not inflate the score.
 */
export function getColonyScore(room: Room): number {
  const entry = _colonyScoreCache.get(room.name);
  if (entry !== undefined && Game.time - entry.computedAt < SCORE_CACHE_INTERVAL) {
    return entry.score;
  }
  const score = _computeColonyScore(room);
  _colonyScoreCache.set(room.name, { score, computedAt: Game.time });
  return score;
}

function _computeColonyScore(room: Room): number {
  const rcl = room.controller?.level ?? 0;
  const mem = Memory.rooms[room.name];

  // Active sources: container present + miner assigned + miner alive
  const activeSources =
    mem?.sources?.filter((s) => s.containerId && s.minerName && !!Game.creeps[s.minerName])
      .length ?? 0;
  // Bootstrap fallback: use planned source count when no miners are alive yet
  const sourceCount = activeSources > 0 ? activeSources : (mem?.sources?.length ?? 0);
  const incomeRate = sourceCount * SCORE_SOURCE_RATE;

  // Use myStorage (ownership-aware) — room.storage is owner-agnostic and returns a
  // previous owner's structure in a reclaimed room; a 999k foreign hoard must not
  // inflate storageFactor to max and misrank a bootstrapping husk as our richest room.
  const stored = myStorage(room)?.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0;
  const storageFactor = Math.max(Math.min(stored / SCORE_INCOME_REFERENCE, 1.0), 0.1);

  // rclFactor: never below 1 so even a maxed RCL-8 room gets a non-zero score
  const rclFactor = Math.max(8 - rcl, 1);

  return rclFactor * incomeRate * storageFactor;
}

/**
 * Returns a snapshot of all owned-room scores keyed by room name.
 * Used by the colonies() console command and the visuals overlay.
 */
export function getColonyScores(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const room of Object.values(Game.rooms)) {
    if (!room.controller?.my) continue;
    out[room.name] = getColonyScore(room);
  }
  return out;
}

/**
 * Clears the heap score cache. Call in tests' beforeEach to prevent
 * stale values leaking between test cases.
 */
export function resetColonyScoreCache(): void {
  _colonyScoreCache.clear();
}

/** Maximum linear range from a home room to consider claiming. */
const MAX_CLAIM_DISTANCE = 3;
/** Recent-hostile window for reject (matches remotePlanner's 20k aggression window). */
const HOSTILE_REJECT_WINDOW = 20_000;
/** Recent-scout-hostile window (transient invaders age out faster). */
const SCOUT_HOSTILE_WINDOW = 1500;

export interface ClaimEvaluation {
  score: number;
  reason?: string;
}

/**
 * Score a candidate room for claiming. Returns -1 if the room is not viable.
 *
 * Scoring favours rooms with more sources, a mineral that differs from the home
 * room (diversifies lab inputs), shorter linear distance, and lower hostile risk.
 */
export function scoreClaimTarget(targetRoomName: string, homeRoomName: string): ClaimEvaluation {
  const tmem = Memory.rooms[targetRoomName];
  if (!tmem?.scoutedAt) return { score: -1, reason: 'not scouted' };
  if (!tmem.scoutedHasController) return { score: -1, reason: 'no controller' };
  if (tmem.scoutedOwner) return { score: -1, reason: `owned by ${tmem.scoutedOwner}` };

  // Allow rooms reserved by us; reject other players' reservations
  const myUsername = getMyUsername();
  if (tmem.scoutedReservation && tmem.scoutedReservation !== myUsername) {
    return { score: -1, reason: `reserved by ${tmem.scoutedReservation}` };
  }

  const sources = tmem.scoutedSources ?? 0;
  if (sources === 0) return { score: -1, reason: 'no sources' };

  // Reject rooms with recent hostile sightings
  const scoutAge = Game.time - tmem.scoutedAt;
  if ((tmem.scoutedHostiles ?? 0) > 0 && scoutAge < SCOUT_HOSTILE_WINDOW) {
    return { score: -1, reason: 'recent hostiles' };
  }

  // Reject rooms where aggressive neighbors have been seen recently
  const aggressiveInRoom = hostilesSeen(targetRoomName, HOSTILE_REJECT_WINDOW).some(
    (name) => getNeighbor(name)?.hostility === 'aggressive',
  );
  if (aggressiveInRoom) return { score: -1, reason: 'aggressive neighbor recent' };

  // Linear distance gate (Game.map.getRoomLinearDistance handles cross-shard edges)
  const distance = Game.map.getRoomLinearDistance(homeRoomName, targetRoomName);
  if (distance > MAX_CLAIM_DISTANCE) return { score: -1, reason: `distance ${distance}` };

  // Score components
  let score = sources * 10; // 2 sources is much better than 1
  score -= distance * 2; // closer is better

  // Mineral-diversity bonus: +5 when the candidate has a mineral that differs
  // from every currently-owned room's mineral (diversifies lab inputs).
  // Skip silently when the candidate has no scouted mineral or owned-room
  // minerals can't be resolved (owned rooms are always visible, so a null
  // getObjectById result just means the data isn't available yet).
  const candidateMineral = tmem.scoutedMineral?.type;
  if (candidateMineral !== undefined) {
    const ownedMinerals = new Set<MineralConstant>();
    for (const room of Object.values(Game.rooms)) {
      if (!room.controller?.my) continue;
      const roomMem = Memory.rooms[room.name];
      if (!roomMem?.mineralId) continue;
      const mineral = Game.getObjectById(roomMem.mineralId) as Mineral | null;
      if (mineral?.mineralType) ownedMinerals.add(mineral.mineralType);
    }
    // Only award the bonus when we successfully resolved at least one owned
    // mineral AND the candidate differs from all of them.
    if (ownedMinerals.size > 0 && !ownedMinerals.has(candidateMineral)) {
      score += 5;
    }
  }

  return { score };
}

/**
 * Scan all scouted rooms and return viable claim candidates ranked by score.
 *
 * For each scouted room the nearest owned room (by linear distance) is chosen
 * as the prospective parent. Rooms that are themselves owned, unscouted, or
 * score below zero (via scoreClaimTarget) are excluded.
 *
 * @returns Array sorted by score DESC, then by linear distance ASC.
 */
export function findClaimCandidates(): Array<{ target: string; home: string; score: number }> {
  // Collect owned rooms once so we can pick the nearest home per candidate.
  const ownedRooms: string[] = [];
  for (const room of Object.values(Game.rooms)) {
    if (room.controller?.my) ownedRooms.push(room.name);
  }
  if (ownedRooms.length === 0) return [];

  const results: Array<{ target: string; home: string; score: number; dist: number }> = [];

  for (const [roomName, mem] of Object.entries(Memory.rooms)) {
    if (!mem?.scoutedAt) continue; // not scouted

    // Skip rooms we already own — claiming ourselves makes no sense.
    const roomObj = Game.rooms[roomName];
    if (roomObj?.controller?.my) continue;

    // Pick the nearest owned room as prospective home.
    let nearestHome = ownedRooms[0]!;
    let nearestDist = Game.map.getRoomLinearDistance(nearestHome, roomName);
    for (let i = 1; i < ownedRooms.length; i++) {
      const candidate = ownedRooms[i]!;
      const d = Game.map.getRoomLinearDistance(candidate, roomName);
      if (d < nearestDist) {
        nearestDist = d;
        nearestHome = candidate;
      }
    }

    const eval_ = scoreClaimTarget(roomName, nearestHome);
    if (eval_.score < 0) continue;

    results.push({ target: roomName, home: nearestHome, score: eval_.score, dist: nearestDist });
  }

  // Sort: highest score first; break ties by shortest distance.
  results.sort((a, b) => b.score - a.score || a.dist - b.dist);

  return results.map(({ target, home, score }) => ({ target, home, score }));
}

/**
 * Returns the count of rooms we currently own (have controller.my === true).
 * Used to enforce the GCL-based room cap before issuing a claim.
 */
export function ownedRoomCount(): number {
  let count = 0;
  for (const room of Object.values(Game.rooms)) {
    if (room.controller?.my) count++;
  }
  return count;
}

/**
 * Check whether the player can claim another room: owned rooms must be < GCL.
 * Returns a human-readable reason when blocked.
 */
export function canClaimAnotherRoom(): { ok: true } | { ok: false; reason: string } {
  const gcl = Game.gcl.level;
  const owned = ownedRoomCount();
  if (owned >= gcl) {
    return { ok: false, reason: `GCL ${gcl} only allows ${gcl} room(s), currently own ${owned}` };
  }
  return { ok: true };
}

/**
 * Begin claiming a room. Validates GCL room cap and scouted intel, then writes
 * a ColonyMission into Memory.missions.colony. Idempotent — calling on an
 * already-claimed target returns the existing mission unchanged.
 */
export function startClaim(
  targetRoomName: string,
  homeRoomName: string,
): { ok: true; state: ColonyMission } | { ok: false; reason: string } {
  const colonies = getMissionsOfType<ColonyMission>('colony');

  const existing = colonies[targetRoomName];
  if (existing) return { ok: true, state: existing };

  const cap = canClaimAnotherRoom();
  if (!cap.ok) return cap;

  const homeRoom = Game.rooms[homeRoomName];
  if (!homeRoom?.controller?.my) {
    return { ok: false, reason: `home room ${homeRoomName} is not owned` };
  }

  const evalResult = scoreClaimTarget(targetRoomName, homeRoomName);
  if (evalResult.score < 0) {
    return { ok: false, reason: `target ${targetRoomName} not viable: ${evalResult.reason}` };
  }

  const state: ColonyMission = {
    type: 'colony',
    id: targetRoomName,
    homeRoom: homeRoomName,
    status: 'claiming',
    createdAt: Game.time,
    lastSynced: Game.time,
  };

  // Record transit rooms so the spawner can send hunters to unblock the path.
  const route = Game.map.findRoute(homeRoomName, targetRoomName);
  if (Array.isArray(route)) {
    const transit = route.map((step) => step.room).filter((r) => r !== targetRoomName);
    if (transit.length > 0) state.transitRooms = transit;
  }

  colonies[targetRoomName] = state;
  return { ok: true, state };
}

/**
 * Advance colony lifecycle states based on observed room state.
 * Called once per tick from the spawner before queue construction.
 *
 *   claiming      → bootstrapping  when controller.my === true
 *   bootstrapping → active         when a spawn exists AND a local harvester
 *                                  or miner exists (so the colony can refill
 *                                  its own spawn without parent support)
 *
 * Iterates Memory.missions.colony. Does not delete entries — operators can
 * inspect the historical record via the console. To remove, use
 * `delete Memory.missions.colony[room]` from the in-game console.
 */
export function updateColonyStates(): void {
  const colonies = getMissionsOfType<ColonyMission>('colony');
  for (const [targetRoom, state] of Object.entries(colonies)) {
    state.lastSynced = Game.time;

    const room = Game.rooms[targetRoom];
    if (!room) continue; // no visibility — wait

    if (state.status === 'claiming' && room.controller?.my) {
      state.status = 'bootstrapping';
      state.claimedAt = Game.time;
      console.log(`[colony] ${targetRoom} claimed at tick ${Game.time}, bootstrapping…`);
    }

    if (state.status === 'bootstrapping') {
      const spawns = room.find(FIND_MY_SPAWNS);
      if (spawns.length > 0) {
        // Wait for the colony to be genuinely self-sufficient before cutting parent
        // support. A single 1-WORK harvester at RCL 2 cannot build source containers
        // fast enough to flip minerEconomy, causing a permanent deadlock:
        //   no container → no miner → no miner economy → no container.
        //
        // We require at least one of:
        //   (a) A source container is built (containerId present) — miner economy can
        //       flip on its own from here; or
        //   (b) RCL 3 + extensions (≥550 energyCapacity) + a local harvester/miner —
        //       room has enough capacity to sustain itself without colonyBuilders.
        const roomMem = Memory.rooms[targetRoom];
        const hasContainer = roomMem?.sources?.some((s) => !!s.containerId) ?? false;

        const hasLocalProducer = Object.values(Game.creeps).some(
          (c) =>
            c.memory.homeRoom === targetRoom &&
            (c.memory.role === 'harvester' || c.memory.role === 'miner'),
        );
        const rcl3WithExtensions =
          (room.controller?.level ?? 0) >= 3 &&
          room.energyCapacityAvailable >= 550 &&
          hasLocalProducer;

        if (hasContainer || rcl3WithExtensions) {
          state.status = 'active';
          state.activeAt = Game.time;
          const reason = hasContainer ? 'source container built' : 'RCL 3 + extensions online';
          console.log(`[colony] ${targetRoom} active — ${reason} at tick ${Game.time}`);
        }
      }
    }
  }
}

/** Colonies parented by a given home room — used by the spawner's queue builder. */
export function coloniesForHome(homeRoomName: string): { room: string; state: ColonyMission }[] {
  const colonies = getMissionsOfType<ColonyMission>('colony');
  const out: { room: string; state: ColonyMission }[] = [];
  for (const [room, state] of Object.entries(colonies)) {
    if (state.homeRoom === homeRoomName) out.push({ room, state });
  }
  return out;
}

/** Every colony mission (room == id) — used by the `colonies()` console command. */
export function allColonies(): { room: string; state: ColonyMission }[] {
  const colonies = getMissionsOfType<ColonyMission>('colony');
  return Object.entries(colonies).map(([room, state]) => ({ room, state }));
}
