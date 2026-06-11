import { ErrorMapper } from './utils/ErrorMapper';
import { runSpawner } from './managers/spawner';
import { runRooms } from './managers/room';
import { runTowers } from './managers/towers';
import { runConstruction } from './managers/construction';
import { runDefense } from './managers/defense';
import { runVisuals } from './managers/visuals';
import { runLinks } from './managers/links';
import { runTerminal } from './managers/terminal';
import { runLabs } from './managers/labs';
import { runFactory } from './managers/factory';
import { initMemory } from './utils/memoryInit';
import { resetTickCache } from './utils/tickCache';
import { resetTraffic, resolveTraffic, cleanPathSerialCache } from './utils/trafficManager';
import { resetIdle } from './utils/idle';
import { cleanStuckTracker } from './utils/movement';
import { flushSegments } from './utils/segments';
import { profile, formatStats, resetStatsNow } from './utils/profiler';
import { shouldRun, THROTTLE_HIGH, THROTTLE_NORMAL, THROTTLE_LOW } from './utils/throttle';
import { computeLayout, findBestSpawnPosition } from './utils/layoutPlanner';
import { replanPerimeterForRoom } from './utils/perimeterPlanner';
import { summarizeNeighbors } from './utils/neighbors';
import { formatCombatLog } from './utils/combatLog';
import {
  startClaim,
  canClaimAnotherRoom,
  scoreClaimTarget,
  getColonyScores,
  findClaimCandidates,
  allColonies,
} from './utils/colonyPlanner';
import {
  createTransportMission,
  getTransportMissions,
  TRANSPORT_DRAIN_ALL,
} from './utils/missions';
import { myStorage } from './utils/ownership';
import { roles } from './roles';

// Console-callable exports.
export const stats = () => formatStats();
export const resetStats = () => {
  resetStatsNow();
  return 'stats cleared';
};
export const status = () => {
  const lines: string[] = [];
  for (const room of Object.values(Game.rooms)) {
    if (!room.controller?.my) continue;
    const mem = Memory.rooms[room.name];
    const economy = mem?.minerEconomy ? 'miner' : 'bootstrap';
    const rcl = room.controller.level;
    const sources = mem?.sources?.length ?? '?';
    const containers = mem?.sources?.filter((s) => !!s.containerId).length ?? 0;
    const links = mem?.sources?.filter((s) => !!s.linkId).length ?? 0;
    const storageLink = mem?.storageLinkId ? 'yes' : 'no';
    const perim = mem?.perimeterPlan;
    const perimStr = perim
      ? `perimTiles=${perim.perimeterTiles.length} gates=${perim.gateTiles.length}`
      : 'perim=none';
    lines.push(
      `${room.name}: RCL ${rcl}, economy=${economy}, sources=${sources}, containers=${containers}, links=${links}, storageLink=${storageLink}, ${perimStr}`,
    );
  }
  return lines.join('\n') || 'no owned rooms';
};

export const replanPerimeter = (roomName: string): string => replanPerimeterForRoom(roomName);

export const replanLayout = (roomName: string): string => {
  const room = Game.rooms[roomName];
  if (!room) return `Room ${roomName} not visible`;
  const mem = (Memory.rooms[roomName] ??= {});
  delete mem.layoutPlan;
  const plan = computeLayout(room);
  if (!plan) return `Could not compute layout for ${roomName} (no spawn?)`;
  mem.layoutPlan = plan;
  return (
    `Layout planned for ${roomName}: ` +
    `${plan.extensionPositions.length} extensions, ` +
    `${plan.labPositions.length} labs, ` +
    `${plan.towerPositions.length} towers`
  );
};

export const neighbors = () => summarizeNeighbors();

export const combatLog = () => formatCombatLog();

export const suggestSpawn = (roomName: string): string => {
  const result = findBestSpawnPosition(roomName);
  if (!result) return `No viable spawn position found in ${roomName}`;
  return `Best spawn for ${roomName}: (${result.x}, ${result.y}) score=${result.score}`;
};

/**
 * Begin claiming `targetRoom` parented by `homeRoom`. Validates GCL cap and
 * scouted intel; writes a ColonyMission into Memory.missions.colony on success.
 * If homeRoom is omitted, picks the nearest owned room as the parent.
 */
export const claim = (targetRoom: string, homeRoom?: string): string => {
  if (!homeRoom) {
    let best: { name: string; dist: number } | undefined;
    for (const r of Object.values(Game.rooms)) {
      if (!r.controller?.my) continue;
      const dist = Game.map.getRoomLinearDistance(r.name, targetRoom);
      if (!best || dist < best.dist) best = { name: r.name, dist };
    }
    if (!best) return 'No owned rooms to parent the claim from';
    homeRoom = best.name;
  }

  const result = startClaim(targetRoom, homeRoom);
  if (!result.ok) return `claim refused: ${result.reason}`;
  return `claim started: ${targetRoom} parented by ${homeRoom} (status=${result.state.status})`;
};

/**
 * Show the lifecycle state of every colony mission (Memory.missions.colony),
 * plus per-room investment priority scores for all owned rooms.
 */
export const colonies = (): string => {
  const lines: string[] = [];

  // Per-owned-room priority scores (empire view)
  const scores = getColonyScores();
  if (Object.keys(scores).length > 0) {
    lines.push('--- owned rooms (priority scores) ---');
    const sorted = Object.entries(scores).sort(([, a], [, b]) => b - a);
    for (const [room, score] of sorted) {
      const r = Game.rooms[room];
      const rcl = r?.controller?.level ?? '?';
      const stored = (r ? myStorage(r) : undefined)?.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0;
      lines.push(`  ${room}: RCL=${rcl} storage=${stored} score=${score.toFixed(1)}`);
    }
  }

  // Colony lifecycle states
  const cs = allColonies();
  if (cs.length === 0) {
    lines.push('no colonies tracked');
  } else {
    lines.push('--- colony lifecycle ---');
    for (const { room, state } of cs) {
      const claimAge = state.claimedAt ? Game.time - state.claimedAt : undefined;
      const activeAge = state.activeAt ? Game.time - state.activeAt : undefined;
      const ageStr = state.activeAt
        ? `, active for ${activeAge}t`
        : state.claimedAt
          ? `, claimed ${claimAge}t ago`
          : `, started ${Game.time - state.createdAt}t ago`;
      lines.push(`  ${room}: home=${state.homeRoom}, status=${state.status}${ageStr}`);
    }
  }

  const cap = canClaimAnotherRoom();
  lines.push(cap.ok ? '(GCL allows another claim)' : `(${cap.reason})`);
  return lines.join('\n');
};

/**
 * Dry-run a claim — prints the score the planner would assign without writing
 * any state. Useful for picking between candidate rooms.
 */
export const evaluateClaim = (targetRoom: string, homeRoom?: string): string => {
  if (!homeRoom) {
    const first = Object.values(Game.rooms).find((r) => r.controller?.my);
    if (!first) return 'No owned rooms';
    homeRoom = first.name;
  }
  const e = scoreClaimTarget(targetRoom, homeRoom);
  if (e.score < 0) return `${targetRoom}: not viable — ${e.reason}`;
  return `${targetRoom}: viable, score=${e.score} (home=${homeRoom})`;
};

/**
 * Print a ranked table of viable claim candidates from scouted intel.
 * First line shows whether another claim is currently allowed; then each
 * candidate is listed with target, home, score, source count, mineral, and
 * linear distance — sorted best-first.
 */
export const claimCandidates = (): string => {
  const lines: string[] = [];

  const cap = canClaimAnotherRoom();
  lines.push(cap.ok ? 'Can claim: yes' : `Can claim: no — ${cap.reason}`);

  const candidates = findClaimCandidates();
  if (candidates.length === 0) {
    lines.push('No viable claim candidates scouted yet.');
    return lines.join('\n');
  }

  lines.push('target   home     score  sources  mineral  dist');
  lines.push('-------  -------  -----  -------  -------  ----');
  for (const { target, home, score } of candidates) {
    const mem = Memory.rooms[target];
    const sources = mem?.scoutedSources ?? '?';
    const mineral = mem?.scoutedMineral?.type ?? '-';
    const dist = Game.map.getRoomLinearDistance(home, target);
    lines.push(
      `${target.padEnd(8)} ${home.padEnd(8)} ${String(score).padEnd(6)} ${String(sources).padEnd(8)} ${String(mineral).padEnd(8)} ${dist}`,
    );
  }

  return lines.join('\n');
};

/**
 * Start a manual cross-room transport: couriers spawned from `dest` shuttle the
 * resource out of `source`'s storage/terminal into dest's OWN storage. `amount`
 * is a cap — the mission ends on delivered≥amount OR when the source is exhausted
 * (never hangs). Omit `amount` to drain the source fully.
 *
 * Primary use: drain a reclaimed room's previous-owner storage hoard into a
 * mature colony — which also empties the husk so the source can build its storage.
 *
 *   deliverEnergy('W42N59', 'W43N58')          // drain fully
 *   deliverEnergy('W42N59', 'W43N58', 100000)  // up to 100k
 */
export const deliverEnergy = (source: string, dest: string, amount?: number): string => {
  if (source === dest) return 'deliver refused: source and dest are the same room';
  const destRoom = Game.rooms[dest];
  if (!destRoom?.controller?.my) return `deliver refused: ${dest} is not an owned room`;
  if (!destRoom.storage?.my) return `deliver refused: ${dest} has no own storage to receive into`;
  const cap = amount && amount > 0 ? amount : TRANSPORT_DRAIN_ALL;
  const m = createTransportMission(source, dest, cap);
  const capStr = cap === TRANSPORT_DRAIN_ALL ? 'all available' : `up to ${cap}`;
  return `transport ${source}->${dest} started: ${capStr} ${m.resource} (couriers spawn from ${dest})`;
};

/**
 * Queue a dismantler to clear obstacle structures (towers) blocking the room
 * controller in an unowned target room, enabling a claimer to follow. The creep
 * pre-positions in the target room and waits until it is fully unowned (RCL 0)
 * before dismantling. homeRoom defaults to the nearest owned room.
 *
 * Cancel with: delete Memory.dismantleTarget
 */
export const dismantleTarget = (room: string, homeRoom?: string): string => {
  const home =
    homeRoom ??
    Object.values(Game.rooms)
      .filter((r) => r.controller?.my)
      .sort(
        (a, b) =>
          Game.map.getRoomLinearDistance(a.name, room) -
          Game.map.getRoomLinearDistance(b.name, room),
      )[0]?.name;
  if (!home) return 'No owned rooms found to spawn dismantler from';
  Memory.dismantleTarget = { room, homeRoom: home };
  return `Dismantler queued: ${home} → ${room}. Creep will pre-position and wait for RCL 0 before clearing towers.`;
};

/** List transport missions with delivered/target progress and live courier count. */
export const transports = (): string => {
  const missions = getTransportMissions();
  if (missions.length === 0) return 'No transport missions.';
  const lines = ['source   dest     resource  delivered  target     status    couriers'];
  for (const m of missions) {
    const target = m.targetAmount === TRANSPORT_DRAIN_ALL ? 'all' : String(m.targetAmount);
    lines.push(
      `${m.sourceRoom.padEnd(8)} ${m.destRoom.padEnd(8)} ${String(m.resource).padEnd(9)} ` +
        `${String(m.deliveredAmount).padEnd(10)} ${target.padEnd(10)} ${m.status.padEnd(9)} ${m.courierIds.length}`,
    );
  }
  return lines.join('\n');
};

// Register console globals (Screeps IVM evaluates console input against `global`)
global.stats = stats;
global.resetStats = resetStats;
global.status = status;
global.replanLayout = replanLayout;
global.replanPerimeter = replanPerimeter;
global.neighbors = neighbors;
global.combatLog = combatLog;
global.suggestSpawn = suggestSpawn;
global.claim = claim;
global.colonies = colonies;
global.evaluateClaim = evaluateClaim;
global.claimCandidates = claimCandidates;
global.deliverEnergy = deliverEnergy;
global.transports = transports;
global.dismantleTarget = dismantleTarget;
global.roles = roles;

export const loop = ErrorMapper.wrapLoop(() => {
  profile('main.loop', () => {
    initMemory();
    resetTickCache();
    resetTraffic();
    resetIdle();
    cleanStuckTracker();
    cleanPathSerialCache();

    // Defense first: refreshes threat state before spawner decides whether to
    // build defenders and before towers pick their focus-fire target.
    profile('defense', runDefense);
    if (shouldRun({ priority: THROTTLE_HIGH })) profile('spawner', runSpawner);
    if (shouldRun({ priority: THROTTLE_HIGH })) profile('links', runLinks);
    profile('rooms', runRooms);
    profile('traffic', resolveTraffic);
    if (shouldRun({ priority: THROTTLE_HIGH })) profile('towers', runTowers);
    if (shouldRun({ priority: THROTTLE_NORMAL })) profile('labs', runLabs);
    if (shouldRun({ priority: THROTTLE_NORMAL })) profile('factory', runFactory);
    if (shouldRun({ priority: THROTTLE_LOW })) profile('terminal', runTerminal);
    if (shouldRun({ interval: 5, priority: THROTTLE_LOW }))
      profile('construction', runConstruction);
    if (shouldRun({ priority: THROTTLE_LOW })) profile('visuals', runVisuals);

    flushSegments();
  });
});
