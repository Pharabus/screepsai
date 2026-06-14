// Combined health snapshot — runs in-game via `screeps-query.mjs probe`.
// Returns ONE compact object (rooms + sys + boost) so a single console round-trip
// yields everything the HealthCheck skill renders, with all filtering done here
// (so only the small object reaches the agent context). Must be a single JS
// expression that returns the payload — keep it ES5-safe for the console VM.
(function () {
  var rooms = Object.values(Game.rooms)
    .filter(function (r) {
      return r.controller && r.controller.my;
    })
    .map(function (r) {
      var s = r.storage,
        t = r.terminal,
        m = (Memory.rooms && Memory.rooms[r.name]) || {};
      var f = function (o) {
        var x = {};
        if (o)
          for (var k in o.store) if (k !== 'energy' && o.store[k] > 0) x[k] = o.store[k];
        return x;
      };
      return {
        n: r.name,
        rcl: r.controller.level,
        cp: +((100 * r.controller.progress) / (r.controller.progressTotal || 1)).toFixed(1),
        sm: r.controller.safeMode || 0,
        se: r.energyAvailable + '/' + r.energyCapacityAvailable,
        stE: s ? s.store.energy : null,
        stM: f(s),
        tE: t ? t.store.energy : null,
        tM: f(t),
        lab: r
          .find(FIND_MY_STRUCTURES)
          .filter(function (x) {
            return x.structureType === 'lab';
          })
          .map(function (l) {
            return (l.mineralType || '-') + ':' + (l.mineralType ? l.store[l.mineralType] : 0);
          }),
        bl: m.boostLabId ? m.boostCompound || '?' : null,
        rx: m.activeReaction ? m.activeReaction.output : null,
      };
    });
  var sys = {
    t: Game.time,
    b: Game.cpu.bucket,
    lim: Game.cpu.limit,
    tl: Game.cpu.tickLimit,
    gcl: Game.gcl.level,
    gp: +((100 * Game.gcl.progress) / Game.gcl.progressTotal).toFixed(1),
    cr: Math.round(Game.market.credits),
    ord: Object.keys(Game.market.orders || {}).length,
    loop:
      Memory.stats && Memory.stats['main.loop'] ? +Memory.stats['main.loop'].avg.toFixed(2) : null,
    sells: (Game.market.outgoingTransactions || [])
      .filter(function (x) {
        return x.order;
      })
      .slice(0, 5)
      .map(function (x) {
        return x.amount + x.resourceType + '@' + x.order.price.toFixed(2);
      }),
    buys: (Game.market.incomingTransactions || [])
      .filter(function (x) {
        return x.order;
      })
      .slice(0, 5)
      .map(function (x) {
        return x.amount + x.resourceType + '@' + x.order.price.toFixed(2);
      }),
    tr: (Game.market.incomingTransactions || [])
      .filter(function (x) {
        return !x.order;
      })
      .slice(0, 5)
      .map(function (x) {
        return x.amount + x.resourceType + ' ' + x.from + '>' + x.to;
      }),
  };
  var boost = typeof boostStatus === 'function' ? boostStatus() : null;
  return { rooms: rooms, sys: sys, boost: boost };
})();
