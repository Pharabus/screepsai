export const MINERAL_STORAGE_FLOOR = 5000;

/** Target amount of boost compound to maintain in the reserved boost lab (covers several creeps, well under LAB_MINERAL_CAPACITY=3000). */
export const BOOST_LAB_MINERAL_TARGET = 1500;
/**
 * Hysteresis floor for KEEPING the boost lab reserved once it has been reserved.
 * Reserving STARTS at BOOST_LAB_MINERAL_TARGET (1500) but is MAINTAINED down to
 * this lower floor. Without hysteresis the reservation flip-flops: a single boost
 * consumes ~450 compound (30/part × ~15 work parts) which would drop the total
 * below the start threshold and unreserve the lab mid-cycle, stranding upgraders.
 * Set above one boost's worth so a boost never trips the release. (The transient
 * dip while haulers ferry compound into the lab is handled separately by counting
 * in-transit compound — see compoundInTransit / upgraderBoostWanted.)
 */
export const BOOST_LAB_MINERAL_MAINTAIN = 500;
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
 * Terminal sell floor for batteries. Batteries are a pure for-sale product
 * (compressed surplus energy → credits), so we hold none back — MIN_DEAL_SIZE
 * is the only gate on when a sale fires. Previously the sell floor reused
 * FACTORY_BATTERY_CAP (400, the factory's *production* cap), which deadlocked
 * sales: ~450 in the terminal gave a surplus of only 50, below MIN_DEAL_SIZE
 * (100), and the factory won't make more once colonyEnergy dips under
 * FACTORY_ENERGY_FLOOR — so the terminal batteries sat permanently unsold
 * (observed live W43N58: 450 batteries pinned with healthy 178cr/unit buy
 * orders on the book).
 */
export const BATTERY_TERMINAL_SELL_FLOOR = 0;

/**
 * Structure HP fraction below which repairs are triggered.
 * Used consistently by repairer role, spawner, and towers to avoid drift.
 */
export const REPAIR_THRESHOLD = 0.75;
/**
 * High-water mark for an uncapped reaction-chain intermediate (UL, ZK, OH, …
 * — compounds with no GOAL_CAPS entry) above which buying the leaves that
 * feed it is paused. Without this, a leaf (e.g. L) keeps getting bought to
 * make an intermediate (UL) that's already piled up (~13k observed live) —
 * the bottleneck is lab time / a different input, not this leaf. Well above
 * MIN_STEP_AMOUNT so a healthy chain never trips this; tunable.
 */
export const INTERMEDIATE_SATURATION = 5_000;
/**
 * Release-valve threshold (2x INTERMEDIATE_SATURATION) above which a chain
 * intermediate is grossly overstocked and the terminal portion is sold down
 * to INTERMEDIATE_SATURATION. Below this, intermediates are held entirely
 * (the normal "never sell what we're building" behavior) — only genuinely
 * frozen capital (e.g. ~14.7k UL while the goal chain only needs ~5k) is
 * released. See sellSurplus in terminal.ts.
 */
export const INTERMEDIATE_RELEASE_THRESHOLD = 10_000;
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
/**
 * Below this much OWN storage energy, a room lacks the buffer to ride out a
 * miner-replacement gap, so the emergency bootstrap harvester is warranted.
 * Well below mature operating levels (40k–100k) so routine miner churn never
 * trips it — harvesters are emergency low-energy bootstrappers, not a fixture of
 * mature rooms. Young/no-storage rooms (storage 0 < floor) keep the lifeline.
 */
export const HARVESTER_EMERGENCY_STORAGE_FLOOR = 5_000;

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
/**
 * Credit reserve that lab-input buying must never spend below. `buyForLabs`
 * skips when credits are at/under this floor and only ever spends the headroom
 * above it. Small relative to a healthy balance (~1.5M) so normal buying is
 * unaffected, but it stops the expensive-L top-up from draining the wallet to ~0
 * (observed live: credits crashed 1.5M→1, stranding defensive-boost buys and the
 * mineral-cooldown market bridge). Tunable.
 */
export const LAB_BUY_CREDIT_RESERVE = 50_000;
export const BUY_INTERVAL = 500;
// Energy gates for lab buying: lower threshold for base minerals (H,O,K,L,Z,U,X,G)
// so the reaction chain can start accumulating well before we hit 100k terminal energy.
export const MIN_BUY_ENERGY_BASE = 30_000;
