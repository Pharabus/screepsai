export const MINERAL_STORAGE_FLOOR = 5000;
export const MINERAL_TERMINAL_CEILING = 20_000;
export const ENERGY_TERMINAL_BUFFER = 5_000;
export const TERMINAL_ENERGY_FLOOR = 15_000;

// Market buying thresholds.
// Base mineral prices vary wildly by shard: shard0 trades at ~0.05-0.5cr,
// but shard3 is illiquid and floor prices are ~99-150cr. Keying the cap on
// the active shard prevents the lab pipeline from deadlocking on shard3
// without forcing us to pay shard3-inflated prices on shard0.
const MAX_BUY_PRICE_BY_SHARD: Record<string, number> = {
  shard0: 0.5,
  shard1: 0.5,
  shard2: 0.5,
  shard3: 150,
};
const DEFAULT_MAX_BUY_PRICE = 0.5;

export function getMaxBuyPrice(): number {
  const shard = Game.shard?.name;
  if (shard && MAX_BUY_PRICE_BY_SHARD[shard] !== undefined) {
    return MAX_BUY_PRICE_BY_SHARD[shard];
  }
  return DEFAULT_MAX_BUY_PRICE;
}

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
