import { MINERAL_TERMINAL_CEILING } from '../utils/thresholds';

const MARKET_LOG_INTERVAL = 100;

export function runTerminal(): void {
  if (Game.time % MARKET_LOG_INTERVAL !== 0) return;

  for (const room of Object.values(Game.rooms)) {
    if (!room.controller?.my) continue;
    const terminal = room.terminal;
    if (!terminal) continue;

    for (const resource of Object.keys(terminal.store) as ResourceConstant[]) {
      if (resource === RESOURCE_ENERGY) continue;
      const amount = terminal.store.getUsedCapacity(resource);
      if (amount <= MINERAL_TERMINAL_CEILING) continue;

      const orders = Game.market.getAllOrders({ type: ORDER_BUY, resourceType: resource });
      let bestPrice = 0;
      let bestOrderId = '';
      for (const order of orders) {
        if (order.remainingAmount > 0 && order.price > bestPrice) {
          bestPrice = order.price;
          bestOrderId = order.id;
        }
      }

      if (bestPrice > 0) {
        console.log(
          `[terminal] ${room.name}: ${resource} surplus=${amount - MINERAL_TERMINAL_CEILING}, bestBuy=${bestPrice.toFixed(3)} (${bestOrderId})`,
        );
      } else {
        console.log(
          `[terminal] ${room.name}: ${resource} surplus=${amount - MINERAL_TERMINAL_CEILING}, no buy orders`,
        );
      }
    }
  }
}
