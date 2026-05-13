import {
  ENERGY_TERMINAL_BUFFER,
  MINERAL_TERMINAL_CEILING,
  getMaxBuyPrice,
  BUY_BATCH_SIZE,
  BUY_INTERVAL,
  MIN_BUY_ENERGY_BASE,
} from '../utils/thresholds';
import { getChainBuyNeeds } from './labs';

// Matches the 10-tick terminal cooldown so we capture every available sell
// window. Running every tick would do the same but cost more CPU on no-op
// store-scans; every 10 ticks is the sweet spot.
const MARKET_INTERVAL = 10;
const MIN_SELL_PRICE = 0.01;

// Base minerals that can be purchased on the market (not compound outputs)
const BUYABLE_MINERALS = new Set<string>(['H', 'O', 'U', 'L', 'K', 'Z', 'X', 'G']);

function sellSurplus(room: Room, terminal: StructureTerminal): void {
  let sold = false;
  for (const resource of Object.keys(terminal.store) as ResourceConstant[]) {
    if (resource === RESOURCE_ENERGY) continue;
    const amount = terminal.store.getUsedCapacity(resource);
    if (amount <= MINERAL_TERMINAL_CEILING) continue;

    const surplus = amount - MINERAL_TERMINAL_CEILING;
    const orders = Game.market.getAllOrders({ type: ORDER_BUY, resourceType: resource });
    let bestPrice = 0;
    let bestOrder: Order | undefined;
    for (const order of orders) {
      if (order.remainingAmount > 0 && order.price > bestPrice) {
        bestPrice = order.price;
        bestOrder = order;
      }
    }

    if (!bestOrder || bestPrice < MIN_SELL_PRICE) {
      console.log(`[terminal] ${room.name}: ${resource} surplus=${surplus}, no viable buy orders`);
      continue;
    }

    if (sold) {
      console.log(
        `[terminal] ${room.name}: ${resource} surplus=${surplus}, bestBuy=${bestPrice.toFixed(3)} (queued)`,
      );
      continue;
    }

    const dealAmount = Math.min(surplus, bestOrder.remainingAmount);
    const energyCost = Game.market.calcTransactionCost(dealAmount, room.name, bestOrder.roomName!);
    const terminalEnergy = terminal.store.getUsedCapacity(RESOURCE_ENERGY);

    if (terminalEnergy < energyCost + ENERGY_TERMINAL_BUFFER) {
      console.log(
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

    const buyAmount = Math.min(
      BUY_BATCH_SIZE - (inStorage + inTerminal),
      cheapestOrder.remainingAmount,
    );
    if (buyAmount <= 0) continue;

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

    if (terminal.cooldown === 0 && Game.time % MARKET_INTERVAL === 0) {
      sellSurplus(room, terminal);
    }
  }
}
