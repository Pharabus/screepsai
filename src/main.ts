import { ErrorMapper } from './utils/ErrorMapper';
import { runSpawner } from './managers/spawner';
import { runRooms } from './managers/room';
import { runTowers } from './managers/towers';
import { runConstruction } from './managers/construction';
import { runDefense } from './managers/defense';
import { runVisuals } from './managers/visuals';
import { runLinks } from './managers/links';
import { initMemory } from './utils/memoryInit';
import { resetTickCache } from './utils/tickCache';
import { resetTraffic, resolveTraffic } from './utils/trafficManager';
import { resetIdle } from './utils/idle';
import { cleanStuckTracker } from './utils/movement';
import { flushSegments } from './utils/segments';
import { profile, formatStats, resetStatsNow } from './utils/profiler';

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

// Register console globals (Screeps IVM evaluates console input against `global`)
global.stats = stats;
global.resetStats = resetStats;
global.status = status;

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
    profile('construction', runConstruction);
    profile('visuals', runVisuals);

    flushSegments();
  });
});
