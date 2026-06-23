// Creep status probe — returns all creeps in a room with state and position.
// Requires Memory._probeRoom to be set first.
// Result: {rm, tick, creeps[]}
//   Each creep: {name, role, x, y, state, ttl, carry, home, target, fatigue}
(function () {
  var rm = Memory._probeRoom;
  var cr = Object.values(Game.creeps)
    .filter(function (c) {
      return c.room && c.room.name == rm;
    })
    .map(function (c) {
      var m = c.memory;
      return {
        name: c.name,
        role: m.role,
        x: c.pos.x,
        y: c.pos.y,
        state: m.state,
        ttl: c.ticksToLive,
        carry: c.store.getUsedCapacity() + '/' + c.store.getCapacity(),
        home: m.homeRoom,
        target: m.targetRoom,
        fatigue: c.fatigue,
      };
    });
  return { rm: rm, tick: Game.time, creeps: cr };
})();
