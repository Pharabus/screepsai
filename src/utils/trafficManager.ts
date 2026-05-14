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
        // need to traverse intermediate rooms; 2 is not enough.
        maxRooms: crossRoom ? 6 : 1,
        maxOps: crossRoom ? 4000 : 2000,
        roomCallback: (roomName) => {
          const room = Game.rooms[roomName];
          // Unseen rooms: return true so PathFinder uses default terrain.
          // Returning false would skip the room entirely, breaking any path
          // through unscouted territory.
          if (!room) return true;
          return getRoomCostMatrix(room);
        },
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
