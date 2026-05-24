import { FACTORY_ENERGY_FLOOR, FACTORY_BATTERY_CAP } from '../utils/thresholds';

export function runFactory(): void {
  for (const room of Object.values(Game.rooms)) {
    if (!room.controller?.my || (room.controller.level ?? 0) < 7) continue;
    runRoomFactory(room);
  }
}

function runRoomFactory(room: Room): void {
  const mem = Memory.rooms[room.name];
  if (!mem) return;

  const factory = mem.factoryId ? Game.getObjectById(mem.factoryId) : undefined;
  if (!factory) {
    mem.factoryRecipe = undefined;
    return;
  }

  const storage = room.storage;
  if (!storage || storage.store.getUsedCapacity(RESOURCE_ENERGY) <= FACTORY_ENERGY_FLOOR) {
    mem.factoryRecipe = undefined;
    return;
  }

  const batteryStock = factory.store.getUsedCapacity(RESOURCE_BATTERY) ?? 0;
  if (batteryStock >= FACTORY_BATTERY_CAP) {
    mem.factoryRecipe = undefined;
    return;
  }

  mem.factoryRecipe = RESOURCE_BATTERY;
  factory.produce(RESOURCE_BATTERY);
}
