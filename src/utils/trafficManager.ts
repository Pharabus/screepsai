import { cached } from './tickCache';

export const PRIORITY_STATIC = 100;
export const PRIORITY_HAULER = 50;
export const PRIORITY_WORKER = 30;
export const PRIORITY_DEFAULT = 10;

interface PathVis {
  roomName: string;
  points: RoomPosition[];
  stroke: string;
}

const stationaryCreeps = new Set<string>();
let vizBuffer: PathVis[] = [];

export function registerStationary(creep: Creep, _priority: number): void {
  stationaryCreeps.add(creep.name);
}

export function resetTraffic(): void {
  stationaryCreeps.clear();
  vizBuffer = [];
}

export function resolveTraffic(): void {
  if (!Memory.visuals || vizBuffer.length === 0) return;
  for (const viz of vizBuffer) {
    new RoomVisual(viz.roomName).poly(viz.points, {
      stroke: viz.stroke,
      lineStyle: 'dashed',
      strokeWidth: 0.15,
      opacity: 0.4,
    });
  }
}

export function executeMove(
  creep: Creep,
  target: RoomPosition,
  range: number,
  stroke?: string,
): void {
  if (creep.pos.inRangeTo(target, range)) return;

  const path = getPath(creep, target, range);
  const nextPos = path[0];
  if (!nextPos) return;

  creep.move(creep.pos.getDirectionTo(nextPos));

  if (stroke && path.length > 0) {
    const room = creep.room.name;
    const localPoints = [creep.pos, ...path].filter((p) => p.roomName === room);
    if (localPoints.length > 1) {
      vizBuffer.push({ roomName: room, points: localPoints, stroke });
    }
  }
}

function getMyUsername(): string | undefined {
  return cached('me:username', () => {
    for (const name in Game.spawns) {
      return Game.spawns[name]?.owner.username;
    }
    return undefined;
  });
}

export function pathRoomCallback(roomName: string): boolean | CostMatrix {
  const room = Game.rooms[roomName];
  if (!room) {
    // Unseen room: skip if known to be owned by another player — their towers
    // will one-shot our creeps. Owned rooms we have vision into fall through
    // to the cost-matrix path below; if we lose vision briefly, the scoutedOwner
    // comparison against our username keeps our own rooms traversable.
    const owner = Memory.rooms?.[roomName]?.scoutedOwner;
    if (owner && owner !== getMyUsername()) return false;
    // Return an empty CostMatrix (not `true` or `undefined`) so terrain falls
    // through. Mixing `true`/`undefined` returns with real CostMatrix returns
    // for visible rooms confuses PathFinder when the visible room has 255
    // obstacles — observed with abandoned constructedWalls in W45N58, the
    // search would return incomplete with a first step pointing backward,
    // bouncing the creep across the border. Always returning a CostMatrix
    // (hivemind does the same) keeps PathFinder consistent.
    return new PathFinder.CostMatrix();
  }
  return getRoomCostMatrix(room);
}

function getPath(creep: Creep, target: RoomPosition, range: number): RoomPosition[] {
  return cached(`traffic:path:${creep.name}`, () => {
    const crossRoom = creep.pos.roomName !== target.roomName;
    const result = PathFinder.search(
      creep.pos,
      { pos: target, range },
      {
        plainCost: 2,
        swampCost: 10,
        // Diagonal / multi-hop targets (e.g. depth-3 scout, remote miners)
        // need to traverse intermediate rooms; the default of 2 is not enough,
        // and a cluttered room (constructedWalls, etc.) can force a multi-room
        // detour. 16 matches the Screeps default and hivemind's choice.
        maxRooms: crossRoom ? 16 : 1,
        // Cross-room searches need room to breathe; 2000 (the engine default)
        // is too tight even for a 2-room hop, and tighter caps return partial
        // paths pointing backward.
        maxOps: crossRoom ? 10000 : 2000,
        roomCallback: pathRoomCallback,
      },
    );
    return result.path;
  });
}

export function getRoomCostMatrix(room: Room): CostMatrix {
  return cached('traffic:costs:' + room.name, () => {
    const costs = new PathFinder.CostMatrix();

    for (const struct of room.find(FIND_STRUCTURES)) {
      if (struct.structureType === STRUCTURE_ROAD) {
        costs.set(struct.pos.x, struct.pos.y, 1);
      } else if (
        struct.structureType !== STRUCTURE_CONTAINER &&
        !(struct.structureType === STRUCTURE_RAMPART && (struct as StructureRampart).my)
      ) {
        costs.set(struct.pos.x, struct.pos.y, 255);
      }
    }

    for (const creep of room.find(FIND_MY_CREEPS)) {
      const current = costs.get(creep.pos.x, creep.pos.y);
      if (current < 255) {
        const cost = stationaryCreeps.has(creep.name) ? 255 : Math.max(current, 15);
        costs.set(creep.pos.x, creep.pos.y, cost);
      }
    }

    for (const hostile of room.find(FIND_HOSTILE_CREEPS)) {
      costs.set(hostile.pos.x, hostile.pos.y, 255);
    }

    return costs;
  });
}
