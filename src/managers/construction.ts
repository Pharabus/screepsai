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

const MAX_LINKS: Record<number, number> = {
  5: 2,
  6: 3,
  7: 4,
  8: 6,
};

const MAX_LABS: Record<number, number> = {
  6: 3,
  7: 6,
  8: 10,
};

// Lab stamp: [dx, dy] offsets from anchor (storage).
// Positions 0-1 are designated input labs; 2-9 are output labs.
// All output positions are within Chebyshev range 2 of both input positions.
const LAB_STAMP: [number, number][] = [
  [0, 0], // input 1
  [1, 1], // input 2
  [0, 1], // output (RCL 6: 3 labs)
  [1, 0], // output (RCL 7: +3)
  [2, 1],
  [1, 2],
  [2, 0], // output (RCL 8: +4)
  [0, 2],
  [2, 2],
  [-1, 1],
];

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

// Compact extension stamp: [dx, dy] offsets from spawn, ordered by distance.
// Leaves a cross-shaped road corridor (dx=0 and dy=0 rows) through the center.
// Layout fills four quadrants in a checkerboard, closest positions first.
const EXTENSION_STAMP: [number, number][] = [
  // Quadrant fills, ring 1 (distance ~2): RCL 2 (5 extensions)
  [-1, -2],
  [1, -2],
  [-2, -1],
  [2, -1],
  [-2, 1],
  // Ring 2 (distance ~2-3): RCL 3 (10 total)
  [2, 1],
  [-1, 2],
  [1, 2],
  [-2, -2],
  [2, -2],
  // Ring 3 (distance ~3): RCL 4 (20 total)
  [-2, 2],
  [2, 2],
  [-1, -3],
  [1, -3],
  [-3, -1],
  [3, -1],
  [-3, 1],
  [3, 1],
  [-1, 3],
  [1, 3],
  // Ring 4 (distance ~3-4): RCL 5 (30 total)
  [-3, -2],
  [3, -2],
  [-3, 2],
  [3, 2],
  [-2, -3],
  [2, -3],
  [-2, 3],
  [2, 3],
  [-3, -3],
  [3, -3],
  // Ring 5 (distance ~4): RCL 6 (40 total)
  [-3, 3],
  [3, 3],
  [-1, -4],
  [1, -4],
  [-4, -1],
  [4, -1],
  [-4, 1],
  [4, 1],
  [-1, 4],
  [1, 4],
  // Ring 6 (distance ~4-5): RCL 7 (50 total)
  [-4, -2],
  [4, -2],
  [-4, 2],
  [4, 2],
  [-2, -4],
  [2, -4],
  [-2, 4],
  [2, 4],
  [-4, -3],
  [4, -3],
  // Ring 7 (distance ~5): RCL 8 (60 total)
  [-4, 3],
  [4, 3],
  [-3, -4],
  [3, -4],
  [-3, 4],
  [3, 4],
  [-4, -4],
  [4, -4],
  [-4, 4],
  [4, 4],
];

export function placeExtensions(room: Room): void {
  const rcl = room.controller?.level ?? 0;
  const max = MAX_EXTENSIONS[rcl] ?? 0;
  const current = countStructuresAndSites(room, STRUCTURE_EXTENSION);
  if (current >= max) return;

  const spawns = room.find(FIND_MY_SPAWNS);
  const anchor = spawns[0];
  if (!anchor) return;

  const terrain = room.getTerrain();
  for (const [dx, dy] of EXTENSION_STAMP) {
    const x = anchor.pos.x + dx;
    const y = anchor.pos.y + dy;
    if (x < 2 || x > 47 || y < 2 || y > 47) continue;
    if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;

    const pos = new RoomPosition(x, y, room.name);
    const blocked =
      pos.lookFor(LOOK_STRUCTURES).length > 0 || pos.lookFor(LOOK_CONSTRUCTION_SITES).length > 0;
    if (blocked) continue;

    room.createConstructionSite(pos, STRUCTURE_EXTENSION);
    return;
  }

  // Fallback if all stamp positions are terrain-blocked
  const pos = findOpenPosition(room, anchor.pos);
  if (pos) {
    room.createConstructionSite(pos, STRUCTURE_EXTENSION);
  }
}

export function placeTowers(room: Room): void {
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

export function placeSourceContainers(room: Room): void {
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

export function placeControllerContainer(room: Room): void {
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

export function placeStorage(room: Room): void {
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

export function placeRoads(room: Room): void {
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
  if (room.storage) {
    targets.push(room.storage.pos);
  }

  for (const target of targets) {
    const path = room.findPath(anchor.pos, target, { ignoreCreeps: true, range: 1 });
    if (path.length === 0) continue;
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

function hasUnbuiltLinkSites(room: Room): boolean {
  return (
    room.find(FIND_MY_CONSTRUCTION_SITES, {
      filter: (s) => s.structureType === STRUCTURE_LINK,
    }).length > 0
  );
}

export function placeTerminal(room: Room): void {
  const rcl = room.controller?.level ?? 0;
  if (rcl < 6) return;
  if (hasUnbuiltLinkSites(room)) return;
  if (room.terminal) return;

  const sites = room.find(FIND_MY_CONSTRUCTION_SITES, {
    filter: (s) => s.structureType === STRUCTURE_TERMINAL,
  });
  if (sites.length > 0) return;
  if (!room.storage) return;

  const pos = findOpenPosition(room, room.storage.pos, 1, 3);
  if (pos) {
    room.createConstructionSite(pos, STRUCTURE_TERMINAL);
  }
}

export function placeExtractor(room: Room): void {
  const rcl = room.controller?.level ?? 0;
  if (rcl < 6) return;
  if (hasUnbuiltLinkSites(room)) return;

  const minerals = room.find(FIND_MINERALS);
  const mineral = minerals[0];
  if (!mineral) return;

  const hasExtractor = mineral.pos
    .lookFor(LOOK_STRUCTURES)
    .some((s) => s.structureType === STRUCTURE_EXTRACTOR);
  const hasSite = mineral.pos
    .lookFor(LOOK_CONSTRUCTION_SITES)
    .some((s) => s.structureType === STRUCTURE_EXTRACTOR);
  if (hasExtractor || hasSite) return;

  room.createConstructionSite(mineral.pos, STRUCTURE_EXTRACTOR);
}

export function placeMineralContainer(room: Room): void {
  const rcl = room.controller?.level ?? 0;
  if (rcl < 6) return;
  if (hasUnbuiltLinkSites(room)) return;

  const minerals = room.find(FIND_MINERALS);
  const mineral = minerals[0];
  if (!mineral) return;

  // Only place after extractor exists (or is being built)
  const hasExtractor =
    mineral.pos.lookFor(LOOK_STRUCTURES).some((s) => s.structureType === STRUCTURE_EXTRACTOR) ||
    mineral.pos
      .lookFor(LOOK_CONSTRUCTION_SITES)
      .some((s) => s.structureType === STRUCTURE_EXTRACTOR);
  if (!hasExtractor) return;

  const nearbyContainers = mineral.pos.findInRange(FIND_STRUCTURES, 1, {
    filter: (s) => s.structureType === STRUCTURE_CONTAINER,
  });
  const nearbySites = mineral.pos.findInRange(FIND_MY_CONSTRUCTION_SITES, 1, {
    filter: (s) => s.structureType === STRUCTURE_CONTAINER,
  });
  if (nearbyContainers.length > 0 || nearbySites.length > 0) return;

  const spawns = room.find(FIND_MY_SPAWNS);
  const anchor = spawns[0];
  if (!anchor) return;

  const path = room.findPath(mineral.pos, anchor.pos, { ignoreCreeps: true });
  const step = path[0];
  if (step) {
    room.createConstructionSite(step.x, step.y, STRUCTURE_CONTAINER);
  }
}

export function placeLinks(room: Room): void {
  const rcl = room.controller?.level ?? 0;
  const max = MAX_LINKS[rcl] ?? 0;
  if (max === 0) return;
  const current = countStructuresAndSites(room, STRUCTURE_LINK);
  if (current >= max) return;

  const mem = Memory.rooms[room.name];

  // Priority 1: storage link (receiver — must exist before source links are useful)
  if (room.storage && !mem?.storageLinkId) {
    const existing = room.storage.pos.findInRange(FIND_MY_STRUCTURES, 2, {
      filter: (s) => s.structureType === STRUCTURE_LINK,
    });
    const existingSites = room.storage.pos.findInRange(FIND_MY_CONSTRUCTION_SITES, 2, {
      filter: (s) => s.structureType === STRUCTURE_LINK,
    });
    if (existing.length === 0 && existingSites.length === 0) {
      const pos = findOpenPosition(room, room.storage.pos, 1, 2);
      if (pos) {
        room.createConstructionSite(pos, STRUCTURE_LINK);
        return;
      }
    }
  }

  // Priority 2: source link for the most distant source (sender)
  if (mem?.sources) {
    const spawns = room.find(FIND_MY_SPAWNS);
    const anchor = spawns[0];
    if (anchor) {
      const unlinked = mem.sources
        .filter((s) => s.containerId && !s.linkId)
        .map((s) => ({ entry: s, source: Game.getObjectById(s.id) }))
        .filter((x) => !!x.source)
        .sort((a, b) => b.source!.pos.getRangeTo(anchor) - a.source!.pos.getRangeTo(anchor));

      for (const { entry } of unlinked) {
        const source = Game.getObjectById(entry.id);
        if (!source) continue;
        const nearbyLinks = source.pos.findInRange(FIND_MY_STRUCTURES, 2, {
          filter: (s) => s.structureType === STRUCTURE_LINK,
        });
        const nearbySites = source.pos.findInRange(FIND_MY_CONSTRUCTION_SITES, 2, {
          filter: (s) => s.structureType === STRUCTURE_LINK,
        });
        if (nearbyLinks.length > 0 || nearbySites.length > 0) continue;

        // Place within range 1 of the container (miner position) so the miner
        // can transfer energy directly. Fall back to range 2 of source if no
        // container exists yet.
        const container = entry.containerId
          ? Game.getObjectById(entry.containerId as Id<StructureContainer>)
          : undefined;
        const anchor = container?.pos ?? source.pos;
        const pos = findOpenPosition(room, anchor, 1, container ? 1 : 2);
        if (pos) {
          room.createConstructionSite(pos, STRUCTURE_LINK);
          return;
        }
      }
    }
  }

  // Priority 3: controller link at RCL 6+ (receiver for upgraders)
  if (rcl >= 6 && room.controller && !mem?.controllerLinkId) {
    const existing = room.controller.pos.findInRange(FIND_MY_STRUCTURES, 3, {
      filter: (s) => s.structureType === STRUCTURE_LINK,
    });
    const existingSites = room.controller.pos.findInRange(FIND_MY_CONSTRUCTION_SITES, 3, {
      filter: (s) => s.structureType === STRUCTURE_LINK,
    });
    if (existing.length === 0 && existingSites.length === 0) {
      const pos = findOpenPosition(room, room.controller.pos, 2, 3);
      if (pos) {
        room.createConstructionSite(pos, STRUCTURE_LINK);
        return;
      }
    }
  }
}

export function placeLabs(room: Room): void {
  const rcl = room.controller?.level ?? 0;
  const max = MAX_LABS[rcl] ?? 0;
  if (max === 0) return;
  if (hasUnbuiltLinkSites(room)) return;
  const current = countStructuresAndSites(room, STRUCTURE_LAB);
  if (current >= max) return;
  if (!room.storage) return;

  const terrain = room.getTerrain();
  const anchor = room.storage.pos;

  // Offset the stamp so labs sit adjacent to storage rather than on top of it
  const ox = anchor.x + 2;
  const oy = anchor.y + 2;

  for (const [dx, dy] of LAB_STAMP) {
    const x = ox + dx;
    const y = oy + dy;
    if (x < 2 || x > 47 || y < 2 || y > 47) continue;
    if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;

    const pos = new RoomPosition(x, y, room.name);
    const blocked =
      pos.lookFor(LOOK_STRUCTURES).length > 0 || pos.lookFor(LOOK_CONSTRUCTION_SITES).length > 0;
    if (blocked) continue;

    room.createConstructionSite(pos, STRUCTURE_LAB);
    return;
  }
}

export function placeCorridorRoads(room: Room): void {
  const rcl = room.controller?.level ?? 0;
  if (rcl < 3) return;

  const roadSites = room.find(FIND_MY_CONSTRUCTION_SITES, {
    filter: (s) => s.structureType === STRUCTURE_ROAD,
  });
  if (roadSites.length > 3) return;

  const spawns = room.find(FIND_MY_SPAWNS);
  const anchor = spawns[0];
  if (!anchor) return;

  const terrain = room.getTerrain();
  const maxRing = Math.min(rcl - 1, 4);

  for (let offset = -maxRing; offset <= maxRing; offset++) {
    if (offset === 0) continue;
    for (const [x, y] of [
      [anchor.pos.x, anchor.pos.y + offset],
      [anchor.pos.x + offset, anchor.pos.y],
    ] as [number, number][]) {
      if (x < 2 || x > 47 || y < 2 || y > 47) continue;
      if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;

      const structs = room.lookForAt(LOOK_STRUCTURES, x, y);
      const sites = room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y);
      const hasRoad =
        structs.some((s) => s.structureType === STRUCTURE_ROAD) ||
        sites.some((s) => s.structureType === STRUCTURE_ROAD);
      if (hasRoad) continue;

      const blocked = structs.some(
        (s) =>
          s.structureType !== STRUCTURE_CONTAINER &&
          s.structureType !== STRUCTURE_RAMPART &&
          s.structureType !== STRUCTURE_ROAD,
      );
      if (blocked) continue;

      room.createConstructionSite(x, y, STRUCTURE_ROAD);
      return;
    }
  }
}

export function placeRamparts(room: Room): void {
  const rcl = room.controller?.level ?? 0;
  if (rcl < 3) return;

  const critical: Structure[] = [
    ...room.find(FIND_MY_SPAWNS),
    ...room.find(FIND_MY_STRUCTURES, {
      filter: (s) => s.structureType === STRUCTURE_TOWER,
    }),
  ];
  if (room.storage) critical.push(room.storage);

  for (const structure of critical) {
    const hasRampart = structure.pos
      .lookFor(LOOK_STRUCTURES)
      .some((s) => s.structureType === STRUCTURE_RAMPART);
    const hasSite = structure.pos
      .lookFor(LOOK_CONSTRUCTION_SITES)
      .some((s) => s.structureType === STRUCTURE_RAMPART);
    if (hasRampart || hasSite) continue;

    room.createConstructionSite(structure.pos, STRUCTURE_RAMPART);
    return;
  }
}

export function placeRemoteRoads(room: Room): void {
  const rcl = room.controller?.level ?? 0;
  if (rcl < 4) return;

  const mem = Memory.rooms[room.name];
  const remoteRooms = mem?.remoteRooms;
  if (!remoteRooms || remoteRooms.length === 0) return;

  const spawns = room.find(FIND_MY_SPAWNS);
  const anchor = spawns[0];
  if (!anchor) return;

  // Only build roads to rooms with an active reserver
  for (const remoteRoomName of remoteRooms) {
    const remoteMem = Memory.rooms[remoteRoomName];
    if (!remoteMem?.scoutedHasController) continue;
    const hasReserver = Object.values(Game.creeps).some(
      (c) => c.memory.role === 'reserver' && c.memory.targetRoom === remoteRoomName,
    );
    if (!hasReserver) continue;

    const sources = remoteMem.sources ?? remoteMem.scoutedSourceData;
    if (!sources) continue;

    for (const source of sources) {
      const targetPos = new RoomPosition(source.x, source.y, remoteRoomName);
      const result = PathFinder.search(
        anchor.pos,
        { pos: targetPos, range: 1 },
        {
          plainCost: 2,
          swampCost: 10,
          roomCallback(roomName) {
            const r = Game.rooms[roomName];
            if (!r) return false;
            const costs = new PathFinder.CostMatrix();
            for (const struct of r.find(FIND_STRUCTURES)) {
              if (struct.structureType === STRUCTURE_ROAD) {
                costs.set(struct.pos.x, struct.pos.y, 1);
              } else if (
                struct.structureType !== STRUCTURE_CONTAINER &&
                struct.structureType !== STRUCTURE_RAMPART
              ) {
                costs.set(struct.pos.x, struct.pos.y, 255);
              }
            }
            return costs;
          },
        },
      );
      if (result.incomplete) continue;

      for (const step of result.path) {
        const stepRoom = Game.rooms[step.roomName];
        if (!stepRoom) continue;
        const structures = stepRoom.lookForAt(LOOK_STRUCTURES, step.x, step.y);
        const sites = stepRoom.lookForAt(LOOK_CONSTRUCTION_SITES, step.x, step.y);
        const hasRoad =
          structures.some((s) => s.structureType === STRUCTURE_ROAD) ||
          sites.some((s) => s.structureType === STRUCTURE_ROAD);
        if (!hasRoad) {
          stepRoom.createConstructionSite(step.x, step.y, STRUCTURE_ROAD);
          return;
        }
      }
    }
  }
}

export function runConstruction(): void {
  if (Game.time % 5 !== 0) return;

  for (const room of Object.values(Game.rooms)) {
    if (!room.controller?.my) continue;

    placeSourceContainers(room);
    placeControllerContainer(room);
    placeStorage(room);
    placeLinks(room);
    placeExtensions(room);
    placeTowers(room);
    placeRoads(room);
    placeCorridorRoads(room);
    placeRemoteRoads(room);
    placeTerminal(room);
    placeExtractor(room);
    placeMineralContainer(room);
    placeLabs(room);
    placeRamparts(room);
  }
}
