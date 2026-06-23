// Room layout probe — structures, sites, roads, terrain for Memory._probeRoom.
// Result: {rm, anc:{x,y}, st[], si[], rd[], g{}}
(function () {
  var rm = Memory._probeRoom;
  var r = Game.rooms[rm];
  if (!r) return {error: 'dark', rm: rm};
  var te = r.getTerrain();
  var sp = r.find(FIND_MY_SPAWNS);
  var anc = sp.length ? {x: sp[0].pos.x, y: sp[0].pos.y} : null;
  var all = r.find(FIND_STRUCTURES);
  var sk = {road: 1, rampart: 1, constructedWall: 1};
  var st = [], rd = [];
  for (var i = 0; i < all.length; i++) {
    var s = all[i], tp = s.structureType;
    if (tp == 'road') rd.push(s.pos.x + ',' + s.pos.y);
    else if (!sk[tp]) st.push({t: tp.slice(0, 3), x: s.pos.x, y: s.pos.y, my: s.my != false});
  }
  var si = r.find(FIND_MY_CONSTRUCTION_SITES).map(function (s) {
    return {t: s.structureType.slice(0, 3), x: s.pos.x, y: s.pos.y};
  });
  var g = {};
  if (anc) {
    for (var y = Math.max(0, anc.y - 14); y <= Math.min(49, anc.y + 14); y++)
      for (var x = Math.max(0, anc.x - 14); x <= Math.min(49, anc.x + 14); x++) {
        var v = te.get(x, y);
        if (v) g[x + ',' + y] = v;
      }
  }
  return {rm: rm, anc: anc, st: st, si: si, rd: rd, g: g};
})();
