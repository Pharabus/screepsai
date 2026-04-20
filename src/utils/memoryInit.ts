/**
 * One-shot Memory shape initialisation.
 *
 * Runs once per global reset (i.e. whenever the sandbox is rebuilt — code
 * deploy, IVM restart, etc.), not every tick. Managers can then assume
 * `Memory.rooms` exists and skip defensive `??= {}` branches in their hot
 * path, which also means we don't mutate the top-level Memory object every
 * tick just to set up empty containers.
 */

let initialised = false;

export function initMemory(): void {
  if (initialised) return;
  initialised = true;

  // Touching these getters parses the Memory blob once, then fills in any
  // missing top-level shape. After this, per-tick code reads Memory.rooms[...]
  // without needing to guard.
  if (!Memory.creeps) Memory.creeps = {};
  if (!Memory.rooms) Memory.rooms = {};
}
