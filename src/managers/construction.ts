// Max extensions per RCL level (from Screeps docs)
const MAX_EXTENSIONS: Record<number, number> = {
  0: 0,
  1: 0,
  2: 5,
  3: 10,
  4: 20,
  5: 30,
  6: 40,
  7: 50,
  8: 60,
};

const MAX_TOWERS: Record<number, number> = {
  0: 0,
  1: 0,
  2: 0,
  3: 1,
  4: 1,
  5: 2,
  6: 2,
  7: 3,
  8: 6,
};

function countStructuresAndSites(room: Room, type: BuildableStructureConstant): number {
  const built = room.find(FIND_MY_STRUCTURES, {
    filter: (s) => s.structureType === type,
  }).length;
  const sites = room.find(FIND_MY_CONSTRUCTION_SITES, {
    filter: (s) => s.structureType === type,
  }).length;
  return built + sites;
}

function findOpenPosition(
  room: Room,
  near: RoomPosition,
  minRange = 2,
  maxRange = 5,
): RoomPosition | undefined {
  const terrain = room.getTerrain();

  for (let range = minRange; range <= maxRange; range++) {
    for (let dx = -range; dx <= range; dx++) {
      for (let dy = -range; dy <= range; dy++) {
        if (Math.abs(dx) !== range && Math.abs(dy) !== range) continue; // only ring edges
        const x = near.x + dx;
        const y = near.y + dy;
        if (x < 2 || x > 47 || y < 2 || y > 47) continue;
        if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;

        const pos = new RoomPosition(x, y, room.name);
        const blocked =
          pos.lookFor(LOOK_STRUCTURES).length > 0 ||
          pos.lookFor(LOOK_CONSTRUCTION_SITES).length > 0;
        if (!blocked) return pos;
      }
    }
  }

  return undefined;
}

function placeExtensions(room: Room): void {
  const rcl = room.controller?.level ?? 0;
  const max = MAX_EXTENSIONS[rcl] ?? 0;
  const current = countStructuresAndSites(room, STRUCTURE_EXTENSION);
  if (current >= max) return;

  const spawns = room.find(FIND_MY_SPAWNS);
  const anchor = spawns[0];
  if (!anchor) return;

  const pos = findOpenPosition(room, anchor.pos);
  if (pos) {
    room.createConstructionSite(pos, STRUCTURE_EXTENSION);
  }
}

function placeTowers(room: Room): void {
  const rcl = room.controller?.level ?? 0;
  const max = MAX_TOWERS[rcl] ?? 0;
  const current = countStructuresAndSites(room, STRUCTURE_TOWER);
  if (current >= max) return;

  const spawns = room.find(FIND_MY_SPAWNS);
  const anchor = spawns[0];
  if (!anchor) return;

  const pos = findOpenPosition(room, anchor.pos, 3, 6);
  if (pos) {
    room.createConstructionSite(pos, STRUCTURE_TOWER);
  }
}

function placeRoads(room: Room): void {
  const rcl = room.controller?.level ?? 0;
  if (rcl < 2) return;

  // Limit road construction sites at a time
  const roadSites = room.find(FIND_MY_CONSTRUCTION_SITES, {
    filter: (s) => s.structureType === STRUCTURE_ROAD,
  });
  if (roadSites.length > 3) return;

  const spawns = room.find(FIND_MY_SPAWNS);
  const anchor = spawns[0];
  if (!anchor) return;

  const sources = room.find(FIND_SOURCES);
  const targets: RoomPosition[] = sources.map((s) => s.pos);
  if (room.controller) {
    targets.push(room.controller.pos);
  }

  for (const target of targets) {
    const path = room.findPath(anchor.pos, target, { ignoreCreeps: true });
    for (const step of path) {
      const structures = room.lookForAt(LOOK_STRUCTURES, step.x, step.y);
      const sites = room.lookForAt(LOOK_CONSTRUCTION_SITES, step.x, step.y);
      const hasRoad =
        structures.some((s) => s.structureType === STRUCTURE_ROAD) ||
        sites.some((s) => s.structureType === STRUCTURE_ROAD);
      if (!hasRoad) {
        room.createConstructionSite(step.x, step.y, STRUCTURE_ROAD);
        return; // one road site per tick to stay within CPU
      }
    }
  }
}

export function runConstruction(): void {
  for (const room of Object.values(Game.rooms)) {
    if (!room.controller?.my) continue;

    placeExtensions(room);
    placeTowers(room);
    placeRoads(room);
  }
}
