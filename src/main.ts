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
import { initMemory } from './utils/memoryInit';
import { resetTickCache } from './utils/tickCache';
import { resetTraffic, resolveTraffic } from './utils/trafficManager';
import { resetIdle } from './utils/idle';
import { cleanStuckTracker } from './utils/movement';
import { flushSegments } from './utils/segments';
import { profile, formatStats, resetStatsNow } from './utils/profiler';
import { computeLayout, findBestSpawnPosition } from './utils/layoutPlanner';
import { summarizeNeighbors } from './utils/neighbors';
import { startClaim, canClaimAnotherRoom, scoreClaimTarget } from './utils/colonyPlanner';

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
    lines.push(
      `${room.name}: RCL ${rcl}, economy=${economy}, sources=${sources}, containers=${containers}, links=${links}, storageLink=${storageLink}`,
    );
  }
  return lines.join('\n') || 'no owned rooms';
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

export const suggestSpawn = (roomName: string): string => {
  const result = findBestSpawnPosition(roomName);
  if (!result) return `No viable spawn position found in ${roomName}`;
  return `Best spawn for ${roomName}: (${result.x}, ${result.y}) score=${result.score}`;
};

/**
 * Begin claiming `targetRoom` parented by `homeRoom`. Validates GCL cap and
 * scouted intel; writes a ColonyState into Memory.colonies on success. If
 * homeRoom is omitted, picks the nearest owned room as the parent.
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
 * Show the lifecycle state of every entry in Memory.colonies.
 */
export const colonies = (): string => {
  const cs = Memory.colonies;
  if (!cs || Object.keys(cs).length === 0) return 'no colonies tracked';
  const lines: string[] = [];
  for (const [room, state] of Object.entries(cs)) {
    const claimAge = state.claimedAt ? Game.time - state.claimedAt : undefined;
    const activeAge = state.activeAt ? Game.time - state.activeAt : undefined;
    const ageStr = state.activeAt
      ? `, active for ${activeAge}t`
      : state.claimedAt
        ? `, claimed ${claimAge}t ago`
        : `, started ${Game.time - state.selectedAt}t ago`;
    lines.push(`${room}: home=${state.homeRoom}, status=${state.status}${ageStr}`);
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

// Register console globals (Screeps IVM evaluates console input against `global`)
global.stats = stats;
global.resetStats = resetStats;
global.status = status;
global.replanLayout = replanLayout;
global.neighbors = neighbors;
global.suggestSpawn = suggestSpawn;
global.claim = claim;
global.colonies = colonies;
global.evaluateClaim = evaluateClaim;

export const loop = ErrorMapper.wrapLoop(() => {
  profile('main.loop', () => {
    initMemory();
    resetTickCache();
    resetTraffic();
    resetIdle();
    cleanStuckTracker();

    // Defense first: refreshes threat state before spawner decides whether to
    // build defenders and before towers pick their focus-fire target.
    profile('defense', runDefense);
    profile('spawner', runSpawner);
    profile('links', runLinks);
    profile('rooms', runRooms);
    profile('traffic', resolveTraffic);
    profile('towers', runTowers);
    profile('labs', runLabs);
    profile('terminal', runTerminal);
    profile('construction', runConstruction);
    profile('visuals', runVisuals);

    flushSegments();
  });
});
