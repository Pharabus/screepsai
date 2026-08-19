import { FACTORY_ENERGY_FLOOR, FACTORY_BATTERY_CAP } from '../utils/thresholds';
import { colonyEnergy } from '../utils/economy';
import { myStorage, myTerminal } from '../utils/ownership';

/**
 * Deepest level-0 (no factory specialization required) product in the
 * silicon commodity chain: silicon + utrium_bar -> wire. Going further
 * (switch/transistor/microchip/...) needs a `level`-tagged recipe, which only
 * runs once a Power Creep applies PWR_OPERATE_FACTORY to this factory — a
 * separate, unbuilt subsystem. utrium_bar and wire both have `level:
 * undefined` in COMMODITIES, so any factory (leveled or not) can always
 * produce them, the same way an unleveled factory already produces battery.
 */
const SILICON_CHAIN_GOAL: CommodityConstant = RESOURCE_WIRE;

function totalStock(room: Room, resource: ResourceConstant): number {
  return (
    (myStorage(room)?.store.getUsedCapacity(resource) ?? 0) +
    (myTerminal(room)?.store.getUsedCapacity(resource) ?? 0)
  );
}

// Bounds the backward-chain walk below — COMMODITIES has no cycles in
// practice, but this keeps a data anomaly from ever looping.
const MAX_CHAIN_DEPTH = 6;

/**
 * Backward-chains from `resource` through COMMODITIES: if every component
 * `resource` itself needs is already stocked (room + factory combined),
 * returns `resource` — go ahead and make it. Otherwise recurses into
 * whichever component is short, looking for the first *makeable* step (mirrors
 * nextStepFor's backward-chaining in reactions.ts, but linear here — the
 * silicon chain doesn't branch the way the lab reaction goals do).
 *
 * A resource with no COMMODITIES entry (raw deposit/mineral, e.g. silicon or
 * U) is a base input — makeable only in the sense that we either have it or
 * we don't; returns it if we have any, undefined otherwise (nothing recurses
 * further, there is no recipe to fall back to).
 *
 * Returns undefined when genuinely blocked (missing a base input we have no
 * recipe to produce).
 */
function nextFactoryStep(
  room: Room,
  factory: StructureFactory,
  resource: ResourceConstant,
  depth = 0,
): ResourceConstant | undefined {
  if (depth >= MAX_CHAIN_DEPTH) return undefined;
  const recipe = COMMODITIES[resource as keyof typeof COMMODITIES];
  // A resource with no recipe (raw deposit/mineral, e.g. silicon or U) is
  // never something to call produce() on — the caller below only recurses
  // into a component's own recipe when one exists, so this branch should be
  // unreachable for the top-level goal, but stays safe (not "produce this")
  // if ever called on a base resource directly.
  if (!recipe) return undefined;
  // Recipe requires factory specialization we don't have (or don't have this
  // specific level of) — undefined, not a chain we can currently run.
  if (recipe.level !== undefined && factory.level !== recipe.level) return undefined;

  for (const component of Object.keys(recipe.components) as ResourceConstant[]) {
    if (component === RESOURCE_ENERGY) continue; // always deliverable, never the blocker
    const need = recipe.components[component as keyof typeof recipe.components] ?? 0;
    const have = totalStock(room, component) + (factory.store.getUsedCapacity(component) ?? 0);
    if (have >= need) continue; // sufficiently stocked — not the blocker

    // This component is short. If it has its own recipe, see if THAT is
    // makeable right now — produce the missing ingredient first. A base
    // resource (no recipe) with insufficient stock is a dead end: we have no
    // way to make more of it, so the whole chain is blocked here.
    const sub = COMMODITIES[component as keyof typeof COMMODITIES]
      ? nextFactoryStep(room, factory, component, depth + 1)
      : undefined;
    return sub;
  }
  return resource; // every component sufficiently stocked — make this one
}

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

  // Silicon chain takes priority over battery whenever the room actually
  // holds silicon — deposit-mined silicon is a scarce, one-off resource that
  // only ever depletes (see depositMiner), while battery is bulk energy
  // compression available any time storage has surplus and can always wait a
  // cycle. Inert (falls through to battery) for every room that has never
  // mined a deposit.
  if (totalStock(room, RESOURCE_SILICON) > 0) {
    const step = nextFactoryStep(room, factory, SILICON_CHAIN_GOAL);
    if (step) {
      mem.factoryRecipe = step;
      factory.produce(step as CommodityConstant);
      return;
    }
  }

  const batteryStock = factory.store.getUsedCapacity(RESOURCE_BATTERY) ?? 0;
  if (batteryStock >= FACTORY_BATTERY_CAP) {
    mem.factoryRecipe = undefined;
    return;
  }

  mem.factoryRecipe = RESOURCE_BATTERY;
  factory.produce(RESOURCE_BATTERY);
}
