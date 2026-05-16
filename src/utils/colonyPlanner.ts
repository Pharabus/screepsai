/**
 * Colony planner — manages multi-room expansion via the claimer role.
 *
 * A "colony" is a target room we intend to claim. Lifecycle (see ColonyState):
 *   claiming → bootstrapping → active
 *
 * The home room (parent colony) is responsible for spawning the claimer that
 * takes the target room's controller, then sending colonyBuilders to build the
 * first spawn. Once the spawn exists, the new room runs the standard spawn
 * pipeline and the colony status flips to 'active'.
 *
 * Target selection is currently manual via the `claim(roomName)` console command.
 * Auto-selection can layer on top of scoreClaimTarget(). The 'selected' status
 * intentionally has no automatic transition — operators commit explicitly.
 */

import { hostilesSeen, getNeighbor } from './neighbors';

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
  const myUsername = Object.values(Game.spawns)[0]?.owner.username;
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
  return { score };
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
  const gcl = Game.gcl?.level ?? 1;
  const owned = ownedRoomCount();
  if (owned >= gcl) {
    return { ok: false, reason: `GCL ${gcl} only allows ${gcl} room(s), currently own ${owned}` };
  }
  return { ok: true };
}

/**
 * Begin claiming a room. Validates GCL room cap and scouted intel, then writes
 * a ColonyState into Memory.colonies. Idempotent — calling on an already-claimed
 * target returns the existing state unchanged.
 */
export function startClaim(
  targetRoomName: string,
  homeRoomName: string,
): { ok: true; state: ColonyState } | { ok: false; reason: string } {
  Memory.colonies ??= {};

  const existing = Memory.colonies[targetRoomName];
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

  const state: ColonyState = {
    homeRoom: homeRoomName,
    status: 'claiming',
    selectedAt: Game.time,
  };

  // Record transit rooms so the spawner can send hunters to unblock the path.
  const route = Game.map.findRoute(homeRoomName, targetRoomName);
  if (Array.isArray(route)) {
    const transit = route.map((step) => step.room).filter((r) => r !== targetRoomName);
    if (transit.length > 0) state.transitRooms = transit;
  }

  Memory.colonies[targetRoomName] = state;
  return { ok: true, state };
}

/**
 * Walk Memory.colonies and advance lifecycle states based on observed room state.
 * Called once per tick from the spawner before queue construction.
 *
 *   claiming      → bootstrapping  when controller.my === true
 *   bootstrapping → active         when a spawn exists AND a local harvester
 *                                  or miner exists (so the colony can refill
 *                                  its own spawn without parent support)
 *
 * Does not delete entries — operators can inspect the historical record via the
 * console. To remove, set Memory.colonies[room] = undefined manually.
 */
export function updateColonyStates(): void {
  if (!Memory.colonies) return;

  for (const [targetRoom, state] of Object.entries(Memory.colonies)) {
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
        // Wait for a self-sustaining local creep before cutting parent support.
        // Flipping on first-spawn deadlocked W44N57: spawn built with 0 energy,
        // colonyBuilders retired, nothing left to refill the spawn.
        const hasLocalProducer = Object.values(Game.creeps).some(
          (c) =>
            c.memory.homeRoom === targetRoom &&
            (c.memory.role === 'harvester' || c.memory.role === 'miner'),
        );
        if (hasLocalProducer) {
          state.status = 'active';
          state.activeAt = Game.time;
          console.log(`[colony] ${targetRoom} active — local economy online at tick ${Game.time}`);
        }
      }
    }
  }
}

/** Colonies parented by a given home room — used by the spawner's queue builder. */
export function coloniesForHome(homeRoomName: string): { room: string; state: ColonyState }[] {
  if (!Memory.colonies) return [];
  const out: { room: string; state: ColonyState }[] = [];
  for (const [room, state] of Object.entries(Memory.colonies)) {
    if (state.homeRoom === homeRoomName) out.push({ room, state });
  }
  return out;
}
