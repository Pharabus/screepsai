type CreepRoleName = 'harvester' | 'upgrader' | 'builder' | 'repairer' | 'defender';

interface CreepMemory {
  role: CreepRoleName;
}

// Per-room persistent memory. Managers extend this as they need cold data
// (planned structure positions, cached source ids, threat tracking, stats).
interface RoomMemory {
  // Defense (src/managers/defense.ts)
  threatLastSeen?: number;
  lastThreatScore?: number;
}

interface ProfilerSample {
  avg: number;
  last: number;
  max: number;
  samples: number;
}

interface Memory {
  creeps: { [name: string]: CreepMemory };
  rooms: { [name: string]: RoomMemory };
  // CPU samples by label, keyed by the name passed to profile().
  stats?: { [name: string]: ProfilerSample };
  // Toggles — default off, flip from the in-game console.
  profiling?: boolean;
  visuals?: boolean;
}

// Screeps provides a global require for loading modules
declare function require(module: string): unknown;

// CJS module object — used to attach console-callable exports
declare const module: { exports: Record<string, unknown> };

// Screeps provides a global console
declare const console: {
  log(...args: unknown[]): void;
};

// Screeps IVM sandbox global — the console evaluates against this object.
// eslint-disable-next-line no-var
declare var global: Record<string, unknown>;
