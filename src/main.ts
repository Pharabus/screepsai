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

/**
 * Toggle the min-cut perimeter algorithm. With no argument, flips the current
 * state; pass an explicit boolean to set it. Returns the new state.
 *
 * When on, planPerimeter() uses the terrain-aware min-cut barrier; when off it
 * uses the fixed-radius BFS ring (and populates perimeterPreview for the
 * RoomVisual A/B overlay). Re-run replanPerimeter(room) to recompute now.
 */
export const perimeterMinCut = (on?: boolean): string => {
  const next = on === undefined ? !Memory.perimeterMinCut : on;
  Memory.perimeterMinCut = next;
  return `Memory.perimeterMinCut = ${next} (run replanPerimeter(room) to recompute now)`;
};

/**
 * Toggle the perimeter A/B overlay (separate from the general `visuals` flag, so
 * the dense barrier overlay stays off during normal play). Requires
 * `Memory.visuals` to also be on for anything to render.
 */
export const perimeterVisuals = (on?: boolean): string => {
  const next = on === undefined ? !Memory.perimeterVisuals : on;
  Memory.perimeterVisuals = next;
  return `Memory.perimeterVisuals = ${next}${next && !Memory.visuals ? ' (also set Memory.visuals = true to render)' : ''}`;
};

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
      const stored = r?.storage?.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0;
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

// Register console globals (Screeps IVM evaluates console input against `global`)
global.stats = stats;
global.resetStats = resetStats;
global.status = status;
global.replanLayout = replanLayout;
global.replanPerimeter = replanPerimeter;
global.perimeterMinCut = perimeterMinCut;
global.perimeterVisuals = perimeterVisuals;
global.neighbors = neighbors;
global.combatLog = combatLog;
global.suggestSpawn = suggestSpawn;
global.claim = claim;
global.colonies = colonies;
global.evaluateClaim = evaluateClaim;
global.claimCandidates = claimCandidates;
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
