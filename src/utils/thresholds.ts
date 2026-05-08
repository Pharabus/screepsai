export const MINERAL_STORAGE_FLOOR = 5000;
export const MINERAL_TERMINAL_CEILING = 50000;
export const ENERGY_TERMINAL_BUFFER = 50000;
export const TERMINAL_ENERGY_FLOOR = 10_000;

// Market buying thresholds
export const MAX_BUY_PRICE = 0.5;
export const BUY_BATCH_SIZE = 3000;
export const BUY_INTERVAL = 500;
export const MIN_BUY_ENERGY = 100_000;

export function isTerminalSurplus(room: Room, resource: ResourceConstant): boolean {
  const terminal = room.terminal;
  if (!terminal) return false;
  return terminal.store.getUsedCapacity(resource) > MINERAL_TERMINAL_CEILING;
}
