import { FACTORY_ENERGY_FLOOR, FACTORY_BATTERY_CAP } from '../utils/thresholds';
import { colonyEnergy } from '../utils/economy';

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

  // Energy gate: factory only runs when surplus energy is available above the
  // upgrader band. Under holisticEconomy, terminal energy counts toward the
  // budget so a room with 80k storage + 50k terminal correctly passes 120k.
  // Flag-off: existing literal storage-only check (unchanged).
  // INVARIANT: UPGRADE_BUFFER[8]=100k < FACTORY_ENERGY_FLOOR=120k — factory
  // sits above the upgrade buffer so batteries only form from genuine surplus.
  const energyOk = Memory.holisticEconomy
    ? colonyEnergy(room) > FACTORY_ENERGY_FLOOR
    : (room.storage?.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0) > FACTORY_ENERGY_FLOOR;
  if (!energyOk) {
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
