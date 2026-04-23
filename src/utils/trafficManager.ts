import { cached } from './tickCache';

export const PRIORITY_STATIC = 100;
export const PRIORITY_HAULER = 50;
export const PRIORITY_WORKER = 30;
export const PRIORITY_DEFAULT = 10;

interface MoveIntent {
  creep: Creep;
  nextPos: RoomPosition;
  priority: number;
  path?: RoomPosition[];
  stroke?: string;
}

let intents: MoveIntent[] = [];

export function registerMove(
  creep: Creep,
  targetPos: RoomPosition,
  priority: number,
  range: number,
  stroke?: string,
): void {
  if (creep.pos.inRangeTo(targetPos, range)) return;

  const path = getPath(creep, targetPos, range);
  const nextPos = path[0];
  if (nextPos) {
    intents.push({ creep, nextPos, priority, path, stroke });
  }
}

export function registerStationary(creep: Creep, priority: number): void {
  intents.push({ creep, nextPos: creep.pos, priority });
}

export function resetTraffic(): void {
  intents = [];
}

export function resolveTraffic(): void {
  if (intents.length === 0) return;

  const allCreeps = new Set<string>();
  for (const intent of intents) {
    allCreeps.add(intent.creep.name);
  }

  // Build map of current positions for all creeps (including those without intents)
  const occupied = new Map<string, { creep: Creep; priority: number }>();

  // Register all creeps in the room at their current positions with idle priority
  for (const intent of intents) {
    const room = intent.creep.room;
    for (const creep of room.find(FIND_MY_CREEPS)) {
      const key = posKey(creep.pos);
      if (!occupied.has(key) && !allCreeps.has(creep.name)) {
        occupied.set(key, { creep, priority: 0 });
      }
    }
  }

  // Sort intents by priority descending — higher priority gets first pick
  intents.sort((a, b) => b.priority - a.priority);

  const assigned = new Map<string, MoveIntent>();
  const moves = new Map<string, DirectionConstant>();

  for (const intent of intents) {
    const key = posKey(intent.nextPos);

    // Stationary intent — claim current position
    if (intent.nextPos.isEqualTo(intent.creep.pos)) {
      assigned.set(key, intent);
      occupied.set(key, { creep: intent.creep, priority: intent.priority });
      continue;
    }

    // Check if target tile is already claimed
    const existing = assigned.get(key);
    if (existing) {
      // Tile taken by higher priority — try to find an alternative
      tryAlternative(intent, assigned, occupied, moves);
      continue;
    }

    // Check if an idle creep occupies the target tile
    const blocker = occupied.get(key);
    if (blocker && !allCreeps.has(blocker.creep.name)) {
      // Idle creep blocking — try to shove it if we outpriority it
      if (intent.priority > blocker.priority && blocker.priority < PRIORITY_STATIC) {
        const shoved = shoveCreep(blocker.creep, intent.creep.pos, assigned, occupied);
        if (shoved) {
          assigned.set(key, intent);
          occupied.set(key, { creep: intent.creep, priority: intent.priority });
          moves.set(intent.creep.name, intent.creep.pos.getDirectionTo(intent.nextPos));
          continue;
        }
      }
      tryAlternative(intent, assigned, occupied, moves);
      continue;
    }

    // Check for swap conflict
    if (blocker && allCreeps.has(blocker.creep.name)) {
      const blockerIntent = intents.find((i) => i.creep.name === blocker.creep.name);
      if (blockerIntent && blockerIntent.nextPos.isEqualTo(intent.creep.pos)) {
        // Direct swap — both creeps move simultaneously (Screeps handles 2-way swaps)
        assigned.set(key, intent);
        occupied.set(key, { creep: intent.creep, priority: intent.priority });
        moves.set(intent.creep.name, intent.creep.pos.getDirectionTo(intent.nextPos));

        const blockerKey = posKey(blockerIntent.nextPos);
        assigned.set(blockerKey, blockerIntent);
        occupied.set(blockerKey, { creep: blockerIntent.creep, priority: blockerIntent.priority });
        moves.set(
          blockerIntent.creep.name,
          blockerIntent.creep.pos.getDirectionTo(blockerIntent.nextPos),
        );
        continue;
      }
    }

    // Tile is free — claim it
    assigned.set(key, intent);
    occupied.set(key, { creep: intent.creep, priority: intent.priority });
    moves.set(intent.creep.name, intent.creep.pos.getDirectionTo(intent.nextPos));
  }

  // Break 3+ way cycles — Screeps only resolves 2-way swaps natively
  breakCycles(moves, intents);

  // Issue move commands
  for (const [name, direction] of moves) {
    const creep = Game.creeps[name];
    if (creep) {
      creep.move(direction);
    }
  }

  // Draw path visualizations
  if (Memory.visuals) {
    for (const intent of intents) {
      if (!intent.stroke || !intent.path || intent.path.length === 0) continue;
      if (!moves.has(intent.creep.name)) continue;
      const points = [intent.creep.pos, ...intent.path];
      new RoomVisual(intent.creep.room.name).poly(points, {
        stroke: intent.stroke,
        lineStyle: 'dashed',
        strokeWidth: 0.15,
        opacity: 0.4,
      });
    }
  }
}

function breakCycles(moves: Map<string, DirectionConstant>, allIntents: MoveIntent[]): void {
  // Build position maps for moving creeps only
  const occupantAt = new Map<string, string>();
  const nextPosOf = new Map<string, string>();
  const priorityOf = new Map<string, number>();

  for (const intent of allIntents) {
    if (!moves.has(intent.creep.name)) continue;
    if (intent.nextPos.isEqualTo(intent.creep.pos)) continue; // stationary
    const curKey = posKey(intent.creep.pos);
    const nxtKey = posKey(intent.nextPos);
    occupantAt.set(curKey, intent.creep.name);
    nextPosOf.set(intent.creep.name, nxtKey);
    priorityOf.set(intent.creep.name, intent.priority);
  }

  const visited = new Set<string>();

  for (const [startName] of nextPosOf) {
    if (visited.has(startName)) continue;

    const chain: string[] = [];
    const chainSet = new Set<string>();
    let cur: string | undefined = startName;

    while (cur && !chainSet.has(cur) && !visited.has(cur)) {
      chain.push(cur);
      chainSet.add(cur);
      const nxt = nextPosOf.get(cur);
      if (!nxt) break;
      cur = occupantAt.get(nxt);
    }

    for (const name of chain) visited.add(name);

    if (cur && chainSet.has(cur)) {
      const cycleStart = chain.indexOf(cur);
      const cycle = chain.slice(cycleStart);

      if (cycle.length > 2) {
        // Remove the lowest-priority creep's move (name tiebreak for stability)
        let worst = cycle[0]!;
        let worstPri = priorityOf.get(worst) ?? 0;
        for (let i = 1; i < cycle.length; i++) {
          const name = cycle[i]!;
          const pri = priorityOf.get(name) ?? 0;
          if (pri < worstPri || (pri === worstPri && name > worst)) {
            worst = name;
            worstPri = pri;
          }
        }
        moves.delete(worst);
      }
    }
  }
}

function posKey(pos: RoomPosition): string {
  return `${pos.roomName}:${pos.x}:${pos.y}`;
}

function tryAlternative(
  intent: MoveIntent,
  assigned: Map<string, MoveIntent>,
  occupied: Map<string, { creep: Creep; priority: number }>,
  moves: Map<string, DirectionConstant>,
): void {
  const { creep } = intent;
  const adjacent = getWalkableAdjacent(creep.pos, creep.room);
  for (const pos of adjacent) {
    const key = posKey(pos);
    if (!assigned.has(key) && !occupied.has(key)) {
      assigned.set(key, intent);
      occupied.set(key, { creep, priority: intent.priority });
      moves.set(creep.name, creep.pos.getDirectionTo(pos));
      return;
    }
  }
  // No alternative — stay put
}

function shoveCreep(
  blocker: Creep,
  avoidPos: RoomPosition,
  assigned: Map<string, MoveIntent>,
  occupied: Map<string, { creep: Creep; priority: number }>,
): boolean {
  const adjacent = getWalkableAdjacent(blocker.pos, blocker.room);
  for (const pos of adjacent) {
    if (pos.isEqualTo(avoidPos)) continue;
    const key = posKey(pos);
    if (!assigned.has(key) && !occupied.has(key)) {
      // Shove the idle creep to this tile
      occupied.delete(posKey(blocker.pos));
      occupied.set(key, { creep: blocker, priority: 0 });
      blocker.move(blocker.pos.getDirectionTo(pos));
      return true;
    }
  }
  return false;
}

function getWalkableAdjacent(pos: RoomPosition, room: Room): RoomPosition[] {
  const terrain = cached('traffic:terrain:' + pos.roomName, () =>
    Game.map.getRoomTerrain(pos.roomName),
  );
  const costs = getRoomCostMatrix(room);
  const result: RoomPosition[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      const x = pos.x + dx;
      const y = pos.y + dy;
      if (x < 1 || x > 48 || y < 1 || y > 48) continue;
      if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
      if (costs.get(x, y) >= 255) continue;
      result.push(new RoomPosition(x, y, pos.roomName));
    }
  }
  return result;
}

function getPath(creep: Creep, target: RoomPosition, range: number): RoomPosition[] {
  const cacheKey = `traffic:path:${creep.name}`;
  return cached(cacheKey, () => {
    const costMatrix = getRoomCostMatrix(creep.room);
    const result = PathFinder.search(
      creep.pos,
      { pos: target, range },
      {
        plainCost: 2,
        swampCost: 10,
        maxRooms: 1,
        roomCallback: () => costMatrix,
      },
    );
    return result.path;
  });
}

function getRoomCostMatrix(room: Room): CostMatrix {
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
        costs.set(creep.pos.x, creep.pos.y, Math.max(current, 15));
      }
    }
    return costs;
  });
}
