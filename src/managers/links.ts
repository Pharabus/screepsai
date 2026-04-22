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

    for (const entry of mem.sources) {
      if (!entry.linkId) continue;
      const sourceLink = Game.getObjectById(entry.linkId);
      if (!sourceLink || sourceLink.cooldown > 0) continue;
      if (sourceLink.store.getUsedCapacity(RESOURCE_ENERGY) === 0) continue;

      // Prefer storage link as receiver; fall back to controller link
      if (storageLink && storageLink.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
        sourceLink.transferEnergy(storageLink);
      } else if (controllerLink && controllerLink.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
        sourceLink.transferEnergy(controllerLink);
      }
    }
  }
}
