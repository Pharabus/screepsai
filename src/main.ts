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

// Register console globals (Screeps IVM evaluates console input against `global`)
global.stats = stats;
global.resetStats = resetStats;
global.status = status;
global.replanLayout = replanLayout;
global.neighbors = neighbors;
global.suggestSpawn = suggestSpawn;

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
