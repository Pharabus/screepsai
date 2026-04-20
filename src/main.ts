import { ErrorMapper } from './utils/ErrorMapper';
import { runSpawner } from './managers/spawner';
import { runRooms } from './managers/room';
import { runTowers } from './managers/towers';
import { runConstruction } from './managers/construction';
import { runDefense } from './managers/defense';
import { runVisuals } from './managers/visuals';
import { initMemory } from './utils/memoryInit';
import { resetTickCache } from './utils/tickCache';
import { flushSegments } from './utils/segments';
import { profile, installProfilerGlobals, formatStats, resetStatsNow } from './utils/profiler';

// Runs once per global reset (new IVM sandbox).
installProfilerGlobals();

// Also export as module.exports properties — the Screeps console can call any
// export from the main module directly (e.g. `stats()` in console).
export const stats = () => formatStats();
export const resetStats = () => {
  resetStatsNow();
  return 'stats cleared';
};

export const loop = ErrorMapper.wrapLoop(() => {
  profile('main.loop', () => {
    initMemory();
    resetTickCache();

    // Defense first: refreshes threat state before spawner decides whether to
    // build defenders and before towers pick their focus-fire target.
    profile('defense', runDefense);
    profile('spawner', runSpawner);
    profile('rooms', runRooms);
    profile('towers', runTowers);
    profile('construction', runConstruction);
    profile('visuals', runVisuals);

    flushSegments();
  });
});
