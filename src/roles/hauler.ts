import { Role } from './Role';
import { moveTo } from '../utils/movement';
import { markIdle } from '../utils/idle';
import { PRIORITY_HAULER } from '../utils/trafficManager';
import { runStateMachine, StateMachineDefinition } from '../utils/stateMachine';
import { deliverToSpawnOrExtension, deliverToControllerContainer } from '../utils/delivery';
import { cached } from '../utils/tickCache';
import { MINERAL_STORAGE_FLOOR, TERMINAL_ENERGY_FLOOR } from '../utils/thresholds';

const STORAGE_LINK_DRAIN_THRESHOLD = 200;
// Only dispatch a hauler for lab minerals when the lab genuinely needs a
// refill batch. LAB_REACTION_AMOUNT (5) is far too small — it fired on every
// tick of reaction consumption, monopolising both haulers with micro-loads
// (800 units withdrawn to deliver 5) and starving energy logistics.
// At 5 energy consumed per reaction tick, 500 units = ~100 ticks of runway.
const MIN_LAB_LOAD = 500;

const states: StateMachineDefinition = {
  PICKUP: {
    onEnter(creep) {
      delete creep.memory.targetId;
    },
    run(creep) {
      if (creep.store.getFreeCapacity() === 0) return 'DELIVER';
      const found = pickup(creep);
      if (!found && creep.store.getUsedCapacity() > 0) return 'DELIVER';
      return undefined;
    },
  },
  DELIVER: {
    onEnter(creep) {
      delete creep.memory.targetId;
    },
    run(creep) {
      if (creep.store.getUsedCapacity() === 0) return 'PICKUP';
      deliver(creep);
      return undefined;
    },
  },
};

export const hauler: Role = {
  run(creep: Creep): void {
    runStateMachine(creep, states, 'PICKUP');
  },
};

function getUrgentResponder(room: Room): string | undefined {
  return cached(`urgentResponder:${room.name}`, () => {
    const storage = room.storage;
    if (!storage || storage.store.getUsedCapacity(RESOURCE_ENERGY) === 0) return undefined;

    const myStructures = room.find(FIND_MY_STRUCTURES);
    const hasSpawnNeed = myStructures.some(
      (s) =>
        (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) &&
        s.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
    );
    const hasTowerNeed = myStructures.some(
      (s) =>
        s.structureType === STRUCTURE_TOWER &&
        (s as StructureTower).store.getFreeCapacity(RESOURCE_ENERGY) >
          (s as StructureTower).store.getCapacity(RESOURCE_ENERGY) * 0.25,
    );
    if (!hasSpawnNeed && !hasTowerNeed) return undefined;

    let nearest: string | undefined;
    let bestDist = Infinity;
    for (const c of Object.values(Game.creeps)) {
      if (c.room.name !== room.name || c.memory.role !== 'hauler') continue;
      if (c.store.getFreeCapacity() === 0) continue;
      const dist = c.pos.getRangeTo(storage);
      if (dist < bestDist) {
        bestDist = dist;
        nearest = c.name;
      }
    }
    return nearest;
  });
}

function continueCommittedPickup(creep: Creep): boolean {
  if (!creep.memory.targetId) return false;

  const target = Game.getObjectById(creep.memory.targetId);
  if (!target) {
    delete creep.memory.targetId;
    return false;
  }

  // Dropped resource
  if ('amount' in target) {
    const drop = target as Resource;
    if (drop.amount === 0) {
      delete creep.memory.targetId;
      return false;
    }
    if (creep.pickup(drop) === ERR_NOT_IN_RANGE) {
      moveTo(creep, drop, {
        priority: PRIORITY_HAULER,
        visualizePathStyle: {
          stroke: drop.resourceType === RESOURCE_ENERGY ? '#ffaa00' : '#cc66ff',
        },
      });
    }
    return true;
  }

  // Structure with a store
  if ('store' in target) {
    const structure = target as AnyStoreStructure;
    if (structure.store.getUsedCapacity() === 0) {
      delete creep.memory.targetId;
      return false;
    }
    const resource = pickWithdrawResource(structure);
    if (!resource) {
      delete creep.memory.targetId;
      return false;
    }
    if (creep.withdraw(structure, resource) === ERR_NOT_IN_RANGE) {
      moveTo(creep, structure, {
        priority: PRIORITY_HAULER,
        visualizePathStyle: { stroke: resource === RESOURCE_ENERGY ? '#ffaa00' : '#cc66ff' },
      });
    }
    return true;
  }

  delete creep.memory.targetId;
  return false;
}

function pickWithdrawResource(structure: AnyStoreStructure): ResourceConstant | undefined {
  const isMineral =
    structure.structureType === STRUCTURE_CONTAINER &&
    Memory.rooms[structure.room?.name ?? '']?.mineralContainerId === structure.id;

  if (isMineral) {
    const mineralTypes = Object.keys(structure.store) as ResourceConstant[];
    return mineralTypes.find(
      (r) => r !== RESOURCE_ENERGY && structure.store.getUsedCapacity(r) > 0,
    );
  }

  if (structure.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
    return RESOURCE_ENERGY;
  }

  const allTypes = Object.keys(structure.store) as ResourceConstant[];
  return allTypes.find((r) => (structure.store.getUsedCapacity(r) ?? 0) > 0);
}

function pickup(creep: Creep): boolean {
  const mem = Memory.rooms[creep.room.name];

  // Urgent responder: only preempts if creep is not close to finishing current task
  if (getUrgentResponder(creep.room) === creep.name) {
    const hasNearbyCommitment =
      creep.memory.targetId &&
      Game.getObjectById(creep.memory.targetId) &&
      creep.pos.getRangeTo(Game.getObjectById(creep.memory.targetId)!) <= 3;

    if (!hasNearbyCommitment) {
      const storage = creep.room.storage!;
      creep.memory.targetId = storage.id;
      if (creep.withdraw(storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        moveTo(creep, storage, {
          priority: PRIORITY_HAULER,
          visualizePathStyle: { stroke: '#ffaa00' },
        });
      }
      return true;
    }
  }

  // Continue committed pickup task if still valid
  if (continueCommittedPickup(creep)) return true;

  // --- Priority chain for selecting a NEW pickup target ---

  // Lab work first: flushing/loading is otherwise starved when the storage
  // link keeps refilling above the drain threshold. Each branch returns
  // false fast when there's nothing to do (full lab or no active reaction),
  // so this only kicks in when labs actually need attention.
  if (pickupLabFlush(creep, mem)) return true;
  if (pickupLabInput(creep, mem)) return true;
  if (pickupLabOutput(creep, mem)) return true;

  // Drain storage link — bottleneck of the link pipeline
  if (mem?.storageLinkId) {
    const storageLink = Game.getObjectById(mem.storageLinkId);
    if (
      storageLink &&
      storageLink.store.getUsedCapacity(RESOURCE_ENERGY) >= STORAGE_LINK_DRAIN_THRESHOLD
    ) {
      creep.memory.targetId = storageLink.id;
      if (creep.withdraw(storageLink, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        moveTo(creep, storageLink, {
          priority: PRIORITY_HAULER,
          visualizePathStyle: { stroke: '#ffaa00' },
        });
      }
      return true;
    }
  }

  // Dropped energy — decay-sensitive
  const dropped = creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, {
    filter: (r) => r.resourceType === RESOURCE_ENERGY && r.amount >= 50,
  });
  if (dropped) {
    creep.memory.targetId = dropped.id;
    if (creep.pickup(dropped) === ERR_NOT_IN_RANGE) {
      moveTo(creep, dropped, {
        priority: PRIORITY_HAULER,
        visualizePathStyle: { stroke: '#ffaa00' },
      });
    }
    return true;
  }

  // Dropped minerals (non-energy) — decay-sensitive
  const droppedMineral = creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, {
    filter: (r) => r.resourceType !== RESOURCE_ENERGY && r.amount >= 50,
  });
  if (droppedMineral) {
    creep.memory.targetId = droppedMineral.id;
    if (creep.pickup(droppedMineral) === ERR_NOT_IN_RANGE) {
      moveTo(creep, droppedMineral, {
        priority: PRIORITY_HAULER,
        visualizePathStyle: { stroke: '#cc66ff' },
      });
    }
    return true;
  }

  // Full source containers (>= 1000 energy)
  const fullSourceContainer = findFullSourceContainer(creep.room, mem);
  if (fullSourceContainer) {
    creep.memory.targetId = fullSourceContainer.id;
    if (creep.withdraw(fullSourceContainer, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      moveTo(creep, fullSourceContainer, {
        priority: PRIORITY_HAULER,
        visualizePathStyle: { stroke: '#ffaa00' },
      });
    }
    return true;
  }

  // Mineral container — elevated above partially-full source containers
  if (mem?.mineralContainerId) {
    const mineralContainer = Game.getObjectById(mem.mineralContainerId);
    if (
      mineralContainer &&
      mineralContainer.store.getUsedCapacity() >
        mineralContainer.store.getUsedCapacity(RESOURCE_ENERGY)
    ) {
      const mineralTypes = Object.keys(mineralContainer.store) as ResourceConstant[];
      const mineralType = mineralTypes.find(
        (r) => r !== RESOURCE_ENERGY && mineralContainer.store.getUsedCapacity(r) > 0,
      );
      if (mineralType) {
        creep.memory.targetId = mineralContainer.id;
        if (creep.withdraw(mineralContainer, mineralType) === ERR_NOT_IN_RANGE) {
          moveTo(creep, mineralContainer, {
            priority: PRIORITY_HAULER,
            visualizePathStyle: { stroke: '#cc66ff' },
          });
        }
        return true;
      }
    }
  }

  // Any source container with energy
  const containers = creep.room.find(FIND_STRUCTURES, {
    filter: (s): s is StructureContainer =>
      s.structureType === STRUCTURE_CONTAINER && s.store.getUsedCapacity(RESOURCE_ENERGY) > 0,
  });

  const controllerContainerId = mem?.controllerContainerId;
  const mineralContainerId = mem?.mineralContainerId;
  const sourceContainers = containers.filter(
    (c) => c.id !== controllerContainerId && c.id !== mineralContainerId,
  );
  const target = sourceContainers.sort(
    (a, b) => b.store.getUsedCapacity(RESOURCE_ENERGY) - a.store.getUsedCapacity(RESOURCE_ENERGY),
  )[0];

  if (target) {
    creep.memory.targetId = target.id;
    if (creep.withdraw(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      moveTo(creep, target, {
        priority: PRIORITY_HAULER,
        visualizePathStyle: { stroke: '#ffaa00' },
      });
    }
    return true;
  }

  // Terminal: move excess minerals from storage to terminal
  if (pickupForTerminal(creep)) return true;

  markIdle(creep);
  return false;
}

function pickupLabFlush(creep: Creep, mem: RoomMemory | undefined): boolean {
  if (!mem?.labFlushing || !mem.activeReaction || !mem.inputLabIds) return false;

  const { input1, input2 } = mem.activeReaction;
  const labs: [StructureLab | null, ResourceConstant][] = [
    [Game.getObjectById(mem.inputLabIds[0]), input1],
    [Game.getObjectById(mem.inputLabIds[1]), input2],
  ];

  for (const [lab, expectedMineral] of labs) {
    if (!lab) continue;
    const mineralType = lab.mineralType;
    if (!mineralType || mineralType === expectedMineral) continue;
    if (lab.store.getUsedCapacity(mineralType) === 0) continue;
    creep.memory.targetId = lab.id as Id<StructureLab>;
    if (creep.withdraw(lab, mineralType) === ERR_NOT_IN_RANGE) {
      moveTo(creep, lab, { priority: PRIORITY_HAULER, visualizePathStyle: { stroke: '#ff6600' } });
    }
    return true;
  }
  return false;
}

function pickupLabInput(creep: Creep, mem: RoomMemory | undefined): boolean {
  if (!mem?.activeReaction || !mem.inputLabIds) return false;
  const storage = creep.room.storage;
  const terminal = creep.room.terminal;
  if (!storage && !terminal) return false;

  const { input1, input2 } = mem.activeReaction;
  const inputs: [StructureLab | null, ResourceConstant][] = [
    [Game.getObjectById(mem.inputLabIds[0]), input1],
    [Game.getObjectById(mem.inputLabIds[1]), input2],
  ];

  for (const [lab, mineral] of inputs) {
    const needed = lab?.store.getFreeCapacity(mineral) ?? 0;
    if (!lab || needed < MIN_LAB_LOAD) continue;
    const inStorage = storage?.store.getUsedCapacity(mineral) ?? 0;
    const inTerminal = terminal?.store.getUsedCapacity(mineral) ?? 0;
    // Prefer storage; fall back to terminal so 26k H stuck there isn't invisible to labs
    const source: StructureStorage | StructureTerminal | null =
      inStorage > 0 ? (storage ?? null) : inTerminal > 0 ? (terminal ?? null) : null;
    if (!source) continue;
    const available = inStorage > 0 ? inStorage : inTerminal;
    creep.memory.targetId = source.id;
    // Withdraw exactly what the lab needs — no more, to avoid haulers dumping
    // excess minerals back to storage on the delivery trip.
    const toWithdraw = Math.min(needed, creep.store.getFreeCapacity(), available);
    if (creep.withdraw(source, mineral, toWithdraw) === ERR_NOT_IN_RANGE) {
      moveTo(creep, source, {
        priority: PRIORITY_HAULER,
        visualizePathStyle: { stroke: '#00ff88' },
      });
    }
    return true;
  }
  return false;
}

function pickupLabOutput(creep: Creep, mem: RoomMemory | undefined): boolean {
  if (!mem?.labIds || !mem.inputLabIds) return false;
  const inputSet = new Set(mem.inputLabIds as Id<StructureLab>[]);
  for (const labId of mem.labIds) {
    if (inputSet.has(labId)) continue;
    const lab = Game.getObjectById(labId);
    if (!lab) continue;
    const mineralType = lab.mineralType;
    if (!mineralType || lab.store.getUsedCapacity(mineralType) === 0) continue;
    creep.memory.targetId = lab.id as Id<StructureLab>;
    if (creep.withdraw(lab, mineralType) === ERR_NOT_IN_RANGE) {
      moveTo(creep, lab, { priority: PRIORITY_HAULER, visualizePathStyle: { stroke: '#00ff88' } });
    }
    return true;
  }
  return false;
}

function pickupForTerminal(creep: Creep): boolean {
  const storage = creep.room.storage;
  const terminal = creep.room.terminal;
  if (!storage || !terminal || terminal.store.getFreeCapacity() < 1000) return false;

  for (const resource of Object.keys(storage.store) as ResourceConstant[]) {
    if (resource === RESOURCE_ENERGY) continue;
    if (storage.store.getUsedCapacity(resource) > MINERAL_STORAGE_FLOOR) {
      creep.memory.targetId = storage.id;
      if (creep.withdraw(storage, resource) === ERR_NOT_IN_RANGE) {
        moveTo(creep, storage, {
          priority: PRIORITY_HAULER,
          visualizePathStyle: { stroke: '#cc66ff' },
        });
      }
      return true;
    }
  }
  return false;
}

const SOURCE_CONTAINER_FULL_THRESHOLD = 1000;

function findFullSourceContainer(
  room: Room,
  mem: RoomMemory | undefined,
): StructureContainer | undefined {
  const controllerContainerId = mem?.controllerContainerId;
  const mineralContainerId = mem?.mineralContainerId;
  const containers = room.find(FIND_STRUCTURES, {
    filter: (s): s is StructureContainer =>
      s.structureType === STRUCTURE_CONTAINER &&
      s.id !== controllerContainerId &&
      s.id !== mineralContainerId &&
      s.store.getUsedCapacity(RESOURCE_ENERGY) >= SOURCE_CONTAINER_FULL_THRESHOLD,
  });
  if (containers.length === 0) return undefined;
  return containers.sort(
    (a, b) => b.store.getUsedCapacity(RESOURCE_ENERGY) - a.store.getUsedCapacity(RESOURCE_ENERGY),
  )[0];
}

function deliver(creep: Creep): void {
  // Non-energy resources: deliver to lab input, terminal, or storage
  if (creep.store.getUsedCapacity() > creep.store.getUsedCapacity(RESOURCE_ENERGY)) {
    if (deliverToLabInput(creep)) return;
    if (deliverToTerminalOrStorage(creep)) return;
  }

  if (deliverToSpawnOrExtension(creep)) return;

  const tower = creep.pos.findClosestByRange(FIND_MY_STRUCTURES, {
    filter: (s): s is StructureTower =>
      s.structureType === STRUCTURE_TOWER &&
      s.store.getFreeCapacity(RESOURCE_ENERGY) > s.store.getCapacity(RESOURCE_ENERGY) * 0.25,
  });
  if (tower) {
    if (creep.transfer(tower, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      moveTo(creep, tower, {
        priority: PRIORITY_HAULER,
        visualizePathStyle: { stroke: '#ffffff' },
      });
    }
    return;
  }

  if (deliverToControllerContainer(creep)) return;

  if (deliverToTerminalEnergy(creep)) return;

  const storage = creep.room.storage;

  if (storage && storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
    if (creep.transfer(storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      moveTo(creep, storage, {
        priority: PRIORITY_HAULER,
        visualizePathStyle: { stroke: '#ffffff' },
      });
    }
    return;
  }

  markIdle(creep);
}

function deliverToTerminalEnergy(creep: Creep): boolean {
  const terminal = creep.room.terminal;
  if (!terminal) return false;
  if (terminal.store.getUsedCapacity(RESOURCE_ENERGY) >= TERMINAL_ENERGY_FLOOR) return false;
  if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) return false;
  if (creep.transfer(terminal, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
    moveTo(creep, terminal, {
      priority: PRIORITY_HAULER,
      visualizePathStyle: { stroke: '#ffff00' },
    });
  }
  return true;
}

function deliverToLabInput(creep: Creep): boolean {
  const mem = Memory.rooms[creep.room.name];
  if (!mem?.activeReaction || !mem.inputLabIds) return false;
  const { input1, input2 } = mem.activeReaction;

  const resourceTypes = Object.keys(creep.store) as ResourceConstant[];
  for (const resource of resourceTypes) {
    if (resource === RESOURCE_ENERGY) continue;
    if (creep.store.getUsedCapacity(resource) === 0) continue;

    let targetLab: StructureLab | null = null;
    if (resource === input1) {
      targetLab = Game.getObjectById(mem.inputLabIds[0]);
    } else if (resource === input2) {
      targetLab = Game.getObjectById(mem.inputLabIds[1]);
    }

    if (targetLab && (targetLab.store.getFreeCapacity(resource) ?? 0) > 0) {
      if (creep.transfer(targetLab, resource) === ERR_NOT_IN_RANGE) {
        moveTo(creep, targetLab, {
          priority: PRIORITY_HAULER,
          visualizePathStyle: { stroke: '#00ff88' },
        });
      }
      return true;
    }
  }
  return false;
}

function deliverToTerminalOrStorage(creep: Creep): boolean {
  const resourceTypes = Object.keys(creep.store) as ResourceConstant[];
  const mineralType = resourceTypes.find(
    (r) => r !== RESOURCE_ENERGY && creep.store.getUsedCapacity(r) > 0,
  );
  if (!mineralType) return false;

  const storage = creep.room.storage;
  const terminal = creep.room.terminal;

  // Keep a working buffer in storage so pickupLabInput can load labs without
  // touching the terminal (which requires an extra trip across the room).
  if (storage && storage.store.getUsedCapacity(mineralType) < MINERAL_STORAGE_FLOOR) {
    if (creep.transfer(storage, mineralType) === ERR_NOT_IN_RANGE) {
      moveTo(creep, storage, {
        priority: PRIORITY_HAULER,
        visualizePathStyle: { stroke: '#cc66ff' },
      });
    }
    return true;
  }

  // Overflow to terminal
  if (terminal && terminal.store.getFreeCapacity() > 0) {
    if (creep.transfer(terminal, mineralType) === ERR_NOT_IN_RANGE) {
      moveTo(creep, terminal, {
        priority: PRIORITY_HAULER,
        visualizePathStyle: { stroke: '#cc66ff' },
      });
    }
    return true;
  }

  // Terminal full or absent — spill into storage
  if (storage) {
    if (creep.transfer(storage, mineralType) === ERR_NOT_IN_RANGE) {
      moveTo(creep, storage, {
        priority: PRIORITY_HAULER,
        visualizePathStyle: { stroke: '#cc66ff' },
      });
    }
    return true;
  }
  return false;
}
