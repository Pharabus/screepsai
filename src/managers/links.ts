export function runLinks(): void {
  for (const room of Object.values(Game.rooms)) {
    if (!room.controller?.my) continue;
    const mem = Memory.rooms[room.name];
    if (!mem?.sources) continue;

    const storageLinkId = mem.storageLinkId;
    const controllerLinkId = mem.controllerLinkId;
    const storageLink = storageLinkId ? Game.getObjectById(storageLinkId) : undefined;
    const controllerLink = controllerLinkId ? Game.getObjectById(controllerLinkId) : undefined;

    if (!storageLink && !controllerLink) continue;

    // Track whether a source link has already fed the controller link this tick
    // so at most one transfer goes there (the rest top up the storage link).
    let controllerFed = false;
    for (const entry of mem.sources) {
      if (!entry.linkId) continue;
      const sourceLink = Game.getObjectById(entry.linkId);
      if (!sourceLink || sourceLink.cooldown > 0) continue;
      if (sourceLink.store.getUsedCapacity(RESOURCE_ENERGY) === 0) continue;

      // Proactively send one source link to the controller link when it's running
      // low (< 400) — prevents upgraders from stalling while the storage link
      // stays perpetually drained by haulers and never triggers the fallback path.
      const controllerNeedsEnergy =
        !controllerFed &&
        controllerLink &&
        controllerLink.store.getUsedCapacity(RESOURCE_ENERGY) < 400 &&
        controllerLink.store.getFreeCapacity(RESOURCE_ENERGY) > 0;

      if (controllerNeedsEnergy) {
        sourceLink.transferEnergy(controllerLink!);
        controllerFed = true;
      } else if (storageLink && storageLink.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
        sourceLink.transferEnergy(storageLink);
      } else if (controllerLink && controllerLink.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
        sourceLink.transferEnergy(controllerLink);
      }
    }
  }
}
