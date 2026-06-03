import { EXTENSION_STAMP, LAB_STAMP, findBestSpawnPosition } from '../utils/layoutPlanner';
import {
  applyTunnelWalls,
  getBaseCostMatrixForRoom,
  TUNNEL_WALL_COST,
} from '../utils/trafficManager';
import { myStorage } from '../utils/ownership';

// Max extensions per RCL level (from Screeps CONTROLLER_STRUCTURES).
// At RCL 7 each extension holds 100 energy (up from 50), at RCL 8 it's 200,
// so spawning capacity rises sharply even though the slot count grows slowly.
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

export const MAX_LABS: Record<number, number> = {
  6: 3,
  7: 9,
  8: 10,
};

const MAX_SPAWNS: Record<number, number> = {
  1: 1,
  2: 1,
  3: 1,
  4: 1,
  5: 1,
  6: 1,
  7: 2,
  8: 3,
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
  excluded?: Set<string>,
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
        if (excluded?.has(`${x},${y}`)) continue; // skip layout-plan-reserved tiles

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

/**
 * Returns the set of "x,y" tile keys that the room's layout plan has reserved for
 * permanent structures (towers, labs, extensions, storage, terminal). Road-placement
 * functions use this to route paths around reserved tiles and skip stray steps.
 */
export function getPlannedReserved(room: Room): Set<string> {
  const mem = Memory.rooms[room.name];
  const plan = mem?.layoutPlan;
  const set = new Set<string>();
  // Plan fields can be cleared by manual operator console mutation as an emergency
  // stop pattern — never throw on missing fields, always degrade gracefully to no-op.
  if (
    !plan?.storagePos ||
    !plan.terminalPos ||
    !Array.isArray(plan.towerPositions) ||
    !Array.isArray(plan.labPositions) ||
    !Array.isArray(plan.extensionPositions)
  )
    return set;
  set.add(`${plan.storagePos.x},${plan.storagePos.y}`);
  set.add(`${plan.terminalPos.x},${plan.terminalPos.y}`);
  if (plan.factoryPos) set.add(`${plan.factoryPos.x},${plan.factoryPos.y}`);
  for (const p of plan.towerPositions as ({ x: number; y: number } | undefined)[])
    if (p) set.add(`${p.x},${p.y}`);
  for (const p of plan.labPositions as ({ x: number; y: number } | undefined)[])
    if (p) set.add(`${p.x},${p.y}`);
  for (const p of plan.extensionPositions as ({ x: number; y: number } | undefined)[])
    if (p) set.add(`${p.x},${p.y}`);
  for (const p of (plan.spawnPositions ?? []) as ({ x: number; y: number } | undefined)[])
    if (p) set.add(`${p.x},${p.y}`);

  // Non-gate perimeter tiles will have walls placed on them — treat them as
  // reserved so road pathfinding naturally threads through the gate tiles instead.
  const perimPlan = mem?.perimeterPlan;
  if (perimPlan) {
    const gateSet = new Set(perimPlan.gateTiles);
    for (const key of perimPlan.perimeterTiles) {
      if (!gateSet.has(key)) set.add(key);
    }
  }

  return set;
}

export function placeExtensions(room: Room): void {
  const rcl = room.controller?.level ?? 0;
  const max = MAX_EXTENSIONS[rcl] ?? 0;
  const current = countStructuresAndSites(room, STRUCTURE_EXTENSION);
  if (current >= max) return;

  const mem = Memory.rooms[room.name];
  const plan = mem?.layoutPlan;

  if (plan) {
    for (const { x, y } of plan.extensionPositions) {
      const pos = new RoomPosition(x, y, room.name);
      const blocked =
        pos.lookFor(LOOK_STRUCTURES).length > 0 || pos.lookFor(LOOK_CONSTRUCTION_SITES).length > 0;
      if (!blocked) {
        room.createConstructionSite(pos, STRUCTURE_EXTENSION);
        return;
      }
    }
    // Plan exhausted (all positions built or road-blocked) — fall through to overflow search.
  }

  // Overflow / fallback: stamp relative to spawn, then any open position.
  // Handles both pre-plan rooms and cases where roads consumed plan slots.
  const spawn = room.find(FIND_MY_SPAWNS)[0];
  if (!spawn) return;
  const terrain = room.getTerrain();
  for (const [dx, dy] of EXTENSION_STAMP) {
    const x = spawn.pos.x + dx;
    const y = spawn.pos.y + dy;
    if (x < 2 || x > 47 || y < 2 || y > 47) continue;
    if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
    const pos = new RoomPosition(x, y, room.name);
    const blocked =
      pos.lookFor(LOOK_STRUCTURES).length > 0 || pos.lookFor(LOOK_CONSTRUCTION_SITES).length > 0;
    if (blocked) continue;
    room.createConstructionSite(pos, STRUCTURE_EXTENSION);
    return;
  }
  const pos = findOpenPosition(room, spawn.pos);
  if (pos) room.createConstructionSite(pos, STRUCTURE_EXTENSION);
}

export function placeTowers(room: Room): void {
  const rcl = room.controller?.level ?? 0;
  const max = MAX_TOWERS[rcl] ?? 0;
  const current = countStructuresAndSites(room, STRUCTURE_TOWER);
  if (current >= max) return;

  const mem = Memory.rooms[room.name];
  const plan = mem?.layoutPlan;

  if (plan) {
    for (const { x, y } of plan.towerPositions) {
      const pos = new RoomPosition(x, y, room.name);
      const blocked =
        pos.lookFor(LOOK_STRUCTURES).length > 0 || pos.lookFor(LOOK_CONSTRUCTION_SITES).length > 0;
      if (!blocked) {
        room.createConstructionSite(pos, STRUCTURE_TOWER);
        return;
      }
    }
    // All planned positions are blocked — fall through to overflow search.
  }

  // Overflow / fallback: first open position near spawn.
  // Handles both pre-plan rooms and cases where a planned slot is occupied by
  // a previously-built extension or other structure.
  const spawn = room.find(FIND_MY_SPAWNS)[0];
  if (!spawn) return;
  const pos = findOpenPosition(room, spawn.pos, 3, 6);
  if (pos) {
    const key = `${pos.x},${pos.y}`;
    const roomMem = (Memory.rooms[room.name] ??= {});
    if (!roomMem.overflowedTowers?.includes(key)) {
      console.log(
        `[construction] ${room.name}: all planned tower slots blocked, placing overflow tower at (${pos.x},${pos.y})`,
      );
      (roomMem.overflowedTowers ??= []).push(key);
    }
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
  // Only skip when OUR storage already exists. A foreign storage (previous owner's
  // structure in a reclaimed room) occupies the single storage slot — haulers drain
  // it first; cleanupClaimedRoom destroys the empty husk; then we place ours.
  if (myStorage(room)) return;

  const sites = room.find(FIND_MY_CONSTRUCTION_SITES, {
    filter: (s) => s.structureType === STRUCTURE_STORAGE,
  });
  if (sites.length > 0) return;

  const mem = Memory.rooms[room.name];
  const plan = mem?.layoutPlan;

  if (plan) {
    const { x, y } = plan.storagePos;
    const pos = new RoomPosition(x, y, room.name);
    const blocked =
      pos.lookFor(LOOK_STRUCTURES).length > 0 || pos.lookFor(LOOK_CONSTRUCTION_SITES).length > 0;
    if (!blocked) room.createConstructionSite(pos, STRUCTURE_STORAGE);
    return;
  }

  // Fallback
  const spawn = room.find(FIND_MY_SPAWNS)[0];
  if (!spawn) return;
  const pos = findOpenPosition(room, spawn.pos, 2, 4);
  if (pos) room.createConstructionSite(pos, STRUCTURE_STORAGE);
}

export function placeSecondSpawn(room: Room): void {
  const rcl = room.controller?.level ?? 0;
  if (rcl < 7) return;

  const maxSpawns = MAX_SPAWNS[rcl] ?? 1;
  const current = countStructuresAndSites(room, STRUCTURE_SPAWN);
  if (current >= maxSpawns) return;

  const plan = Memory.rooms[room.name]?.layoutPlan;
  if (!plan?.spawnPositions || plan.spawnPositions.length < 2) return;

  // Index 0 is the primary spawn; place sites for index 1+ only.
  for (let i = 1; i < plan.spawnPositions.length; i++) {
    const { x, y } = plan.spawnPositions[i]!;
    const blocked =
      room.lookForAt(LOOK_STRUCTURES, x, y).length > 0 ||
      room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y).length > 0;
    if (!blocked) {
      room.createConstructionSite(new RoomPosition(x, y, room.name), STRUCTURE_SPAWN);
      return; // one per tick
    }
  }
}

export function placeRoads(room: Room): void {
  const rcl = room.controller?.level ?? 0;
  if (rcl < 2) return;

  const mem = Memory.rooms[room.name];
  // Skip expensive pathfinding when all roads are confirmed complete.
  // Re-validate when roads may have decayed (run every 50 ticks even when complete).
  if (mem?.roadsComplete && Game.time % 50 !== 0) return;
  if (mem?.roadsComplete) {
    // Clear flag so a full re-check happens this tick
    delete mem.roadsComplete;
  }

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
  // Only road to OWN storage — a foreign storage will be drained and destroyed.
  const ownStorageForRoads = myStorage(room);
  if (ownStorageForRoads) {
    targets.push(ownStorageForRoads.pos);
  }

  const reserved = getPlannedReserved(room);

  for (const target of targets) {
    const path = room.findPath(anchor.pos, target, {
      ignoreCreeps: true,
      range: 1,
      costCallback(_roomName, costMatrix) {
        if (!reserved.size) return costMatrix;
        const matrix = costMatrix.clone();
        for (const key of reserved) {
          const comma = key.indexOf(',');
          matrix.set(Number(key.slice(0, comma)), Number(key.slice(comma + 1)), 255);
        }
        return matrix;
      },
    });
    if (path.length === 0) continue;
    for (const step of path) {
      if (reserved.has(`${step.x},${step.y}`)) continue; // belt-and-braces: skip reserved tiles
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

  // Reaching here means every path step has a road or site — mark complete
  (Memory.rooms[room.name] ??= {}).roadsComplete = true;
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
  // Gate on OWN storage so we don't anchor the terminal to a foreign storage's position.
  if (!myStorage(room)) return;

  const mem = Memory.rooms[room.name];
  const plan = mem?.layoutPlan;

  if (plan) {
    const { x, y } = plan.terminalPos;
    const pos = new RoomPosition(x, y, room.name);
    const blocked =
      pos.lookFor(LOOK_STRUCTURES).length > 0 || pos.lookFor(LOOK_CONSTRUCTION_SITES).length > 0;
    if (!blocked) room.createConstructionSite(pos, STRUCTURE_TERMINAL);
    return;
  }

  const pos = findOpenPosition(room, myStorage(room)!.pos, 1, 3);
  if (pos) room.createConstructionSite(pos, STRUCTURE_TERMINAL);
}

export function placeFactory(room: Room): void {
  const rcl = room.controller?.level ?? 0;
  if (rcl < 7) return;
  if (hasUnbuiltLinkSites(room)) return;

  const existing = room.find(FIND_MY_STRUCTURES, {
    filter: (s) => s.structureType === STRUCTURE_FACTORY,
  });
  const sites = room.find(FIND_MY_CONSTRUCTION_SITES, {
    filter: (s) => s.structureType === STRUCTURE_FACTORY,
  });
  if (existing.length > 0 || sites.length > 0) return;

  const mem = Memory.rooms[room.name];
  const plan = mem?.layoutPlan;

  if (plan?.factoryPos) {
    const { x, y } = plan.factoryPos;
    const pos = new RoomPosition(x, y, room.name);
    const blocked =
      pos.lookFor(LOOK_STRUCTURES).length > 0 || pos.lookFor(LOOK_CONSTRUCTION_SITES).length > 0;
    if (!blocked) room.createConstructionSite(pos, STRUCTURE_FACTORY);
    return;
  }

  // Anchor to OWN storage position — a foreign storage in a reclaimed room must
  // not be used as an anchor (it may be on the wrong tile for our layout plan).
  const ownStorageForFactory = myStorage(room);
  if (!ownStorageForFactory) return;
  const pos = findOpenPosition(room, ownStorageForFactory.pos, 1, 3);
  if (pos) room.createConstructionSite(pos, STRUCTURE_FACTORY);
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

// Structure types that do not block walking — a tile holding only these still
// counts as a passable neighbour of storage (and a road may be cleared to free it).
const LINK_WALKABLE_TYPES: Set<StructureConstant> = new Set([
  STRUCTURE_ROAD,
  STRUCTURE_RAMPART,
  STRUCTURE_CONTAINER,
]);

/**
 * Last-resort storage-link placement for a built-out room. The normal storage-link
 * path searches only range 2–3 of storage (a range-1 link could seal storage's last
 * passable neighbour); once the extension diamond is complete every range 2–3 tile is
 * occupied and `findOpenPosition` returns nothing, so a lost storage link can never be
 * replaced. This places the link on a range-1 tile instead — but only one that leaves
 * storage with at least one OTHER passable neighbour — clearing a road on the chosen
 * tile first. Fires at most once (the next tick the link site is found by the range-3
 * existing-site guard). Returns true if a site was placed.
 */
function placeStorageLinkAdjacentFallback(
  room: Room,
  storagePos: RoomPosition,
  reserved: Set<string>,
): boolean {
  const terrain = room.getTerrain();
  const isPassable = (x: number, y: number): boolean => {
    if ((terrain.get(x, y) & TERRAIN_MASK_WALL) !== 0) return false;
    return room
      .lookForAt(LOOK_STRUCTURES, x, y)
      .every((s) => LINK_WALKABLE_TYPES.has(s.structureType));
  };

  const neighbours: { x: number; y: number; passable: boolean }[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      const x = storagePos.x + dx;
      const y = storagePos.y + dy;
      if (x < 2 || x > 47 || y < 2 || y > 47) continue;
      neighbours.push({ x, y, passable: isPassable(x, y) });
    }
  }
  const passableCount = neighbours.filter((n) => n.passable).length;
  // Occupying any passable neighbour leaves passableCount-1; require ≥1 remains so a
  // hauler can still reach storage. (If only one passable tile exists, never take it.)
  if (passableCount < 2) return false;

  const candidates = neighbours.filter((n) => {
    if (!n.passable) return false;
    if (reserved.has(`${n.x},${n.y}`)) return false;
    const structs = room.lookForAt(LOOK_STRUCTURES, n.x, n.y);
    if (structs.some((s) => s.structureType !== STRUCTURE_ROAD)) return false; // road-only or empty
    if (room.lookForAt(LOOK_CONSTRUCTION_SITES, n.x, n.y).length > 0) return false;
    return true;
  });
  if (candidates.length === 0) return false;

  // Extension-serviceability guard: never take a tile that is some adjacent
  // extension's LAST passable access — that would strand the extension (no creep
  // could ever stand beside it to fill it). Keep only tiles that strand none; if
  // every candidate would strand one (degenerate), fall back to the full set since
  // a storage link is worth more than one unreachable extension.
  const strandsExtension = (c: { x: number; y: number }): boolean => {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const ex = c.x + dx;
        const ey = c.y + dy;
        const isExt = room
          .lookForAt(LOOK_STRUCTURES, ex, ey)
          .some((s) => s.structureType === STRUCTURE_EXTENSION);
        if (!isExt) continue;
        let access = 0;
        for (let ax = -1; ax <= 1; ax++) {
          for (let ay = -1; ay <= 1; ay++) {
            if (ax === 0 && ay === 0) continue;
            const nx = ex + ax;
            const ny = ey + ay;
            if (nx === c.x && ny === c.y) continue; // the link tile is now blocked
            if (isPassable(nx, ny)) access++;
          }
        }
        if (access === 0) return true; // c is this extension's only remaining access
      }
    }
    return false;
  };
  const serviceable = candidates.filter((c) => !strandsExtension(c));
  const pool = serviceable.length > 0 ? serviceable : candidates;

  // Connectivity-aware pick. A range-1 link must extend the structure cluster, not
  // plug a corridor: blocking a stepping-stone road beside the storage/terminal/spawn
  // stack can force a ~40-tile detour from one side to the other (observed live in
  // W43N58 when 15,29 was chosen over the original 16,28). Score each candidate by the
  // worst local detour it creates between storage's OTHER passable neighbours — using a
  // BFS bounded to the storage's neighbourhood, with the candidate treated as blocked.
  // Infinity = it severs the local corridor. Lowest score wins; the "wall-extending"
  // tile scores ~0 because storage's remaining neighbours stay adjacent.
  const LOCAL_R = 5;
  const passableNbrs = neighbours.filter((n) => n.passable);
  const disruption = (c: { x: number; y: number }): number => {
    const others = passableNbrs.filter((n) => !(n.x === c.x && n.y === c.y));
    if (others.length <= 1) return 0;
    const start = others[0]!;
    const dist: Record<string, number> = { [`${start.x},${start.y}`]: 0 };
    const queue: [number, number][] = [[start.x, start.y]];
    let head = 0;
    while (head < queue.length) {
      const [x, y] = queue[head++]!;
      const d = dist[`${x},${y}`]!;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx === c.x && ny === c.y) continue; // candidate is blocked by the link
          if (Math.abs(nx - storagePos.x) > LOCAL_R || Math.abs(ny - storagePos.y) > LOCAL_R)
            continue;
          const k = `${nx},${ny}`;
          if (dist[k] !== undefined || !isPassable(nx, ny)) continue;
          dist[k] = d + 1;
          queue.push([nx, ny]);
        }
      }
    }
    let worst = 0;
    for (const o of others) {
      const d = dist[`${o.x},${o.y}`];
      if (d === undefined) return Number.POSITIVE_INFINITY; // severs the local corridor
      if (d > worst) worst = d;
    }
    return worst;
  };
  pool.sort((a, b) => {
    const da = disruption(a);
    const db = disruption(b);
    if (da !== db) return da - db;
    // Tie-break: prefer an already-empty tile (no road to clear), then x,y.
    const ra = room.lookForAt(LOOK_STRUCTURES, a.x, a.y).length;
    const rb = room.lookForAt(LOOK_STRUCTURES, b.x, b.y).length;
    return ra - rb || a.x - b.x || a.y - b.y;
  });
  const chosen = pool[0]!;
  const road = room
    .lookForAt(LOOK_STRUCTURES, chosen.x, chosen.y)
    .find((s) => s.structureType === STRUCTURE_ROAD);
  if (road) road.destroy(); // instant — the tile is free for the link site this tick
  return room.createConstructionSite(chosen.x, chosen.y, STRUCTURE_LINK) === OK;
}

export function placeLinks(room: Room): void {
  const rcl = room.controller?.level ?? 0;
  const max = MAX_LINKS[rcl] ?? 0;
  if (max === 0) return;
  const current = countStructuresAndSites(room, STRUCTURE_LINK);
  if (current >= max) return;

  const mem = Memory.rooms[room.name];

  // Compute once — spawn/extension/tower/lab/storage/terminal/perimeter tiles that
  // are layout-plan-reserved. Links must not land on these (a storage link at the
  // planned spawn-2 position would block the spawn from ever being built).
  const reserved = getPlannedReserved(room);

  // Priority 1: storage link (receiver — must exist before source links are useful)
  // Use range 2–3 (not range 1) so the link is never placed on the only passable
  // tile adjacent to storage. If all 7 other neighbours are taken by extensions/towers,
  // a range-1 link at the last gap would permanently seal storage once built.
  //
  // Crucially, do NOT exclude extensionPositions here. The extension diamond fills
  // every range-2 tile near storage, so using the full `reserved` set causes
  // findOpenPosition to return undefined and source links fill both RCL-5 link
  // slots instead. The extension planner pre-generates 70 positions for 60 needed
  // at RCL 8 — one tile occupied by the storage link costs at most 1 extension slot.
  //
  // Use myStorage (ownership-aware): anchor the storage link only to OUR storage,
  // not to a previous owner's foreign storage in a reclaimed room.
  const ownStorage = myStorage(room);
  if (ownStorage && !mem?.storageLinkId) {
    const existing = ownStorage.pos.findInRange(FIND_MY_STRUCTURES, 3, {
      filter: (s) => s.structureType === STRUCTURE_LINK,
    });
    const existingSites = ownStorage.pos.findInRange(FIND_MY_CONSTRUCTION_SITES, 3, {
      filter: (s) => s.structureType === STRUCTURE_LINK,
    });
    if (existing.length === 0 && existingSites.length === 0) {
      // Narrow excluded set: only structures that genuinely conflict with a link
      // (storage itself, terminal, factory, towers, spawns). Extensions are omitted —
      // the planner has spare slots and the link must be placeable near storage.
      const storageReserved = new Set<string>();
      const plan = mem?.layoutPlan;
      if (plan?.storagePos) storageReserved.add(`${plan.storagePos.x},${plan.storagePos.y}`);
      if (plan?.terminalPos) storageReserved.add(`${plan.terminalPos.x},${plan.terminalPos.y}`);
      if (plan?.factoryPos) storageReserved.add(`${plan.factoryPos.x},${plan.factoryPos.y}`);
      for (const p of plan?.towerPositions ?? []) if (p) storageReserved.add(`${p.x},${p.y}`);
      for (const p of plan?.spawnPositions ?? []) if (p) storageReserved.add(`${p.x},${p.y}`);
      const pos = findOpenPosition(room, ownStorage.pos, 2, 3, storageReserved);
      if (pos) {
        room.createConstructionSite(pos, STRUCTURE_LINK);
        return;
      }
      // Range 2–3 fully built out (mature room) — findOpenPosition found nothing.
      // Fall back to a range-1 tile that doesn't seal storage, clearing a road
      // blocker if needed. Recovers a lost storage link once the surrounding
      // extension diamond is complete (the original tile is usually re-paved and
      // every range 2–3 slot is taken, so no other path can replace it).
      if (placeStorageLinkAdjacentFallback(room, ownStorage.pos, storageReserved)) return;
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
        .sort(
          (a, b) =>
            (b.entry.pathDist ?? b.source!.pos.getRangeTo(anchor)) -
            (a.entry.pathDist ?? a.source!.pos.getRangeTo(anchor)),
        );

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
        const pos = findOpenPosition(room, anchor, 1, container ? 1 : 2, reserved);
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
      const pos = findOpenPosition(room, room.controller.pos, 2, 3, reserved);
      if (pos) {
        room.createConstructionSite(pos, STRUCTURE_LINK);
        return;
      }
    }
  }
}

/**
 * Remove extension construction sites that are not in the current layout plan.
 * This cleans up stale sites left over after a replan so builders don't complete
 * them and create inaccessible pockets that the new plan avoided.
 */
function clearStaleSites(room: Room): boolean {
  const plan = Memory.rooms[room.name]?.layoutPlan;
  if (!plan) return false;
  const planSet = new Set(plan.extensionPositions.map((p) => `${p.x},${p.y}`));
  const sites = room.find(FIND_MY_CONSTRUCTION_SITES, {
    filter: (s) => s.structureType === STRUCTURE_EXTENSION,
  });
  for (const site of sites) {
    if (!planSet.has(`${site.pos.x},${site.pos.y}`)) {
      console.log(
        `[construction] ${room.name}: removing stale extension site at (${site.pos.x},${site.pos.y}) — not in current plan`,
      );
      site.remove();
      return true;
    }
  }
  return false;
}

/**
 * Destroy one overflow extension (Chebyshev > 4 from spawn) that is blocking a
 * completely inaccessible extension (zero open cardinal neighbours). Called each
 * construction tick so it self-heals over several ticks when the layout planner
 * placed overflow extensions that created isolated pockets.
 */
export function clearBlockingExtensions(room: Room): void {
  // First pass: remove any extension construction sites the current plan doesn't want.
  if (clearStaleSites(room)) return;

  const spawn = room.find(FIND_MY_SPAWNS)[0];
  if (!spawn) return;

  const cardinals: [number, number][] = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ];

  const extensions = room.find(FIND_MY_STRUCTURES, {
    filter: (s) => s.structureType === STRUCTURE_EXTENSION,
  }) as StructureExtension[];

  for (const ext of extensions) {
    const openCardinals = cardinals.filter(([dx, dy]) => {
      const x = ext.pos.x + dx;
      const y = ext.pos.y + dy;
      if (x < 0 || x > 49 || y < 0 || y > 49) return false;
      const here = room.lookForAt(LOOK_STRUCTURES, x, y);
      return here.every(
        (s) =>
          s.structureType === STRUCTURE_ROAD ||
          s.structureType === STRUCTURE_RAMPART ||
          s.structureType === STRUCTURE_CONTAINER,
      );
    });
    if (openCardinals.length > 0) continue;

    // This extension is completely inaccessible. Find an adjacent overflow extension
    // (Chebyshev > 4 from spawn) and destroy it to open a path.
    for (const [dx, dy] of cardinals) {
      const x = ext.pos.x + dx;
      const y = ext.pos.y + dy;
      const blocker = room
        .lookForAt(LOOK_STRUCTURES, x, y)
        .find((s) => s.structureType === STRUCTURE_EXTENSION) as StructureExtension | undefined;
      if (!blocker) continue;
      const cheb = Math.max(
        Math.abs(blocker.pos.x - spawn.pos.x),
        Math.abs(blocker.pos.y - spawn.pos.y),
      );
      if (cheb > 4) {
        console.log(
          `[construction] ${room.name}: destroying overflow extension at (${blocker.pos.x},${blocker.pos.y}) — blocked (${ext.pos.x},${ext.pos.y}) with 0 open cardinals`,
        );
        blocker.destroy();
        return;
      }
    }
  }
}

export function clearLabBlockers(room: Room): void {
  const rcl = room.controller?.level ?? 0;
  if (rcl < 6) return;
  const plan = Memory.rooms[room.name]?.layoutPlan;
  if (!plan) return;
  for (const { x, y } of plan.labPositions) {
    const blocker = room
      .lookForAt(LOOK_STRUCTURES, x, y)
      .find((s) => s.structureType === STRUCTURE_EXTENSION);
    if (blocker) {
      blocker.destroy();
      return;
    }
    const site = room
      .lookForAt(LOOK_CONSTRUCTION_SITES, x, y)
      .find((s) => s.structureType === STRUCTURE_EXTENSION);
    if (site) {
      site.remove();
      return;
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
  // Gate on OWN storage — a foreign storage in a reclaimed room must not gate labs.
  const ownStorageForLabs = myStorage(room);
  if (!ownStorageForLabs) return;

  const mem = Memory.rooms[room.name];
  const plan = mem?.layoutPlan;

  if (plan) {
    const roomMem = (Memory.rooms[room.name] ??= {});
    const blockedLog = (roomMem.labStampBlockedLog ??= {});
    for (const { x, y } of plan.labPositions) {
      const pos = new RoomPosition(x, y, room.name);
      const structs = pos.lookFor(LOOK_STRUCTURES);
      const sites = pos.lookFor(LOOK_CONSTRUCTION_SITES);
      const blocked = structs.length > 0 || sites.length > 0;
      if (!blocked) {
        room.createConstructionSite(pos, STRUCTURE_LAB);
        return;
      }
      // Already-built labs are expected occupants — don't log them as blocked
      // (rampart construction sites may co-exist on the same tile).
      if (structs.some((s) => s.structureType === STRUCTURE_LAB)) continue;
      const key = `${x},${y}`;
      const lastLog = blockedLog[key];
      if (lastLog === undefined || Game.time - lastLog >= 100) {
        const here = [
          ...structs.map((s) => s.structureType),
          ...sites.map((s) => `${s.structureType}-site`),
        ];
        console.log(
          `[construction] ${room.name}: placeLabs blocked at (${x},${y}) — ${here.join('+') || '?'}`,
        );
        blockedLog[key] = Game.time;
      }
    }
    // Plan exhausted (every planned lab slot is built or blocked) but the room
    // still needs more labs than the plan could place — this happens when the
    // rigid LAB_STAMP collided with a spawn/extension/road at compute time and
    // produced fewer positions than MAX_LABS[rcl] (observed live in W44N57:
    // input-lab slot landed on the spawn, two output slots on extensions, so
    // the plan capped at 6/9). Fall through to an adjacency-aware overflow that
    // searches the full Chebyshev-range-2 region around the input labs rather
    // than the congested stamp box — so the extra labs are still reaction-valid.
    placeAdjacencyValidLab(room, plan);
    return;
  }

  // Fallback: stamp relative to own storage (pre-plan rooms only).
  const terrain = room.getTerrain();
  const ox = ownStorageForLabs.pos.x + 2;
  const oy = ownStorageForLabs.pos.y + 2;
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

/**
 * Resolve the two input-lab anchor positions for a room. Reaction adjacency
 * requires every output lab to be within Chebyshev range 2 of BOTH input labs,
 * so the overflow search anchors on these.
 *
 * Prefers the actual built input labs (the first two labs, matching the
 * `inputLabIds` designation in roomPlanner.ts) so we never drift away from the
 * cluster the reactions already run on. Falls back to the planned stamp inputs
 * (labPositions[0..1]) before any lab is built.
 */
function resolveLabInputAnchors(
  room: Room,
  plan: { labPositions: { x: number; y: number }[] },
): [{ x: number; y: number }, { x: number; y: number }] | undefined {
  const labs = room.find(FIND_MY_STRUCTURES, {
    filter: (s): s is StructureLab => s.structureType === STRUCTURE_LAB,
  });
  if (labs.length >= 2) {
    // First two labs are the designated inputs (stable; see roomPlanner.ts).
    const ids = Memory.rooms[room.name]?.inputLabIds;
    if (ids && ids.length >= 2) {
      const l1 = labs.find((l) => l.id === ids[0]);
      const l2 = labs.find((l) => l.id === ids[1]);
      if (l1 && l2)
        return [
          { x: l1.pos.x, y: l1.pos.y },
          { x: l2.pos.x, y: l2.pos.y },
        ];
    }
    const a = labs[0]!;
    const b = labs[1]!;
    return [
      { x: a.pos.x, y: a.pos.y },
      { x: b.pos.x, y: b.pos.y },
    ];
  }
  // No (or one) built lab yet — use the planned stamp inputs.
  const p0 = plan.labPositions[0];
  const p1 = plan.labPositions[1];
  if (p0 && p1)
    return [
      { x: p0.x, y: p0.y },
      { x: p1.x, y: p1.y },
    ];
  return undefined;
}

/**
 * Overflow lab placement that respects reaction adjacency. Searches all tiles
 * within Chebyshev range 2 of BOTH input labs (the only tiles a reaction-valid
 * output lab can occupy) and places one buildable, accessible lab per tick.
 *
 * Skips reserved/occupied tiles using the same live lookFor predicate as the
 * planned path, plus the layout-plan reserved set so we never steal an
 * extension/tower/road slot. One placement per tick; caller has already
 * verified current < MAX_LABS[rcl].
 */
function placeAdjacencyValidLab(
  room: Room,
  plan: { labPositions: { x: number; y: number }[] },
): void {
  const anchors = resolveLabInputAnchors(room, plan);
  if (!anchors) return;
  const [in1, in2] = anchors;

  const terrain = room.getTerrain();
  const reserved = getPlannedReserved(room);
  const cheb = (ax: number, ay: number, b: { x: number; y: number }): number =>
    Math.max(Math.abs(ax - b.x), Math.abs(ay - b.y));

  // Scan the bounding box of the range-2-of-both region. A tile must be within
  // range 2 of each input independently for the reaction to address it.
  const minX = Math.max(2, Math.min(in1.x, in2.x) - 2);
  const maxX = Math.min(47, Math.max(in1.x, in2.x) + 2);
  const minY = Math.max(2, Math.min(in1.y, in2.y) - 2);
  const maxY = Math.min(47, Math.max(in1.y, in2.y) + 2);

  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      if (cheb(x, y, in1) > 2 || cheb(x, y, in2) > 2) continue; // adjacency-invalid
      if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
      if (reserved.has(`${x},${y}`)) continue; // don't steal a planned non-lab slot
      const pos = new RoomPosition(x, y, room.name);
      const blocked =
        pos.lookFor(LOOK_STRUCTURES).length > 0 || pos.lookFor(LOOK_CONSTRUCTION_SITES).length > 0;
      if (blocked) continue;
      room.createConstructionSite(pos, STRUCTURE_LAB);
      return; // one per tick
    }
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
  const reserved = getPlannedReserved(room);

  for (let offset = -maxRing; offset <= maxRing; offset++) {
    if (offset === 0) continue;
    for (const [x, y] of [
      [anchor.pos.x, anchor.pos.y + offset],
      [anchor.pos.x + offset, anchor.pos.y],
    ] as [number, number][]) {
      if (x < 2 || x > 47 || y < 2 || y > 47) continue;
      if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
      if (reserved.has(`${x},${y}`)) continue; // skip planned structure tiles

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
    ...room.find(FIND_MY_STRUCTURES, {
      filter: (s) => s.structureType === STRUCTURE_LAB,
    }),
  ];
  // Only rampart OWN storage/terminal — foreign structures in a reclaimed room
  // will be destroyed once drained; ramparting them wastes construction resources.
  const ownStorageForRampart = myStorage(room);
  if (ownStorageForRampart) critical.push(ownStorageForRampart);
  if (room.terminal?.my) critical.push(room.terminal);
  if (room.controller) critical.push(room.controller);

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

// Minimum storage energy before perimeter construction sites are placed.
// Prevents the build cycle from pushing storage into starvation territory.
// Construction costs themselves are trivial (walls/ramparts cost 1 energy each
// to build); the real drain is tower repair, but pausing here avoids adding
// new repair backlog when already income-constrained.
const PERIMETER_STORAGE_MIN = 20_000;

/**
 * Place ramparts on perimeter gate tiles — RCL 5+.
 *
 * Strategy by RCL:
 *   RCL 5 (walls not yet placed): rampart on ALL perimeter tiles — transitional
 *     first ring of defence before walls exist. Non-gate ramparts will decay
 *     away once walls are placed at RCL 6+; towers won't repair them (see
 *     towers.ts wall-colocated guard).
 *   RCL 6+: this function only touches gate tiles. Non-gate tiles are the
 *     exclusive domain of placePerimeterWalls — no competition, no doubles.
 *
 * One site per call to stay within the global site cap.
 */
export function placePerimeterRamparts(room: Room): void {
  const rcl = room.controller?.level ?? 0;
  if (rcl < 5) return;

  const mem = Memory.rooms[room.name];
  const perimPlan = mem?.perimeterPlan;
  if (!perimPlan) return;

  const gateSet = new Set(perimPlan.gateTiles);

  // Reconciliation pass — FREE and energy-INDEPENDENT (runs before the energy gate).
  // A tile that was a WALL under an older plan but is now a gate still carries its
  // constructedWall, and a rampart can't sit on a wall tile, so the gate would never
  // open and egress toward that target stays sealed. Destroy the stale wall first;
  // the rampart lands next tick. A sealed egress must not wait on a storage buffer —
  // a low-energy room (or one under siege) needs its gates working most of all.
  for (const key of gateSet) {
    const comma = key.indexOf(',');
    const x = Number(key.slice(0, comma));
    const y = Number(key.slice(comma + 1));
    const pos = new RoomPosition(x, y, room.name);
    const wall = pos.lookFor(LOOK_STRUCTURES).find((s) => s.structureType === STRUCTURE_WALL);
    if (wall) {
      wall.destroy();
      return; // one structure op per tick
    }
  }

  // Energy gate: pause NEW rampart sites when storage is low.
  const stored = room.storage?.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0;
  if (room.storage && stored < PERIMETER_STORAGE_MIN) return;

  for (const key of perimPlan.perimeterTiles) {
    // At RCL 6+, walls handle non-gate tiles — this function only manages gates.
    if (rcl >= 6 && !gateSet.has(key)) continue;

    const comma = key.indexOf(',');
    const x = Number(key.slice(0, comma));
    const y = Number(key.slice(comma + 1));
    const pos = new RoomPosition(x, y, room.name);

    const hasRampart = pos
      .lookFor(LOOK_STRUCTURES)
      .some((s) => s.structureType === STRUCTURE_RAMPART);
    const hasSite = pos
      .lookFor(LOOK_CONSTRUCTION_SITES)
      .some((s) => s.structureType === STRUCTURE_RAMPART);
    if (hasRampart || hasSite) continue;

    room.createConstructionSite(pos, STRUCTURE_RAMPART);
    return; // one site per tick
  }
}

/**
 * Place walls on non-gate perimeter tiles — RCL 6+.
 *
 * Walls are permanent, impassable to all creeps, and absorb far more damage
 * than ramparts. They have no decay, so once repaired to the floor HP they
 * need minimal ongoing maintenance. Gate tiles are skipped — those are
 * rampart-only so own creeps can pass through.
 *
 * One site per call.
 */
export function placePerimeterWalls(room: Room): void {
  const rcl = room.controller?.level ?? 0;
  if (rcl < 6) return;

  const mem = Memory.rooms[room.name];
  const perimPlan = mem?.perimeterPlan;
  if (!perimPlan) return;

  // Energy gate: pause new sites when storage is low.
  const stored = room.storage?.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0;
  if (room.storage && stored < PERIMETER_STORAGE_MIN) return;

  const gateSet = new Set(perimPlan.gateTiles);

  for (const key of perimPlan.perimeterTiles) {
    if (gateSet.has(key)) continue; // gates: rampart only, no wall

    const comma = key.indexOf(',');
    const x = Number(key.slice(0, comma));
    const y = Number(key.slice(comma + 1));
    const pos = new RoomPosition(x, y, room.name);

    const hasWall = pos.lookFor(LOOK_STRUCTURES).some((s) => s.structureType === STRUCTURE_WALL);
    const hasSite = pos
      .lookFor(LOOK_CONSTRUCTION_SITES)
      .some((s) => s.structureType === STRUCTURE_WALL);
    if (hasWall || hasSite) continue;

    room.createConstructionSite(pos, STRUCTURE_WALL);
    return; // one site per tick
  }
}

export function placeRemoteRoads(room: Room): void {
  const rcl = room.controller?.level ?? 0;
  if (rcl < 4) return;

  const mem = Memory.rooms[room.name];
  const remoteRooms = mem?.remoteRooms;
  if (!remoteRooms || remoteRooms.length === 0) return;

  // When all remote roads were confirmed complete on the last check, re-check
  // every 50 ticks instead of every 5 to avoid the expensive PathFinder calls.
  if (mem?.remoteRoadsComplete && Game.time % 50 !== 0) return;

  const spawns = room.find(FIND_MY_SPAWNS);
  const anchor = spawns[0];
  if (!anchor) return;

  const reserved = getPlannedReserved(room);
  const homeRoomName = room.name;

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
            const base = getBaseCostMatrixForRoom(r);
            // Always clone so we can apply overlays without mutating the cache.
            const matrix = base.clone();
            // Set reserved home-room tiles to impassable so roads route around them.
            if (roomName === homeRoomName && reserved.size > 0) {
              for (const key of reserved) {
                const comma = key.indexOf(',');
                matrix.set(Number(key.slice(0, comma)), Number(key.slice(comma + 1)), 255);
              }
            }
            // Apply a high wall cost so PathFinder will route through a wall
            // (tunnel) only when the plain-terrain detour is >~15 tiles longer.
            // This overlay is LOCAL to road planning — creep movement matrices
            // are unaffected. See TUNNEL_WALL_COST for the threshold rationale.
            applyTunnelWalls(matrix, r, TUNNEL_WALL_COST);
            return matrix;
          },
        },
      );
      if (result.incomplete) continue;

      for (const step of result.path) {
        if (step.x === 0 || step.x === 49 || step.y === 0 || step.y === 49) continue;
        // Belt-and-braces: skip any home-room step that landed on a reserved tile.
        if (step.roomName === homeRoomName && reserved.has(`${step.x},${step.y}`)) continue;
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

  // All paths are fully roaded — slow down future re-checks
  if (mem) mem.remoteRoadsComplete = true;
}

/**
 * Place roads from the first spawn to each source in a newly-claimed colony room
 * (pre-storage, i.e. RCL 2–3). Without roads, harvesters and colonyBuilders bleed
 * fatigue on plains/swamp, slowing container construction and the economy flip.
 *
 * Mirrors placeRemoteRoads but intra-room only and without the reserver gate.
 * Returns true when a road site was placed (one per call to stay within CPU),
 * false when all paths are already roaded (or nothing to do).
 */
export function placeColonyBootstrapRoads(room: Room): boolean {
  // Only pre-storage claimed rooms — main rooms already handled by placeRoads().
  if (!room.controller?.my || room.storage) return false;

  const spawns = room.find(FIND_MY_SPAWNS);
  const anchor = spawns[0];
  if (!anchor) return false;

  // Share the road-site cap with placeRoads to prevent accumulation of dozens
  // of unbuilt road sites that push the room against the 90-site global limit.
  const roadSites = room.find(FIND_MY_CONSTRUCTION_SITES, {
    filter: (s) => s.structureType === STRUCTURE_ROAD,
  });
  if (roadSites.length > 3) return false;

  const roomMem = Memory.rooms[room.name];
  const sources = roomMem?.sources;
  if (!sources || sources.length === 0) return false;

  const reserved = getPlannedReserved(room);

  for (const source of sources) {
    const targetPos = new RoomPosition(source.x, source.y, room.name);
    const result = PathFinder.search(
      anchor.pos,
      { pos: targetPos, range: 1 },
      {
        plainCost: 2,
        swampCost: 10,
        roomCallback(roomName) {
          const r = Game.rooms[roomName];
          if (!r) return false;
          const base = getBaseCostMatrixForRoom(r);
          // Set reserved tiles to impassable so roads route around planned structures.
          if (reserved.size > 0) {
            const matrix = base.clone();
            for (const key of reserved) {
              const comma = key.indexOf(',');
              matrix.set(Number(key.slice(0, comma)), Number(key.slice(comma + 1)), 255);
            }
            return matrix;
          }
          return base;
        },
      },
    );
    if (result.incomplete) continue;

    for (const step of result.path) {
      // Skip border tiles (not buildable)
      if (step.x === 0 || step.x === 49 || step.y === 0 || step.y === 49) continue;
      if (reserved.has(`${step.x},${step.y}`)) continue; // belt-and-braces: skip reserved tiles
      const structures = room.lookForAt(LOOK_STRUCTURES, step.x, step.y);
      const sites = room.lookForAt(LOOK_CONSTRUCTION_SITES, step.x, step.y);
      const hasRoad =
        structures.some((s) => s.structureType === STRUCTURE_ROAD) ||
        sites.some((s) => s.structureType === STRUCTURE_ROAD);
      if (!hasRoad) {
        room.createConstructionSite(step.x, step.y, STRUCTURE_ROAD);
        return true; // one road site per tick
      }
    }
  }

  return false;
}

/**
 * Set of obstacle structure types whose foreign instances we destroy.
 * Roads and containers are intentionally excluded: they are reusable by anyone
 * (not ownership-locked) and don't block construction site placement.
 */
const FOREIGN_OBSTACLE_TYPES: Set<StructureConstant> = new Set([
  STRUCTURE_SPAWN,
  STRUCTURE_EXTENSION,
  STRUCTURE_TOWER,
  STRUCTURE_LINK,
  STRUCTURE_LAB,
  STRUCTURE_EXTRACTOR,
  STRUCTURE_TERMINAL,
  STRUCTURE_FACTORY,
  STRUCTURE_OBSERVER,
  STRUCTURE_POWER_SPAWN,
  STRUCTURE_NUKER,
  STRUCTURE_STORAGE,
]);

/**
 * Foreign bulk-store types whose contents are worth draining directly with
 * haulers (via withdraw()) instead of voiding via destroy(). ONLY these types,
 * and ONLY when still holding resources (storeUsed > 0), take the drain-then-
 * destroy path. Haulers drain the store via pickupForeignStore; once truly empty
 * the husk is destroyed, freeing the single storage slot for our own placement.
 *
 * Every other foreign obstacle (spawn, extension, tower, link, lab, …) is
 * destroyed even if it holds a little energy. This is critical: a foreign SPAWN
 * or EXTENSION counts against OUR RCL structure-count limit, so leaving one
 * standing because it held a few hundred energy returns ERR_RCL_NOT_ENOUGH on
 * our own placement and hard-stalls the colony (observed live in W42N59: a
 * 300-energy leftover spawn blocked our own spawn for the entire bootstrap).
 * A little voided energy is a fine price to free the slot.
 */
const LOOTABLE_TYPES: Set<StructureConstant> = new Set([STRUCTURE_STORAGE, STRUCTURE_TERMINAL]);

/**
 * Clean up foreign-owned and unowned obstacle structures in a room we control.
 *
 * Called every 5 ticks (when runConstruction fires) for each owned room.
 * Idempotent: re-running when everything is already destroyed is a no-op.
 *
 * Rules:
 * - FOREIGN_OBSTACLE_TYPES → destroy() (free, instant), EXCEPT a LOOTABLE_TYPES
 *   bulk store (storage/terminal) that is still non-empty (storeUsed > 0).
 *   Non-empty lootable stores are spared while haulers drain them directly via
 *   withdraw() (pickupForeignStore in hauler.ts) — lossless, no dismantle needed.
 *   Once truly empty, the husk is destroyed next cleanup tick, freeing the single
 *   storage slot for our own placement. Spawns/extensions/towers/etc. are always
 *   destroyed even with a little energy — they occupy our RCL structure-count
 *   slots and must not block our placement.
 * - Unowned constructedWalls on tiles our layout/perimeter plan WANTS to
 *   build on → destroy().  Walls in the perimeter plan are kept; walls on
 *   unplanned open tiles are left alone (conservative).
 * - Roads and containers → never touched (ownership-neutral, reusable).
 * - Foreign construction sites → remove() all of them. We can't build another
 *   player's site and they block our own placement; unlike built roads, an
 *   unfinished foreign site has no reuse value.
 *
 * Also maintains RoomMemory.lootTargetId: records the first qualifying non-empty
 * loot target's ID so haulers can find it without a repeated FIND_HOSTILE_STRUCTURES
 * scan. Cleared once the structure is drained to 0.
 */
export function cleanupClaimedRoom(room: Room): void {
  if (!room.controller?.my) return;

  const mem = (Memory.rooms[room.name] ??= {});

  // Build the set of tiles our plan wants — used to decide whether an
  // unowned constructedWall is blocking something we need.
  const plannedTiles = getPlannedReserved(room);
  // Also include perimeter tiles (walls + gates) — we must not destroy walls
  // that are already part of the perimeter plan.
  const perimeterTileSet = new Set<string>();
  if (mem.perimeterPlan) {
    for (const key of mem.perimeterPlan.perimeterTiles) perimeterTileSet.add(key);
  }

  // --- Hostile (foreign-owned) structures ---
  const hostileStructures = room.find(FIND_HOSTILE_STRUCTURES);
  let lootTargetId: Id<AnyStoreStructure> | undefined;

  for (const s of hostileStructures) {
    const type = s.structureType as StructureConstant;

    // Never touch roads or containers — they're neutral and may be in use.
    if (type === STRUCTURE_ROAD || type === STRUCTURE_CONTAINER) continue;

    if (FOREIGN_OBSTACLE_TYPES.has(type)) {
      const storeUsed =
        'store' in s ? ((s as unknown as AnyStoreStructure).store.getUsedCapacity() ?? 0) : 0;

      // A non-empty lootable bulk store (storage/terminal) is drained by haulers
      // directly via withdraw() — lossless, no dismantle needed. Spare it until
      // truly empty (storeUsed > 0). Everything else — foreign spawn/extension/
      // tower/link/lab, or a lootable type at exactly 0 — is destroyed, because
      // it occupies an RCL structure-count slot we need for our own buildout.
      if (LOOTABLE_TYPES.has(type) && storeUsed > 0) {
        // Record as loot target (first qualifying one wins); haulers drain it
        // via pickupForeignStore before cleanupClaimedRoom destroys the empty husk.
        if (!lootTargetId) {
          lootTargetId = (s as unknown as AnyStoreStructure).id;
        }
        continue;
      }

      s.destroy();
    }
  }

  // Update loot target pointer in room memory.
  if (lootTargetId) {
    mem.lootTargetId = lootTargetId;
  } else if (mem.lootTargetId) {
    // Re-validate: if the recorded target is gone or now empty, clear it.
    const existing = Game.getObjectById(mem.lootTargetId);
    const storeUsed =
      existing && 'store' in existing
        ? ((existing as unknown as AnyStoreStructure).store.getUsedCapacity() ?? 0)
        : 0;
    if (storeUsed === 0) delete mem.lootTargetId;
  }

  // --- Unowned constructedWalls ---
  // Only destroy walls that sit on a tile our layout/perimeter plan wants to
  // build on.  We never destroy perimeter-plan walls (they're intentional) and
  // we never destroy walls on open tiles we don't need (conservative).
  const walls = room.find(FIND_STRUCTURES, {
    filter: (s) => s.structureType === STRUCTURE_WALL,
  }) as StructureWall[];

  for (const wall of walls) {
    // Skip walls that are in our own perimeter plan — they're either already
    // ours or will be rebuilt.
    const key = `${wall.pos.x},${wall.pos.y}`;
    if (perimeterTileSet.has(key)) continue;

    // Only destroy unowned walls; our own walls are untouched.
    if ('my' in wall && (wall as unknown as OwnedStructure).my) continue;

    // Only destroy walls that occupy a tile our layout plan intends to use.
    if (plannedTiles.has(key)) {
      wall.destroy();
    }
  }

  // --- Foreign construction sites ---
  // The previous owner's unfinished sites are pure dead weight: we can't build
  // another player's site (only its owner can), and they block our own
  // placement on those tiles (and obstacle-type sites block movement). remove()
  // is legal because the site is in a room we own. Remove all of them — unlike
  // built roads/containers (which are reusable), a foreign site is useless to us.
  for (const site of room.find(FIND_HOSTILE_CONSTRUCTION_SITES)) {
    site.remove();
  }
}

/**
 * Place the first spawn construction site in a newly-claimed colony room.
 *
 * Triggered for rooms we own that have no spawn structure AND no spawn site —
 * the bootstrap state established by Memory.missions.colony. Uses the suggested spawn
 * position from layoutPlanner (computed during scouting); falls back to a fresh
 * scan if no suggestion exists yet.
 */
export function placeColonySpawn(room: Room): void {
  if (!room.controller?.my) return;

  const hasSpawn = room.find(FIND_MY_SPAWNS).length > 0;
  if (hasSpawn) return;

  const existingSite = room.find(FIND_MY_CONSTRUCTION_SITES, {
    filter: (s) => s.structureType === STRUCTURE_SPAWN,
  });
  if (existingSite.length > 0) return;

  const mem = (Memory.rooms[room.name] ??= {});
  let suggested = mem.suggestedSpawnPos;
  if (!suggested) {
    suggested = findBestSpawnPosition(room.name) ?? undefined;
  }
  if (!suggested) {
    if (Game.time % 100 === 0) {
      console.log(`[construction] ${room.name}: no viable spawn position for colony bootstrap`);
    }
    return;
  }

  const terrain = room.getTerrain();
  if (terrain.get(suggested.x, suggested.y) === TERRAIN_MASK_WALL) {
    delete mem.suggestedSpawnPos;
    return;
  }

  const pos = new RoomPosition(suggested.x, suggested.y, room.name);
  // A pre-existing road (built or under construction) is fine — spawn is placed
  // on top and the road becomes redundant. Anything else on the tile is a real
  // block. Observed at W44N57: placeRemoteRoads had left a road CS at (27,7)
  // before the room was claimed, blocking the colony spawn until cleared.
  const blocked =
    pos.lookFor(LOOK_STRUCTURES).some((s) => s.structureType !== STRUCTURE_ROAD) ||
    pos.lookFor(LOOK_CONSTRUCTION_SITES).some((s) => s.structureType !== STRUCTURE_ROAD);
  if (blocked) return;

  const result = room.createConstructionSite(pos, STRUCTURE_SPAWN);
  if (result === OK) {
    console.log(`[construction] ${room.name}: placed first colony spawn at (${pos.x},${pos.y})`);
  }
}

export function runConstruction(): void {
  if (Object.keys(Game.constructionSites).length >= 90) return;

  for (const room of Object.values(Game.rooms)) {
    if (!room.controller?.my) continue;

    // Destroy empty foreign obstacle structures and record any loot target.
    // Runs every 5 ticks (same cadence as runConstruction) and is idempotent.
    cleanupClaimedRoom(room);

    // Colony-bootstrap rooms get their first spawn placed before anything else —
    // until a spawn exists the room has no economy at all.
    placeColonySpawn(room);

    placeSourceContainers(room);
    placeControllerContainer(room);
    placeStorage(room);
    placeSecondSpawn(room);
    placeLinks(room);
    placeExtensions(room);
    placeTowers(room);
    placeRoads(room);
    placeColonyBootstrapRoads(room);
    placeCorridorRoads(room);
    placeRemoteRoads(room);
    placeTerminal(room);
    placeFactory(room);
    placeExtractor(room);
    placeMineralContainer(room);
    clearBlockingExtensions(room);
    clearLabBlockers(room);
    placeLabs(room);
    placeRamparts(room);
    placePerimeterWalls(room);
    placePerimeterRamparts(room);
  }
}
