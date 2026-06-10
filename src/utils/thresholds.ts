export const MINERAL_STORAGE_FLOOR = 5000;

/** Target amount of boost compound to maintain in the reserved boost lab (covers several creeps, well under LAB_MINERAL_CAPACITY=3000). */
export const BOOST_LAB_MINERAL_TARGET = 1500;
/** Target energy to maintain in the reserved boost lab (under LAB_ENERGY_CAPACITY=2000). */
export const BOOST_LAB_ENERGY_TARGET = 1000;
/**
 * Factory only compresses energy into batteries when storage exceeds this
 * threshold. Deliberately set ABOVE the upgrader-expansion band (50k→1 upgrader,
 * 150k→2, 400k→3) so the factory never skims the surplus that should be
 * unlocking upgraders and RCL progress. At 50k the old floor competed directly
 * with the upgrader ramp; raising it to 120k means batteries are produced only
 * from genuine surplus, after extra upgraders are already funded.
 */
export const FACTORY_ENERGY_FLOOR = 120_000;
export const FACTORY_BATTERY_CAP = 400;

/**
 * Structure HP fraction below which repairs are triggered.
 * Used consistently by repairer role, spawner, and towers to avoid drift.
 */
export const REPAIR_THRESHOLD = 0.75;
export const MINERAL_TERMINAL_CEILING = 20_000;
/** Terminal mineral above this amount is sold as surplus. Sits below MINERAL_TERMINAL_CEILING (the combined hold/throttle cap) so there is always a sellable band — without this gap the terminal can never cross its own sell line and minerals never sell. */
export const MINERAL_TERMINAL_SELL_FLOOR = 10_000;
export const ENERGY_TERMINAL_BUFFER = 5_000;
export const TERMINAL_ENERGY_FLOOR = 15_000;
/**
 * Minimum terminal energy surplus above TERMINAL_ENERGY_FLOOR before a hauler
 * will restock storage from the terminal. Avoids micro-trips for trivial amounts.
 * Only active under Memory.holisticEconomy.
 */
export const TERMINAL_RESTOCK_MIN_BATCH = 2_000;

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
  const shard = Game.shard.name;
  if (MAX_BUY_PRICE_BY_SHARD[shard] !== undefined) {
    return MAX_BUY_PRICE_BY_SHARD[shard];
  }
  return DEFAULT_MAX_BUY_PRICE;
}

export const BUY_BATCH_SIZE = 3000;
export const BUY_INTERVAL = 500;
// Energy gates for lab buying: lower threshold for base minerals (H,O,K,L,Z,U,X,G)
// so the reaction chain can start accumulating well before we hit 100k terminal energy.
export const MIN_BUY_ENERGY_BASE = 30_000;
