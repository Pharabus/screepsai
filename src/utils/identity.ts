import { cached } from './tickCache';

/**
 * Returns the current player's username by inspecting the first spawn in Game.spawns.
 * Result is tick-cached so multiple managers can call this without redundant iteration.
 * Returns undefined when no spawn exists (e.g., during bootstrap or in tests with no spawns).
 */
export function getMyUsername(): string | undefined {
  return cached('me:username', () => {
    for (const name in Game.spawns) {
      return Game.spawns[name]?.owner.username;
    }
    return undefined;
  });
}
