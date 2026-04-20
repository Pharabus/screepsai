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

function placeSourceContainers(room: Room): void {
  const rcl = room.controller?.level ?? 0;
  if (rcl < 2) return;

  const spawns = room.find(FIND_MY_SPAWNS);
  const anchor = spawns[0];
  if (!anchor) return;

  const sources = room.find(FIND_SOURCES);
  for (const source of sources) {
    // Check if a container (or site) already exists within 1 tile
    const nearbyContainers = source.pos.findInRange(FIND_STRUCTURES, 1, {
      filter: (s) => s.structureType === STRUCTURE_CONTAINER,
    });
    const nearbySites = source.pos.findInRange(FIND_MY_CONSTRUCTION_SITES, 1, {
      filter: (s) => s.structureType === STRUCTURE_CONTAINER,
    });
    if (nearbyContainers.length > 0 || nearbySites.length > 0) continue;

    // Place container on the first path step from source toward spawn
    // (so it's on the road and adjacent to the source)
    const path = room.findPath(source.pos, anchor.pos, { ignoreCreeps: true });
    const step = path[0];
    if (step) {
      room.createConstructionSite(step.x, step.y, STRUCTURE_CONTAINER);
      return; // one per tick
    }
  }
}

function placeControllerContainer(room: Room): void {
  const rcl = room.controller?.level ?? 0;
  if (rcl < 2) return;
  if (!room.controller) return;

  // Check if a container (or site) already exists within 3 tiles of controller
  const nearbyContainers = room.controller.pos.findInRange(FIND_STRUCTURES, 3, {
    filter: (s) => s.structureType === STRUCTURE_CONTAINER,
  });
  const nearbySites = room.controller.pos.findInRange(FIND_MY_CONSTRUCTION_SITES, 3, {
    filter: (s) => s.structureType === STRUCTURE_CONTAINER,
  });
  if (nearbyContainers.length > 0 || nearbySites.length > 0) return;

  // Place container on the path from controller toward spawn, within range 2
  const spawns = room.find(FIND_MY_SPAWNS);
  const anchor = spawns[0];
  if (!anchor) return;

  const path = room.findPath(room.controller.pos, anchor.pos, { ignoreCreeps: true });
  // Pick a tile that is within range 2 of the controller (so upgraders can
  // stand on it and still upgradeController which has range 3).
  for (const step of path) {
    const pos = new RoomPosition(step.x, step.y, room.name);
    if (pos.inRangeTo(room.controller, 2)) {
      room.createConstructionSite(step.x, step.y, STRUCTURE_CONTAINER);
      return;
    }
  }
}

function placeStorage(room: Room): void {
  const rcl = room.controller?.level ?? 0;
  if (rcl < 4) return;

  // Only one storage per room allowed by the game
  if (room.storage) return;
  const sites = room.find(FIND_MY_CONSTRUCTION_SITES, {
    filter: (s) => s.structureType === STRUCTURE_STORAGE,
  });
  if (sites.length > 0) return;

  const spawns = room.find(FIND_MY_SPAWNS);
  const anchor = spawns[0];
  if (!anchor) return;

  const pos = findOpenPosition(room, anchor.pos, 2, 4);
  if (pos) {
    room.createConstructionSite(pos, STRUCTURE_STORAGE);
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
    placeSourceContainers(room);
    placeControllerContainer(room);
    placeStorage(room);
    placeRoads(room);
  }
}
