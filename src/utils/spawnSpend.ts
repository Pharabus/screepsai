/**
 * Rolling per-room record of spawn spend by role, so "where did this room's
 * energy go" can be answered from `Memory.spawnSpend` instead of inferred.
 *
 * Live motivation: W44N57's storage fell 217k to 0 and the cause (factory,
 * Source Keeper crews or plain spawning) had to be guessed from snapshots.
 * Keys are `role` or `role>targetRoom` for creeps working another room.
 * Two windows are kept: the one in progress and the previous complete one.
 */

/** Length of one accounting window in ticks. */
export const SPAWN_SPEND_WINDOW = 5000;

export function recordSpawnSpend(
  room: string,
  role: string,
  body: BodyPartConstant[],
  targetRoom?: string,
): void {
  const cost = body.reduce((sum, part) => sum + BODYPART_COST[part], 0);
  const store = (Memory.spawnSpend ??= { since: Game.time, rooms: {} });
  if (Game.time - store.since >= SPAWN_SPEND_WINDOW) {
    store.prev = { since: store.since, rooms: store.rooms };
    store.rooms = {};
    store.since = Game.time;
  }
  const key = targetRoom && targetRoom !== room ? `${role}>${targetRoom}` : role;
  const byRole = (store.rooms[room] ??= {});
  const entry = (byRole[key] ??= { n: 0, cost: 0 });
  entry.n++;
  entry.cost += cost;
}
