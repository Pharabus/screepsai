import { ENERGY_TERMINAL_BUFFER, MINERAL_TERMINAL_CEILING } from '../utils/thresholds';

const MARKET_INTERVAL = 100;
const MIN_SELL_PRICE = 0.01;

export function runTerminal(): void {
  if (Game.time % MARKET_INTERVAL !== 0) return;

  for (const room of Object.values(Game.rooms)) {
    if (!room.controller?.my) continue;
    const terminal = room.terminal;
    if (!terminal || terminal.cooldown > 0) continue;

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
        console.log(
          `[terminal] ${room.name}: ${resource} surplus=${surplus}, no viable buy orders`,
        );
        continue;
      }

      if (sold) {
        console.log(
          `[terminal] ${room.name}: ${resource} surplus=${surplus}, bestBuy=${bestPrice.toFixed(3)} (queued)`,
        );
        continue;
      }

      const dealAmount = Math.min(surplus, bestOrder.remainingAmount);
      const energyCost = Game.market.calcTransactionCost(
        dealAmount,
        room.name,
        bestOrder.roomName!,
      );
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
}
