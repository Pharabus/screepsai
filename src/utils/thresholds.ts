export const MINERAL_STORAGE_FLOOR = 5000;
export const MINERAL_TERMINAL_CEILING = 50000;
export const ENERGY_TERMINAL_BUFFER = 50000;

// Market buying thresholds
export const MAX_BUY_PRICE = 0.5;
export const BUY_BATCH_SIZE = 3000;
export const BUY_INTERVAL = 500;
// Energy gates for lab buying: lower threshold for base minerals (H,O,K,L,Z,U,X,G)
// so the reaction chain can start accumulating well before we hit 100k terminal energy.
export const MIN_BUY_ENERGY_BASE = 30_000;
export const MIN_BUY_ENERGY_INTERMEDIATES = 60_000;

export function isTerminalSurplus(room: Room, resource: ResourceConstant): boolean {
  const terminal = room.terminal;
  if (!terminal) return false;
  return terminal.store.getUsedCapacity(resource) > MINERAL_TERMINAL_CEILING;
}
