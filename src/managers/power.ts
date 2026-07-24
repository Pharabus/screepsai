export function runPowerSpawn(): void {
  for (const room of Object.values(Game.rooms)) {
    if (!room.controller?.my || (room.controller.level ?? 0) < 8) continue;
    runRoomPowerSpawn(room);
  }
}

function runRoomPowerSpawn(room: Room): void {
  const mem = Memory.rooms[room.name];
  const powerSpawn = mem?.powerSpawnId ? Game.getObjectById(mem.powerSpawnId) : undefined;
  if (!powerSpawn) return;

  if (powerSpawn.store.getUsedCapacity(RESOURCE_POWER) < 1) return;
  if (powerSpawn.store.getUsedCapacity(RESOURCE_ENERGY) < POWER_SPAWN_ENERGY_RATIO) return;

  powerSpawn.processPower();
}
