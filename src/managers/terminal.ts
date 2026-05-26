import {
  ENERGY_TERMINAL_BUFFER,
  FACTORY_BATTERY_CAP,
  MINERAL_TERMINAL_SELL_FLOOR,
  getMaxBuyPrice,
  BUY_BATCH_SIZE,
  BUY_INTERVAL,
  MIN_BUY_ENERGY_BASE,
} from '../utils/thresholds';
import { getChainBuyNeeds } from './labs';
import { coloniesForHome, getColonyScore } from '../utils/colonyPlanner';

// Matches the 10-tick terminal cooldown so we capture every available sell
// window. Running every tick would do the same but cost more CPU on no-op
// store-scans; every 10 ticks is the sweet spot.
const MARKET_INTERVAL = 10;
const MIN_SELL_PRICE = 0.01;
// Ignore orders with < 100 remaining and never deal < 100 units. Shard3 is
// full of 1-unit honeypot orders at 500cr designed to waste terminal cooldowns.
const MIN_DEAL_SIZE = 100;
// Skip a deal when energy fees exceed this fraction of gross revenue (treating
// 1 energy ≈ 1 credit). Prevents selling cheap minerals at a net energy loss.
const MAX_ENERGY_FEE_FRACTION = 0.5;

// Base minerals that can be purchased on the market (not compound outputs)
const BUYABLE_MINERALS = new Set<string>(['H', 'O', 'U', 'L', 'K', 'Z', 'X', 'G']);

/**
 * Verbose per-interval "why we didn't sell" diagnostics. Gated behind
 * Memory.terminalDebug — in steady state these fire every window (e.g. batteries
 * trickling in just above the sell floor with surplus < MIN_DEAL_SIZE) and spam
 * the console. Actual sells and deal failures always log unconditionally.
 */
function sellDebug(msg: string): void {
  if (Memory.terminalDebug) console.log(msg);
}

function sellSurplus(room: Room, terminal: StructureTerminal): void {
  let sold = false;
  for (const resource of Object.keys(terminal.store) as ResourceConstant[]) {
    if (resource === RESOURCE_ENERGY) continue;
    // Batteries use a lower floor — they're factory products for sale, not lab stockpile
    const sellFloor =
      resource === RESOURCE_BATTERY ? FACTORY_BATTERY_CAP : MINERAL_TERMINAL_SELL_FLOOR;
    const amount = terminal.store.getUsedCapacity(resource);
    if (amount <= sellFloor) continue;

    const surplus = amount - sellFloor;
    const orders = Game.market.getAllOrders({ type: ORDER_BUY, resourceType: resource });
    // Rank by revenue-per-deal (min(surplus, remaining) * price), not just price.
    // A high-price decoy with remainingAmount=1 wastes a 10-tick cooldown for 1 unit;
    // a real bulk order at lower price clears far more surplus per deal.
    let bestRevenue = 0;
    let bestOrder: Order | undefined;
    for (const order of orders) {
      if (order.remainingAmount < MIN_DEAL_SIZE) continue; // fix #1: decoy filter
      if (order.price < MIN_SELL_PRICE) continue;
      const revenue = Math.min(surplus, order.remainingAmount) * order.price;
      if (revenue > bestRevenue) {
        bestRevenue = revenue;
        bestOrder = order;
      }
    }

    if (!bestOrder) {
      sellDebug(`[terminal] ${room.name}: ${resource} surplus=${surplus}, no viable buy orders`);
      continue;
    }
    const bestPrice = bestOrder.price;

    if (sold) {
      sellDebug(
        `[terminal] ${room.name}: ${resource} surplus=${surplus}, bestBuy=${bestPrice.toFixed(3)} (queued)`,
      );
      continue;
    }

    const dealAmount = Math.min(surplus, bestOrder.remainingAmount);
    if (dealAmount < MIN_DEAL_SIZE) {
      sellDebug(
        `[terminal] ${room.name}: ${resource} surplus=${surplus}, deal too small (${dealAmount})`,
      );
      continue;
    }
    const energyCost = Game.market.calcTransactionCost(dealAmount, room.name, bestOrder.roomName!);

    // fix #3: energy-fee profitability guard (1 energy ≈ 1 credit approximation)
    const revenue = dealAmount * bestOrder.price;
    if (energyCost > revenue * MAX_ENERGY_FEE_FRACTION) {
      sellDebug(
        `[terminal] ${room.name}: ${resource} skipping (energy fee ${energyCost} > ${Math.round(revenue * MAX_ENERGY_FEE_FRACTION)} limit)`,
      );
      continue;
    }

    const terminalEnergy = terminal.store.getUsedCapacity(RESOURCE_ENERGY);
    if (terminalEnergy < energyCost + ENERGY_TERMINAL_BUFFER) {
      sellDebug(
        `[terminal] ${room.name}: ${resource} surplus=${surplus}, skipping (need ${energyCost} energy, have ${terminalEnergy})`,
      );
      continue;
    }

    const result = Game.market.deal(bestOrder.id, dealAmount, room.name);
    if (result === OK) {
      console.log(
        `[terminal] ${room.name}: sold ${dealAmount} ${resource} @ ${bestPrice.toFixed(3)} (cost ${energyCost} energy)`,
      );
      sold = true;
    } else {
      console.log(`[terminal] ${room.name}: deal failed for ${resource}, error=${result}`);
    }
  }
}

function buyForLabs(room: Room, terminal: StructureTerminal): void {
  // Kill-switch: pause all lab-input market purchases (set from the console).
  if (Memory.pauseLabBuying) return;
  // Gate: need at least 3 labs and an active or pending reaction
  const mem = Memory.rooms[room.name];
  if (!mem?.labIds || mem.labIds.length < 3) return;
  // Don't spend credits on lab inputs until we have an energy surplus
  if (Game.market.credits < 50) return;

  const storage = room.storage;
  const storageEnergy = storage?.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0;
  if (storageEnergy < MIN_BUY_ENERGY_BASE) return;
  const terminalEnergy = terminal.store.getUsedCapacity(RESOURCE_ENERGY);
  const ownMineral = mem.mineralId
    ? (Game.getObjectById(mem.mineralId) as Mineral | null)?.mineralType
    : undefined;

  // Ask the lab manager which minerals the current chain needs
  const needs = getChainBuyNeeds(room);

  // Also include current active reaction inputs as fallback
  const toConsider: ResourceConstant[] = [...needs];
  if (mem.activeReaction && toConsider.length === 0) {
    toConsider.push(mem.activeReaction.input1, mem.activeReaction.input2);
  }

  for (const mineral of toConsider) {
    if (mineral === ownMineral) continue; // we produce this
    if (!BUYABLE_MINERALS.has(mineral)) continue; // only buy base minerals

    const inStorage = storage?.store.getUsedCapacity(mineral) ?? 0;
    const inTerminal = terminal.store.getUsedCapacity(mineral);
    if (inStorage + inTerminal >= BUY_BATCH_SIZE) continue; // already stocked

    const maxBuyPrice = getMaxBuyPrice();
    const orders = Game.market.getAllOrders({ type: ORDER_SELL, resourceType: mineral });
    let cheapestOrder: Order | undefined;
    let lowestPrice = Infinity;
    for (const order of orders) {
      if (order.remainingAmount > 0 && order.price < lowestPrice && order.price <= maxBuyPrice) {
        lowestPrice = order.price;
        cheapestOrder = order;
      }
    }

    if (!cheapestOrder) {
      console.log(
        `[terminal] ${room.name}: need ${mineral} for labs, no sell orders <= ${maxBuyPrice}`,
      );
      continue;
    }

    const wantAmount = Math.min(
      BUY_BATCH_SIZE - (inStorage + inTerminal),
      cheapestOrder.remainingAmount,
    );
    const affordableAmount = Math.floor(Game.market.credits / cheapestOrder.price);
    const buyAmount = Math.min(wantAmount, affordableAmount);
    if (buyAmount <= 0) {
      if (wantAmount > 0) {
        console.log(
          `[terminal] ${room.name}: insufficient credits for ${mineral} @ ${cheapestOrder.price.toFixed(3)} (have ${Game.market.credits.toFixed(0)})`,
        );
      }
      continue;
    }

    const energyCost = Game.market.calcTransactionCost(
      buyAmount,
      room.name,
      cheapestOrder.roomName!,
    );
    if (terminalEnergy < energyCost + ENERGY_TERMINAL_BUFFER) {
      console.log(`[terminal] ${room.name}: skipping buy ${mineral} (need ${energyCost} energy)`);
      continue;
    }

    const result = Game.market.deal(cheapestOrder.id, buyAmount, room.name);
    if (result === OK) {
      console.log(
        `[terminal] ${room.name}: bought ${buyAmount} ${mineral} @ ${lowestPrice.toFixed(3)} for labs`,
      );
    } else {
      console.log(`[terminal] ${room.name}: buy failed for ${mineral}, error=${result}`);
    }
    return; // one purchase per interval
  }
}

// ---------------------------------------------------------------------------
// Score-driven inter-room energy support
// ---------------------------------------------------------------------------
// A home room with an established terminal and energy surplus can ship energy
// to the highest-priority colony whose own terminal is online but storage is
// still building. The receiver is chosen by colony priority score (higher RCL
// gap + healthy income = higher score) so available surplus flows to where it
// accelerates the empire most.
//
// Currently dormant for W44N57 (no terminal at RCL 4) — auto-engages once it
// reaches RCL 6 and builds a terminal.
// ---------------------------------------------------------------------------

const COLONY_SEND_INTERVAL = 100;
/** Per-shipment payload. Big enough to dwarf the transaction fee on adjacent rooms. */
const COLONY_SEND_AMOUNT = 10_000;
/** Home storage must hold at least this much before we'll donate energy. */
const HOME_SURPLUS_FLOOR = 80_000;
/** Stop topping a colony up once its storage clears this bar. */
const COLONY_STORAGE_TARGET = 30_000;
/**
 * Minimum ticks between sends on the same home→colony route. Prevents the
 * same shipment from being repeated every 100 ticks before the previous one
 * has been absorbed (hysteresis). The receiver's storage must also drop back
 * below COLONY_STORAGE_TARGET for a subsequent send to trigger.
 */
const COLONY_SEND_HYSTERESIS_TICKS = 300;

/**
 * Module-scope hysteresis tracker — keyed "senderRoom->receiverRoom", value is
 * the tick of the last successful send on that route. Lives on the heap so it
 * clears on global reset (harmless: worst case one extra send after a reset).
 */
const _lastColonySend = new Map<string, number>();

function sendEnergyToColonies(home: Room, terminal: StructureTerminal): void {
  const homeStorage = home.storage?.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0;
  if (homeStorage < HOME_SURPLUS_FLOOR) return;
  if (terminal.store.getUsedCapacity(RESOURCE_ENERGY) < COLONY_SEND_AMOUNT + ENERGY_TERMINAL_BUFFER)
    return;

  // Collect all eligible receivers and rank by investment priority.
  // Eligible = colony room with terminal, storage below target, enough free capacity.
  const candidates: Array<{
    colonyRoom: string;
    score: number;
    colonyStorage: number;
    dist: number;
  }> = [];

  for (const { room: colonyRoom, state } of coloniesForHome(home.name)) {
    if (state.status === 'claiming') continue; // no terminal exists yet
    const target = Game.rooms[colonyRoom];
    if (!target?.controller?.my) continue;
    const colonyTerminal = target.terminal;
    if (!colonyTerminal) continue; // RCL < 6 — no terminal yet; auto-engages when it builds one
    const colonyStorage = target.storage?.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0;
    if (colonyStorage >= COLONY_STORAGE_TARGET) continue; // already well-stocked
    if (colonyTerminal.store.getFreeCapacity(RESOURCE_ENERGY) < COLONY_SEND_AMOUNT) continue;

    // Hysteresis: skip if a shipment on this route already landed recently.
    // Only applies when a previous send has been recorded (lastSent > 0) so
    // the very first shipment on a route is never blocked regardless of Game.time.
    const routeKey = `${home.name}->${colonyRoom}`;
    const lastSent = _lastColonySend.get(routeKey) ?? 0;
    if (lastSent > 0 && Game.time - lastSent < COLONY_SEND_HYSTERESIS_TICKS) continue;

    const score = getColonyScore(target);
    // Geographic distance — used as a tie-breaker so the closest eligible
    // sender routes to each receiver (Harabi "geographically closest source").
    const dist = Game.map.getRoomLinearDistance(home.name, colonyRoom);
    candidates.push({ colonyRoom, score, colonyStorage, dist });
  }

  if (candidates.length === 0) return;

  // Sort: highest priority score first, then most urgent (lowest storage),
  // then closest (shortest route = cheapest transaction fee).
  candidates.sort(
    (a, b) => b.score - a.score || a.colonyStorage - b.colonyStorage || a.dist - b.dist,
  );

  const best = candidates[0]!;
  const result = terminal.send(
    RESOURCE_ENERGY,
    COLONY_SEND_AMOUNT,
    best.colonyRoom,
    'colony energy support',
  );
  if (result === OK) {
    _lastColonySend.set(`${home.name}->${best.colonyRoom}`, Game.time);
    console.log(
      `[terminal] ${home.name}: sent ${COLONY_SEND_AMOUNT} energy to ${best.colonyRoom}` +
        ` (score=${best.score.toFixed(1)}, storage=${best.colonyStorage})`,
    );
  } else {
    console.log(`[terminal] ${home.name}: colony send to ${best.colonyRoom} failed: ${result}`);
  }
}

/** Clears the hysteresis tracker — call in tests' beforeEach to prevent cross-test contamination. */
export function resetColonySendCache(): void {
  _lastColonySend.clear();
}

export function runTerminal(): void {
  for (const room of Object.values(Game.rooms)) {
    if (!room.controller?.my) continue;
    const terminal = room.terminal;
    if (!terminal || terminal.cooldown > 0) continue;

    // Buy runs first so it isn't blocked when both intervals coincide
    // (every 500 ticks). If buy deals, the cooldown re-check below skips sell.
    if (Game.time % BUY_INTERVAL === 0) {
      buyForLabs(room, terminal);
    }

    if (terminal.cooldown === 0 && Game.time % COLONY_SEND_INTERVAL === 0) {
      sendEnergyToColonies(room, terminal);
    }

    if (terminal.cooldown === 0 && Game.time % MARKET_INTERVAL === 0) {
      sellSurplus(room, terminal);
    }
  }
}
