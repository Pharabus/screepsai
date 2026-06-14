import { Role } from './Role';
import { moveTo } from '../utils/movement';
import { markIdle } from '../utils/idle';
import { PRIORITY_HAULER } from '../utils/trafficManager';
import { runStateMachine, StateMachineDefinition } from '../utils/stateMachine';
import { deliverToSpawnOrExtension, deliverToControllerContainer } from '../utils/delivery';
import { cached, getStructuresByType } from '../utils/tickCache';
import { assignHaulers } from '../managers/haulerPool';
import {
  MINERAL_STORAGE_FLOOR,
  TERMINAL_ENERGY_FLOOR,
  TERMINAL_RESTOCK_MIN_BATCH,
  FACTORY_ENERGY_FLOOR,
  BOOST_LAB_MINERAL_TARGET,
  BOOST_LAB_ENERGY_TARGET,
} from '../utils/thresholds';
import { myStorage, myTerminal } from '../utils/ownership';
import { colonyEnergy, upgradeBuffer } from '../utils/economy';
import { isLabHub, getLabHubName } from '../managers/labs';

/**
 * Storage buffer floor for minerals, keyed by whether this room is the lab hub.
 *
 * The hub keeps MINERAL_STORAGE_FLOOR (5000) in storage as a lab-input buffer
 * so pickupLabInput can load input labs directly without touching the terminal.
 * Feeder rooms keep none (floor = 0): all mined minerals should flow through
 * to the terminal so sendMineralsToHub can ship them to the hub. This also
 * drains any pre-existing stranded mineral stock from colony storage.
 *
 * The RESOURCE_BATTERY ? 0 : … guard in callers is preserved — batteries are
 * factory products for sale and always bypass the mineral buffer regardless of
 * room type.
 */
export function mineralStorageFloor(room: Room): number {
  return isLabHub(room) ? MINERAL_STORAGE_FLOOR : 0;
}

const STORAGE_LINK_DRAIN_THRESHOLD = 200;
// Only dispatch a hauler for lab minerals when the lab genuinely needs a
// refill batch. LAB_REACTION_AMOUNT (5) is far too small — it fired on every
// tick of reaction consumption, monopolising both haulers with micro-loads
// (800 units withdrawn to deliver 5) and starving energy logistics.
// At 5 energy consumed per reaction tick, 500 units = ~100 ticks of runway.
const MIN_LAB_LOAD = 500;
// When the storage link is permanently saturated (source links refilling it
// faster than one hauler can drain), drops near linked sources never get
// cleared because storage-link drain is higher priority than dropped energy.
// Once a pile crosses this size, treat it as decay-critical and preempt the
// link drain to clear it.
const LARGE_DROP_THRESHOLD = 1000;

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

/**
 * Withdraw directly from a foreign-owned bulk store (e.g. a reclaimed room's
 * previous-owner storage). This is lossless — withdraw() works on foreign
 * structures in a room we own, no WORK parts needed.
 *
 * Only runs when mem.lootTargetId is set and the structure is non-empty.
 * Minerals are only taken when we have an own storage or terminal to deposit
 * them into — mirrors the dropped-mineral guard at pickup lines ~252 and ~411.
 *
 * Returns true when claiming the task (even if not yet in range).
 */
function pickupForeignStore(creep: Creep, mem: RoomMemory | undefined): boolean {
  const lootId = mem?.lootTargetId;
  if (!lootId) return false;
  const target = Game.getObjectById(lootId);
  if (!target || !('store' in target)) return false;
  const store = (target as unknown as AnyStoreStructure).store;
  if (store.getUsedCapacity() === 0) return false;

  const room = creep.room;
  // Pick energy first; fall through to minerals only when no energy remains.
  let resource: ResourceConstant | undefined;
  if (store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
    resource = RESOURCE_ENERGY;
  } else {
    // Only withdraw a mineral when we have somewhere to deliver it (own store).
    // Without this guard the hauler would get permanently stuck in DELIVER with
    // no valid deposit target (young/reclaimed colony without own storage yet).
    if (!myStorage(room) && !myTerminal(room)) return false;
    const allTypes = Object.keys(store) as ResourceConstant[];
    resource = allTypes.find((r) => r !== RESOURCE_ENERGY && (store.getUsedCapacity(r) ?? 0) > 0);
  }
  if (!resource) return false;

  const targetStructure = target as unknown as AnyStoreStructure;
  creep.memory.targetId = targetStructure.id as Id<StructureStorage>;
  if (creep.withdraw(targetStructure, resource) === ERR_NOT_IN_RANGE) {
    moveTo(creep, targetStructure, {
      priority: PRIORITY_HAULER,
      visualizePathStyle: { stroke: '#ffaa00' },
    });
  }
  return true;
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

  // Boost-lab service normally ranks below the storage-link drain (see the
  // pickupBoostLab call further down). But source links refill the storage link
  // every tick, so when haulers are saturated the drain never yields and the
  // boost lab is never topped up — a creep then parks at the lab waiting for a
  // compound that sits unused in storage (observed live W43N58: 2 upgraders idle
  // ~500 ticks while 1.6k GH2O sat in storage). When (and only when) a creep is
  // actually awaiting that compound, preempt the link drain — and the existing
  // commitment — to service the lab. Bounded and self-limiting: pickupBoostLab
  // returns false once the lab is stocked, and the await check clears the moment
  // the creep is boosted, so normal link-first operation is untouched.
  if (
    mem?.boostLabId &&
    mem.boostCompound &&
    anyCreepAwaitingBoost(creep.room, mem.boostCompound) &&
    pickupBoostLab(creep, mem)
  ) {
    return true;
  }

  // Continue committed pickup task if still valid
  if (continueCommittedPickup(creep)) return true;

  // --- Priority chain for selecting a NEW pickup target ---

  // Drain storage link first — this is the primary pipeline bottleneck.
  // Large drops form BECAUSE the storage link is backed up (full source links →
  // miners spill to floor). Picking up drops while leaving the storage link full
  // creates a deadlock: the pipeline stays blocked, more drops form, and all
  // haulers keep chasing drops while the source links never clear. Fix the root
  // cause first; once the storage link drains, source links empty, miners can
  // deposit, and no new drops form.
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

  // Large dropped pile: only reached when the storage link is empty or
  // below threshold (pipeline is flowing), so picking up the drop is safe.
  if (pickupLargeDrop(creep)) return true;

  // Lab work: flushing/loading is otherwise starved when the storage link
  // keeps refilling above the drain threshold. Each branch returns false fast
  // when there's nothing to do. Cap at one hauler at a time.
  if (!isLabWorkClaimedByOther(creep, mem)) {
    if (pickupLabFlush(creep, mem)) return true;
    if (pickupLabInput(creep, mem)) return true;
    if (pickupLabOutput(creep, mem)) return true;
  }

  // Terminal → storage restock: when storage is in the deficit zone (below the
  // RCL upgrade buffer) and the terminal holds surplus above its standing floor,
  // pull energy back into storage so spawning and role logic can use it.
  // Only under holisticEconomy — flag-off leaves this path unreachable.
  if (pickupTerminalEnergyToStorage(creep)) return true;

  // Boost lab service — top up compound and energy in the reserved boost lab.
  // Runs after link drain so it doesn't starve the link pipeline, and before
  // generic dropped-energy / containers so the lab stays stocked.
  if (pickupBoostLab(creep, mem)) return true;

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

  // Dropped minerals (non-energy) — decay-sensitive, but only if deliverable.
  // Use ownership-aware guards: a foreign storage in a reclaimed room is NOT a
  // valid deposit target for minerals picked up by a hauler.
  const droppedMineral =
    myStorage(creep.room) || myTerminal(creep.room)
      ? creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, {
          filter: (r) => r.resourceType !== RESOURCE_ENERGY && r.amount >= 50,
        })
      : null;
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

  // Abandoned loot — ruins (500t decay) and tombstones (~5*body.length decay).
  // Sits below ground drops (faster decay) but above source containers, since
  // containers don't decay below 50% HP without nearby creeps and a full source
  // container can wait a few ticks while we collect a 4k-energy ruin.
  if (pickupAbandonedLoot(creep)) return true;

  // Full source containers (>= 1000 energy).
  // When the hauler pool is active, use the dispatcher's pre-computed assignment
  // instead of independently picking the globally-fullest container. If the pool
  // has no assignment for this hauler (or the assigned container is now empty),
  // fall through to the legacy fullest-first selection below.
  // Flag-off path is a true no-op — the pool block is never entered.
  if (Memory.haulerPool) {
    const poolAssignment = assignHaulers(creep.room);
    const assignedId = poolAssignment[creep.name];
    if (assignedId) {
      const container = Game.getObjectById(assignedId);
      if (container && container.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
        creep.memory.targetId = assignedId;
        if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
          moveTo(creep, container, {
            priority: PRIORITY_HAULER,
            visualizePathStyle: { stroke: '#ffaa00' },
          });
        }
        return true;
      }
      // Assigned container is now empty or gone — fall through to legacy logic
    }
    // No pool assignment — fall through to legacy logic
  }
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

  // Foreign store drain: directly withdraw from a reclaimed room's previous-owner
  // storage/terminal (lossless — withdraw() works on foreign structures in rooms
  // we own). Ranks LOW deliberately: a foreign storage is a non-decaying reserve,
  // so it is drained only after every decay-sensitive / fresh-income pickup —
  // floor drops, abandoned loot, and (critically) full source containers. Placing
  // it high starved the local economy: source containers overflowed to 2000 and
  // miner output decayed on the floor while haulers drained a hoard that loses
  // nothing by waiting (observed live in W42N59). It still outranks only partial
  // containers and minor banked pickups, so the hoard drains with spare capacity.
  if (pickupForeignStore(creep, mem)) return true;

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

  // Any source container with energy.
  // Pool check mirrors the one above: if the dispatcher has an assignment and
  // the container still has energy, use it. Otherwise legacy sorted selection.
  if (Memory.haulerPool) {
    const poolAssignment = assignHaulers(creep.room);
    const assignedId = poolAssignment[creep.name];
    if (assignedId) {
      const container = Game.getObjectById(assignedId);
      if (container && container.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
        creep.memory.targetId = assignedId;
        if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
          moveTo(creep, container, {
            priority: PRIORITY_HAULER,
            visualizePathStyle: { stroke: '#ffaa00' },
          });
        }
        return true;
      }
      // Assigned container empty/gone — fall through to legacy sorted selection
    }
    // No pool assignment — fall through to legacy sorted selection
  }
  const containersWithEnergy = (
    (getStructuresByType(creep.room)[STRUCTURE_CONTAINER] ?? []) as StructureContainer[]
  ).filter((s) => s.store.getUsedCapacity(RESOURCE_ENERGY) > 0);

  const controllerContainerId = mem?.controllerContainerId;
  const mineralContainerId = mem?.mineralContainerId;
  const sourceContainers = containersWithEnergy.filter(
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

  // Battery pickup from factory — deliver to terminal (preferred) or storage
  if (pickupFromFactory(creep)) return true;

  // Feeder lab evacuation: drain stale minerals from a feeder room's labs (all
  // labs, including input labs) so they can flow to storage → terminal →
  // sendMineralsToHub. Ranks LOW deliberately — same tier as pickupForTerminal
  // because feeder labs are a non-decaying reserve (no reactions running), so
  // they can wait until all energy logistics and decay-sensitive pickups clear.
  // Hub rooms are excluded (managed by their own flush/input/output paths).
  // Gated behind isLabWorkClaimedByOther so only one hauler drains at a time.
  if (!isLabWorkClaimedByOther(creep, mem)) {
    if (pickupFeederLabs(creep, mem)) return true;
  }

  // Terminal: move excess minerals from storage to terminal
  if (pickupForTerminal(creep)) return true;

  markIdle(creep);
  return false;
}

function pickupAbandonedLoot(creep: Creep): boolean {
  const ruin = creep.pos.findClosestByRange(FIND_RUINS, {
    filter: (r) => r.store.getUsedCapacity() > 0,
  });
  const tomb = creep.pos.findClosestByRange(FIND_TOMBSTONES, {
    filter: (t) => t.store.getUsedCapacity() > 0,
  });
  // Prefer whichever is closer — both decay, but the closer trip costs less.
  const target: Ruin | Tombstone | null =
    ruin && tomb
      ? creep.pos.getRangeTo(ruin) <= creep.pos.getRangeTo(tomb)
        ? ruin
        : tomb
      : (ruin ?? tomb);
  if (!target) return false;
  const resource = pickWithdrawResource(target as unknown as AnyStoreStructure);
  if (!resource) return false;
  // Don't pick up non-energy minerals when the room has nowhere OWN to deliver them.
  // Young colonies and reclaimed rooms without own storage/terminal would get
  // permanently stuck in DELIVER (foreign storage is not a valid mineral deposit).
  if (resource !== RESOURCE_ENERGY && !myStorage(creep.room) && !myTerminal(creep.room))
    return false;
  creep.memory.targetId = target.id;
  if (creep.withdraw(target, resource) === ERR_NOT_IN_RANGE) {
    moveTo(creep, target, {
      priority: PRIORITY_HAULER,
      visualizePathStyle: { stroke: resource === RESOURCE_ENERGY ? '#ffaa00' : '#cc66ff' },
    });
  }
  return true;
}

function pickupLargeDrop(creep: Creep): boolean {
  const drop = creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, {
    filter: (r) => r.resourceType === RESOURCE_ENERGY && r.amount >= LARGE_DROP_THRESHOLD,
  });
  if (!drop) return false;
  creep.memory.targetId = drop.id;
  if (creep.pickup(drop) === ERR_NOT_IN_RANGE) {
    moveTo(creep, drop, {
      priority: PRIORITY_HAULER,
      visualizePathStyle: { stroke: '#ffaa00' },
    });
  }
  return true;
}

function isLabWorkClaimedByOther(creep: Creep, mem: RoomMemory | undefined): boolean {
  if (!mem?.labIds || mem.labIds.length === 0) return false;
  const labIds = new Set<string>(mem.labIds);
  // Compute the {claimerName, targetId} once per room per tick instead of per-hauler.
  const claimInfo = cached(
    `hauler:labClaimed:${creep.room.name}`,
    (): { name: string; targetId: string } | undefined => {
      for (const c of Object.values(Game.creeps)) {
        if (c.memory.role !== 'hauler') continue;
        if (c.room.name !== creep.room.name) continue;
        if (c.memory.targetId && labIds.has(c.memory.targetId)) {
          return { name: c.name, targetId: c.memory.targetId };
        }
      }
      return undefined;
    },
  );
  if (!claimInfo) return false;
  // The current hauler is not "other" to itself
  return claimInfo.name !== creep.name;
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

/**
 * Service the reserved boost lab: top it up with its compound (from storage,
 * then terminal) and energy (from storage). Gated entirely on boostLabId AND
 * boostCompound being set in RoomMemory — inert when either is absent.
 *
 * Priority: after lab flush/input/output and after storage-link drain, but
 * before generic dropped-energy and source containers. This placement means
 * the boost lab is serviced promptly while still losing to urgent spawn-energy
 * and decay-critical large drops, matching the existing lab priority slot.
 */
/**
 * True when at least one creep in `room` is still waiting for a boost of
 * `compound` (its memory.boosts lists that compound). Cached per room per tick.
 * Drives the boost-lab-service-preempts-link-drain decision in pickup().
 */
function anyCreepAwaitingBoost(room: Room, compound: ResourceConstant): boolean {
  return cached(`hauler:awaitingBoost:${room.name}`, () => {
    for (const c of Object.values(Game.creeps)) {
      const boosts = c.memory?.boosts;
      if (!boosts || !boosts.some((b) => b.compound === compound)) continue;
      if (c.room?.name !== room.name) continue;
      return true;
    }
    return false;
  });
}

function pickupBoostLab(creep: Creep, mem: RoomMemory | undefined): boolean {
  if (!mem?.boostLabId || !mem.boostCompound) return false;
  const lab = Game.getObjectById(mem.boostLabId);
  if (!lab) return false;

  const compound = mem.boostCompound;

  // Flush guard: if the lab holds a different mineral type, withdraw it so the
  // lab can accept GH2O. Without this an upgrader would stall at the lab forever
  // waiting for a compound that can never be loaded (labs hold only one type).
  if (
    lab.mineralType &&
    lab.mineralType !== compound &&
    (lab.store.getUsedCapacity(lab.mineralType) ?? 0) > 0
  ) {
    const wrongMineral = lab.mineralType;
    creep.memory.targetId = lab.id as Id<StructureLab>;
    if (creep.withdraw(lab, wrongMineral) === ERR_NOT_IN_RANGE) {
      moveTo(creep, lab, {
        priority: PRIORITY_HAULER,
        visualizePathStyle: { stroke: '#ff88ff' },
      });
    }
    return true;
  }

  // Needs compound?
  const compoundStored = lab.store.getUsedCapacity(compound) ?? 0;
  if (compoundStored < BOOST_LAB_MINERAL_TARGET) {
    const storage = creep.room.storage;
    const terminal = creep.room.terminal;
    const inStorage = storage?.store.getUsedCapacity(compound) ?? 0;
    const inTerminal = terminal?.store.getUsedCapacity(compound) ?? 0;
    const source: StructureStorage | StructureTerminal | null =
      inStorage > 0 ? (storage ?? null) : inTerminal > 0 ? (terminal ?? null) : null;
    if (source) {
      const needed = BOOST_LAB_MINERAL_TARGET - compoundStored;
      const available = inStorage > 0 ? inStorage : inTerminal;
      const toWithdraw = Math.min(needed, creep.store.getFreeCapacity(), available);
      if (toWithdraw > 0) {
        creep.memory.targetId = source.id;
        if (creep.withdraw(source, compound, toWithdraw) === ERR_NOT_IN_RANGE) {
          moveTo(creep, source, {
            priority: PRIORITY_HAULER,
            visualizePathStyle: { stroke: '#ff88ff' },
          });
        }
        return true;
      }
    }
  }

  // Needs energy?
  const energyStored = lab.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0;
  if (energyStored < BOOST_LAB_ENERGY_TARGET) {
    const storage = creep.room.storage;
    if (storage && (storage.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0) > 0) {
      creep.memory.targetId = storage.id;
      if (creep.withdraw(storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        moveTo(creep, storage, {
          priority: PRIORITY_HAULER,
          visualizePathStyle: { stroke: '#ff88ff' },
        });
      }
      return true;
    }
  }

  return false;
}

/**
 * Drain stale minerals from a feeder room's labs (all labs, including input
 * labs). A feeder room does not run reactions; runLabs clears activeReaction on
 * it so deliverToLabInput will not re-deposit the withdrawn mineral. The
 * drained mineral falls through to deliverToTerminalOrStorage and is eventually
 * shipped to the hub by sendMineralsToHub.
 *
 * Only fires in non-hub rooms that have a hub elsewhere (i.e. this is genuinely
 * a feeder). Hub rooms manage their own labs via the flush/input/output paths.
 * Returns false fast when: this is the hub, no hub exists (single-room empire),
 * or labIds is absent.
 */
function pickupFeederLabs(creep: Creep, mem: RoomMemory | undefined): boolean {
  // Only drain when a hub exists somewhere and this room is NOT it.
  if (!getLabHubName()) return false;
  if (isLabHub(creep.room)) return false;
  if (!mem?.labIds) return false;

  for (const labId of mem.labIds) {
    const lab = Game.getObjectById(labId as Id<StructureLab>);
    if (!lab) continue;
    const mineralType = lab.mineralType;
    if (!mineralType || (lab.store.getUsedCapacity(mineralType) ?? 0) === 0) continue;
    creep.memory.targetId = lab.id as Id<StructureLab>;
    if (creep.withdraw(lab, mineralType) === ERR_NOT_IN_RANGE) {
      moveTo(creep, lab, {
        priority: PRIORITY_HAULER,
        visualizePathStyle: { stroke: '#cc66ff' },
      });
    }
    return true;
  }
  return false;
}

function pickupForTerminal(creep: Creep): boolean {
  // Use ownership-aware helpers so we only move minerals from OUR storage to OUR terminal.
  const storage = myStorage(creep.room);
  const terminal = myTerminal(creep.room);
  if (!storage || !terminal || terminal.store.getFreeCapacity() < 1000) return false;

  for (const resource of Object.keys(storage.store) as ResourceConstant[]) {
    if (resource === RESOURCE_ENERGY) continue;
    // Batteries are factory products meant to be sold, not lab stockpile — always flow to terminal.
    // Non-hub rooms use a floor of 0 (mineralStorageFloor) so all minerals flow to the terminal
    // for shipment to the hub; the hub keeps MINERAL_STORAGE_FLOOR as a lab-input buffer.
    const floor = resource === RESOURCE_BATTERY ? 0 : mineralStorageFloor(creep.room);
    const available = storage.store.getUsedCapacity(resource);
    if (available > floor) {
      creep.memory.targetId = storage.id;
      // Withdraw only the SURPLUS above the floor. A full-capacity withdraw drops
      // storage below the floor, and deliverToTerminalOrStorage then routes the
      // load straight back to storage (storage < floor → storage branch) — a
      // futile pull/redeposit loop observed live with GH2O. Mirrors the bounded
      // withdraw in pickupLabInput.
      const toWithdraw = Math.min(creep.store.getFreeCapacity(), available - floor);
      if (toWithdraw <= 0) continue;
      if (creep.withdraw(storage, resource, toWithdraw) === ERR_NOT_IN_RANGE) {
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

function pickupFromFactory(creep: Creep): boolean {
  const mem = Memory.rooms[creep.room.name];
  if (!mem?.factoryId) return false;
  const factory = Game.getObjectById(mem.factoryId);
  if (!factory) return false;
  const batteries = factory.store.getUsedCapacity(RESOURCE_BATTERY) ?? 0;
  if (batteries === 0) return false;
  creep.memory.targetId = factory.id;
  if (creep.withdraw(factory, RESOURCE_BATTERY) === ERR_NOT_IN_RANGE) {
    moveTo(creep, factory, {
      priority: PRIORITY_HAULER,
      visualizePathStyle: { stroke: '#cc66ff' },
    });
  }
  return true;
}

const SOURCE_CONTAINER_FULL_THRESHOLD = 1000;

function findFullSourceContainer(
  room: Room,
  mem: RoomMemory | undefined,
): StructureContainer | undefined {
  const controllerContainerId = mem?.controllerContainerId;
  const mineralContainerId = mem?.mineralContainerId;
  const containers = (
    (getStructuresByType(room)[STRUCTURE_CONTAINER] ?? []) as StructureContainer[]
  ).filter(
    (s) =>
      s.id !== controllerContainerId &&
      s.id !== mineralContainerId &&
      s.store.getUsedCapacity(RESOURCE_ENERGY) >= SOURCE_CONTAINER_FULL_THRESHOLD,
  );
  if (containers.length === 0) return undefined;
  return containers.sort(
    (a, b) => b.store.getUsedCapacity(RESOURCE_ENERGY) - a.store.getUsedCapacity(RESOURCE_ENERGY),
  )[0];
}

function deliver(creep: Creep): void {
  // Non-energy resources: deliver to lab input, terminal, or storage.
  // If the room has no storage or terminal (young colony), drop the mineral rather
  // than getting permanently stuck in DELIVER with no valid target.
  if (creep.store.getUsedCapacity() > creep.store.getUsedCapacity(RESOURCE_ENERGY)) {
    if (deliverToBoostLab(creep)) return;
    if (deliverToLabInput(creep)) return;
    if (deliverToTerminalOrStorage(creep)) return;
    const mineralType = (Object.keys(creep.store) as ResourceConstant[]).find(
      (r) => r !== RESOURCE_ENERGY && creep.store.getUsedCapacity(r) > 0,
    );
    if (mineralType) {
      creep.drop(mineralType);
      return;
    }
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

  if (deliverToFactory(creep)) return;

  if (deliverToBoostLab(creep)) return;

  if (deliverToControllerContainer(creep)) return;

  if (deliverToTerminalEnergy(creep)) return;

  // Only deposit into OWN storage — a foreign storage in a reclaimed room must
  // not receive our energy (it has a separate owner and would void it on destroy).
  const storage = myStorage(creep.room);

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
  // Only deposit into OWN terminal — a foreign terminal in a reclaimed room must
  // not receive our energy.
  const terminal = myTerminal(creep.room);
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

/**
 * Holistic economy path (Memory.holisticEconomy only): restock storage from
 * terminal when storage is below the RCL upgrade buffer.
 *
 * Energy arriving via sendEnergyToColonies lands in the terminal, where it is
 * economically visible (colonyEnergy counts it) but operationally inert —
 * spawning, body-sizing, and role-logic gates all read storage. When storage
 * drops below upgradeBuffer(room) but the terminal has surplus, haulers pull
 * energy terminal → storage so the room can actually spend its budget.
 *
 * Never drains terminal below TERMINAL_ENERGY_FLOOR (needed for market ops).
 * No single-hauler rate-limit: storage is large and parallel restock is fine.
 */
function pickupTerminalEnergyToStorage(creep: Creep): boolean {
  if (!Memory.holisticEconomy) return false;
  const storage = myStorage(creep.room);
  const terminal = myTerminal(creep.room);
  if (!storage || !terminal) return false;
  if (storage.store.getUsedCapacity(RESOURCE_ENERGY) >= upgradeBuffer(creep.room)) return false;
  const terminalE = terminal.store.getUsedCapacity(RESOURCE_ENERGY);
  if (terminalE <= TERMINAL_ENERGY_FLOOR + TERMINAL_RESTOCK_MIN_BATCH) return false;
  const amount = Math.min(creep.store.getFreeCapacity(), terminalE - TERMINAL_ENERGY_FLOOR);
  if (amount <= 0) return false;
  creep.memory.targetId = terminal.id;
  if (creep.withdraw(terminal, RESOURCE_ENERGY, amount) === ERR_NOT_IN_RANGE) {
    moveTo(creep, terminal, {
      priority: PRIORITY_HAULER,
      visualizePathStyle: { stroke: '#ffff00' },
    });
  }
  return true;
}

function deliverToFactory(creep: Creep): boolean {
  const mem = Memory.rooms[creep.room.name];
  if (!mem?.factoryId || !mem.factoryRecipe) return false;
  if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) return false;
  // Guard on OWN energy — a foreign storage's energy is not ours to account for.
  // Under holisticEconomy, terminal energy counts toward the budget so a room
  // with storage+terminal > 120k correctly delivers to the factory.
  // Flag-off: existing myStorage-only check (unchanged).
  const storageOk = Memory.holisticEconomy
    ? colonyEnergy(creep.room) > FACTORY_ENERGY_FLOOR
    : (() => {
        const storage = myStorage(creep.room);
        return !!storage && storage.store.getUsedCapacity(RESOURCE_ENERGY) > FACTORY_ENERGY_FLOOR;
      })();
  if (!storageOk) return false;
  const factory = Game.getObjectById(mem.factoryId);
  if (!factory) return false;
  if ((factory.store.getFreeCapacity(RESOURCE_ENERGY) ?? 0) === 0) return false;
  if (creep.transfer(factory, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
    moveTo(creep, factory, {
      priority: PRIORITY_HAULER,
      visualizePathStyle: { stroke: '#ffaa00' },
    });
  }
  return true;
}

function deliverToBoostLab(creep: Creep): boolean {
  const mem = Memory.rooms[creep.room.name];
  if (!mem?.boostLabId || !mem.boostCompound) return false;
  const lab = Game.getObjectById(mem.boostLabId);
  if (!lab) return false;

  const compound = mem.boostCompound;

  // If carrying the boost compound, deliver it to the lab
  if ((creep.store.getUsedCapacity(compound) ?? 0) > 0) {
    if ((lab.store.getFreeCapacity(compound) ?? 0) > 0) {
      if (creep.transfer(lab, compound) === ERR_NOT_IN_RANGE) {
        moveTo(creep, lab, {
          priority: PRIORITY_HAULER,
          visualizePathStyle: { stroke: '#ff88ff' },
        });
      }
      return true;
    }
  }

  // If carrying energy and the lab needs energy, deliver it
  if ((creep.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0) > 0) {
    const energyStored = lab.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0;
    if (
      energyStored < BOOST_LAB_ENERGY_TARGET &&
      (lab.store.getFreeCapacity(RESOURCE_ENERGY) ?? 0) > 0
    ) {
      if (creep.transfer(lab, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        moveTo(creep, lab, {
          priority: PRIORITY_HAULER,
          visualizePathStyle: { stroke: '#ff88ff' },
        });
      }
      return true;
    }
  }

  return false;
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

  // Use ownership-aware helpers: deposits must not flow into a foreign storage/terminal
  // (e.g. previous owner's structures in a reclaimed room).
  const storage = myStorage(creep.room);
  const terminal = myTerminal(creep.room);

  // Keep a working buffer in storage so pickupLabInput can load labs without
  // touching the terminal (which requires an extra trip across the room).
  // Batteries are factory products for sale — no lab buffer needed, skip to terminal.
  // Non-hub rooms use floor 0 (mineralStorageFloor) so minerals flow directly to the
  // terminal for hub shipment; the hub keeps MINERAL_STORAGE_FLOOR as its lab buffer.
  const deliverFloor = mineralType === RESOURCE_BATTERY ? 0 : mineralStorageFloor(creep.room);
  if (storage && storage.store.getUsedCapacity(mineralType) < deliverFloor) {
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

  // Terminal full or absent — spill into own storage
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
