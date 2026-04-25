const MINERAL_STORAGE_FLOOR = 5000;

export function runTerminal(): void {
  if (Game.time % 10 !== 0) return;

  for (const room of Object.values(Game.rooms)) {
    if (!room.controller?.my) continue;
    if (!room.storage || !room.terminal) continue;
    if (room.terminal.cooldown > 0) continue;

    for (const resource of Object.keys(room.storage.store) as ResourceConstant[]) {
      if (resource === RESOURCE_ENERGY) continue;
      const stored = room.storage.store.getUsedCapacity(resource);
      if (stored <= MINERAL_STORAGE_FLOOR) continue;
      if (room.terminal.store.getFreeCapacity() < 1000) break;

      // Hauler will handle the actual transfer — this manager just logs intent
      // for now. Future: place sell orders when terminal has surplus.
    }
  }
}
