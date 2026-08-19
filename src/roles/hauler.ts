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
  TERMINAL_ENERGY_FLOOR_COLONY,
  TERMINAL_RESTOCK_MIN_BATCH,
  FACTORY_ENERGY_FLOOR,
  BOOST_LAB_MINERAL_TARGET,
  BOOST_LAB_ENERGY_TARGET,
  ENERGY_TERMINAL_RECOVERY_TARGET,
  POWER_SPAWN_ENERGY_FLOOR,
  POWER_SPAWN_POWER_REFILL_THRESHOLD,
} from '../utils/thresholds';
import { myStorage, myTerminal } from '../utils/ownership';
import { colonyEnergy, upgradeBuffer } from '../utils/economy';
import { isLabHub, getLabHubName } from '../managers/labs';
import { HOME_SURPLUS_FLOOR } from '../managers/terminal';
import { compoundInTransit } from '../utils/boost';

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
const STORAGE_LINK_HIGH_WATER = 600;
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
// A hauler with this much free capacity or less is considered effectively full:
// don't chase the last few units from an unreachable pickup — just deliver.
// One CARRY part (50) is the granularity floor; a 94%+ loaded hauler wastes
// a round trip chasing the tail sliver.
const HAULER_EFFECTIVELY_FULL_FREE = 50;

interface HaulerRoomScan {
  droppedEnergy: Resource[];
  droppedMineral: Resource[];
  ruins: Ruin[];
  tombs: Tombstone[];
  towersNeedingEnergy: StructureTower[];
}

// Mirrors remoteHauler.ts's getPickupCandidates: the qualifying-object lists
// below are position-independent (same for every hauler in the room), but
// were previously re-scanned via findClosestByRange by EACH hauler on EVERY
// call to pickup()/deliver() that reached them — with 16 haulers in one room
// that's up to ~5 duplicate room.find()-class scans per hauler per tick.
// Cached once per room per tick; each hauler still does its own cheap
// "closest to me" pass over the small cached arrays via closestByRange.
function getRoomScan(room: Room): HaulerRoomScan {
  return cached(`hauler:roomScan:${room.name}`, () => {
    const dropped = room.find(FIND_DROPPED_RESOURCES);
    const droppedEnergy = dropped.filter(
      (r) => r.resourceType === RESOURCE_ENERGY && r.amount >= 50,
    );
    const droppedMineral = dropped.filter(
      (r) => r.resourceType !== RESOURCE_ENERGY && r.amount >= 50,
    );
    const ruins = room.find(FIND_RUINS).filter((r) => r.store.getUsedCapacity() > 0);
    const tombs = room.find(FIND_TOMBSTONES).filter((t) => t.store.getUsedCapacity() > 0);
    const towersNeedingEnergy = (
      (getStructuresByType(room)[STRUCTURE_TOWER] ?? []) as StructureTower[]
    ).filter(
      (s) => s.store.getFreeCapacity(RESOURCE_ENERGY) > s.store.getCapacity(RESOURCE_ENERGY) * 0.25,
    );
    return { droppedEnergy, droppedMineral, ruins, tombs, towersNeedingEnergy };
  });
}

function closestByRange<T extends { pos: RoomPosition }>(
  pos: RoomPosition,
  candidates: T[],
): T | undefined {
  let best: T | undefined;
  let bestRange = Infinity;
  for (const c of candidates) {
    const range = pos.getRangeTo(c.pos);
    if (range < bestRange) {
      bestRange = range;
      best = c;
    }
  }
  return best;
}

const states: StateMachineDefinition = {
  PICKUP: {
    onEnter(creep) {
      delete creep.memory.targetId;
    },
    run(creep) {
      // (1) The urgent responder rushes energy to a starved spawn — if it ALREADY carries
      //     energy, deliver it now rather than detouring to storage for more. Otherwise it
      //     pins in COLLECT trying to top off from a storage it can't reach when the core
      //     approach is congested (observed live W44N57: a 793/800 responder stuck at 27,3,
      //     never delivering, target oscillating between unreachable pickups).
      if (creep.store.getUsedCapacity() > 0 && getUrgentResponder(creep.room) === creep.name) {
        return 'DELIVER';
      }
      // (2) Effectively full: don't chase the last few units (deadlocks when the pickup is
      //     unreachable). Replaces the exact `=== 0` check.
      if (creep.store.getFreeCapacity() <= HAULER_EFFECTIVELY_FULL_FREE) return 'DELIVER';
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
  if (mem?.boostLabId && mem.boostCompound) {
    const awaiting = anyCreepAwaitingBoost(creep.room, mem.boostCompound);
    if (Memory.boostDebug && awaiting) {
      console.log(
        `[boostDebug] hauler ${creep.name} @${Game.time} preempt: awaiting=${awaiting} empty=${creep.store.getUsedCapacity() === 0}`,
      );
    }
    if (awaiting && pickupBoostLab(creep, mem)) {
      if (Memory.boostDebug) {
        console.log(
          `[boostDebug] hauler ${creep.name} @${Game.time} preempt FIRED -> servicing boost lab`,
        );
      }
      return true;
    }
  }

  // Lab-flush preempt: when runLabs is switching reactions it sets labFlushing so a
  // hauler clears stale minerals from the input labs before the new inputs load. That
  // flush (pickupLabFlush, ranked below the link drain) is starved when source links keep
  // the storage link above the drain threshold every tick — so the reaction transition
  // hangs. Like the boost-lab preempt above, service the flush ahead of the link drain,
  // but ONLY while flushing (a finite ~2-trip job) and ONLY one hauler at a time (the
  // existing lab-work cap) so the whole fleet doesn't abandon the link for it.
  if (
    mem?.labFlushing &&
    !isLabWorkClaimedByOther(creep, mem) &&
    creep.store.getFreeCapacity() > 0
  ) {
    if (pickupLabFlush(creep, mem)) return true;
  }

  // Terminal deadlock preempt: a terminal at 0 free capacity with energy below
  // ENERGY_TERMINAL_RECOVERY_TARGET can never recover on its own — every transfer() into
  // it fails with ERR_FULL (so deliverToTerminalEnergy can no longer seed it,
  // see the fix above) and every sell/buy/send requires enough energy already
  // present to pay its fee. Break the cycle by pulling some of the terminal's
  // largest mineral stack back into storage, which always has ample room.
  // Gated to empty haulers (a "pick a new job" preempt) and to the exact
  // deadlock condition so it's inert in normal operation. MUST rank above the
  // storage-link high-water preempt below — that one claims almost every empty
  // hauler on a normal tick (the source-link faucet keeps the storage link near
  // its high-water mark continuously), so placing this preempt after it left
  // the deadlock-breaker permanently starved of a turn, the same class of bug
  // documented on the boost-lab and lab-flush preempts below (observed live:
  // W43N58's terminal sat completely full with this fix deployed but never once
  // fired because every empty hauler kept getting redirected to the link first).
  if (creep.store.getUsedCapacity() === 0 && pickupTerminalOverflow(creep)) return true;

  // Storage-link high-water preempt: the normal link drain (STORAGE_LINK_DRAIN_THRESHOLD)
  // sits below continueCommittedPickup, so once a hauler commits to a distant source drop
  // it won't re-check the link for the whole round trip. With far sources (W44N57,
  // pathDist 25-30) the link refills to near-full behind the committed hauler and stays
  // there — source links can't transmit into a full storage link, containers overflow,
  // miners spill to the floor, and the bigger drops keep haulers committed. When the link
  // is near full (can no longer absorb a source-link transmit), drain it even mid-commitment.
  // Gated to EMPTY haulers: one already carrying energy should finish its commitment, and an
  // empty hauler en route to a drop is exactly the one to redirect (no hauled load wasted).
  if (mem?.storageLinkId && creep.store.getUsedCapacity() === 0) {
    const link = Game.getObjectById(mem.storageLinkId);
    if (link && link.store.getUsedCapacity(RESOURCE_ENERGY) >= STORAGE_LINK_HIGH_WATER) {
      creep.memory.targetId = link.id;
      if (creep.withdraw(link, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        moveTo(creep, link, {
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
    // Feeder lab evacuation: a feeder room runs NO reaction (runLabs clears
    // activeReaction on feeders), so the three lab branches above never service
    // its labs — they hold only stale leftover minerals from before the room
    // became a feeder. Drain them HERE, alongside lab work, rather than at the
    // bottom of the pickup chain: the old low rank meant a permanently-busy
    // feeder's haulers never fell through to it, so the stale mineral sat forever
    // (observed live: W44N57 lab pinned at Z:1302 for hours). The drain is a
    // one-time finite job (~2 trips for a full lab), so the elevated priority
    // can't perpetually divert haulers — once empty it returns false for good.
    if (!mem?.activeReaction && pickupFeederLabs(creep, mem)) return true;
  }

  // Factory work: feed the active recipe's non-energy components (silicon
  // chain — utrium_bar, silicon). Inert for the battery recipe (no non-energy
  // components) and whenever factoryRecipe is unset. Same tier as lab work
  // above — an active production process, not urgent enough to preempt it.
  if (pickupFactoryInput(creep, mem)) return true;

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
  const dropped = closestByRange(creep.pos, getRoomScan(creep.room).droppedEnergy);
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
      ? closestByRange(creep.pos, getRoomScan(creep.room).droppedMineral)
      : undefined;
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

  // (Feeder-lab evacuation now runs in the lab-work block above — see there.)

  // Terminal: move excess minerals from storage to terminal
  if (pickupForTerminal(creep)) return true;

  // Power spawn refill — lowest priority of all, see doc comment above.
  if (pickupPowerForSpawn(creep)) return true;

  markIdle(creep);
  return false;
}

function pickupAbandonedLoot(creep: Creep): boolean {
  const scan = getRoomScan(creep.room);
  const ruin = closestByRange(creep.pos, scan.ruins);
  const tomb = closestByRange(creep.pos, scan.tombs);
  // Prefer whichever is closer — both decay, but the closer trip costs less.
  const target: Ruin | Tombstone | undefined =
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
  // LARGE_DROP_THRESHOLD (1000) is a subset of the >=50 droppedEnergy scan —
  // filter the cached list rather than re-scanning.
  const large = getRoomScan(creep.room).droppedEnergy.filter(
    (r) => r.amount >= LARGE_DROP_THRESHOLD,
  );
  const drop = closestByRange(creep.pos, large);
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
 * Feeds the factory's active recipe (mem.factoryRecipe, set by runFactory)
 * with whichever non-energy component it's short on — the silicon-chain
 * counterpart to pickupLabInput. Only reads COMMODITIES' component list, so
 * it works for any recipe runFactory ever selects (utrium_bar, wire, battery
 * has no non-energy components so this is simply inert for it) without
 * needing per-recipe cases here.
 */
function pickupFactoryInput(creep: Creep, mem: RoomMemory | undefined): boolean {
  if (!mem?.factoryId || !mem.factoryRecipe) return false;
  const recipe = COMMODITIES[mem.factoryRecipe as keyof typeof COMMODITIES];
  if (!recipe) return false;
  const factory = Game.getObjectById(mem.factoryId);
  if (!factory) return false;
  const storage = creep.room.storage;
  const terminal = creep.room.terminal;
  if (!storage && !terminal) return false;

  for (const component of Object.keys(recipe.components) as ResourceConstant[]) {
    if (component === RESOURCE_ENERGY) continue;
    const need = recipe.components[component as keyof typeof recipe.components] ?? 0;
    const inFactory = factory.store.getUsedCapacity(component) ?? 0;
    if (inFactory >= need) continue; // factory already holds enough for this batch

    const inStorage = storage?.store.getUsedCapacity(component) ?? 0;
    const inTerminal = terminal?.store.getUsedCapacity(component) ?? 0;
    const source: StructureStorage | StructureTerminal | null =
      inStorage > 0 ? (storage ?? null) : inTerminal > 0 ? (terminal ?? null) : null;
    if (!source) continue; // don't have this component anywhere — try the next one

    const available = inStorage > 0 ? inStorage : inTerminal;
    creep.memory.targetId = source.id;
    const toWithdraw = Math.min(
      need - inFactory,
      creep.store.getFreeCapacity(),
      available,
      factory.store.getFreeCapacity(component) ?? 0,
    );
    if (toWithdraw <= 0) continue;
    if (creep.withdraw(source, component, toWithdraw) === ERR_NOT_IN_RANGE) {
      moveTo(creep, source, {
        priority: PRIORITY_HAULER,
        visualizePathStyle: { stroke: '#00ff88' },
      });
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

  // Needs compound? Account for compound already in transit in OTHER haulers so
  // multiple haulers don't all commit to fill the same lab — two each grabbing
  // 800 would drain storage far below the boost-reservation threshold (the very
  // race that unreserved the lab; see compoundInTransit / upgraderBoostWanted).
  const compoundStored = lab.store.getUsedCapacity(compound) ?? 0;
  const inTransitOther =
    compoundInTransit(creep.room, compound) - (creep.store.getUsedCapacity(compound) ?? 0);
  if (compoundStored + inTransitOther < BOOST_LAB_MINERAL_TARGET) {
    const storage = creep.room.storage;
    const terminal = creep.room.terminal;
    const inStorage = storage?.store.getUsedCapacity(compound) ?? 0;
    const inTerminal = terminal?.store.getUsedCapacity(compound) ?? 0;
    const source: StructureStorage | StructureTerminal | null =
      inStorage > 0 ? (storage ?? null) : inTerminal > 0 ? (terminal ?? null) : null;
    if (source) {
      const needed = BOOST_LAB_MINERAL_TARGET - compoundStored - inTransitOther;
      const available = inStorage > 0 ? inStorage : inTerminal;
      const toWithdraw = Math.min(needed, creep.store.getFreeCapacity(), available);
      if (Memory.boostDebug) {
        console.log(
          `[boostDebug] pickupBoostLab ${creep.name} @${Game.time} compoundBranch labGH2O=${compoundStored} inTransitOther=${inTransitOther} needed=${needed} avail=${available} free=${creep.store.getFreeCapacity()} toWithdraw=${toWithdraw} carry=${creep.store.getUsedCapacity()}`,
        );
      }
      if (toWithdraw > 0) {
        creep.memory.targetId = source.id;
        const wr = creep.withdraw(source, compound, toWithdraw);
        if (Memory.boostDebug) {
          console.log(
            `[boostDebug] pickupBoostLab ${creep.name} @${Game.time} withdraw(${compound},${toWithdraw}) -> ${wr} (range to source ${creep.pos.getRangeTo(source)})`,
          );
        }
        if (wr === ERR_NOT_IN_RANGE) {
          moveTo(creep, source, {
            priority: PRIORITY_HAULER,
            visualizePathStyle: { stroke: '#ff88ff' },
          });
        }
        return true;
      }
    }
  } else if (Memory.boostDebug) {
    console.log(
      `[boostDebug] pickupBoostLab ${creep.name} @${Game.time} SKIP compoundBranch labGH2O=${compoundStored} inTransitOther=${inTransitOther} (>= target ${BOOST_LAB_MINERAL_TARGET})`,
    );
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
 *
 * Called from the lab-work block (gated on no activeReaction) so it drains
 * promptly even in a busy feeder. It previously sat at the bottom of the pickup
 * chain, where a permanently-busy room's haulers never reached it and the stale
 * mineral sat indefinitely (live: W44N57 Z:1302). The job is finite (~2 trips
 * per lab), so the higher priority self-limits — it returns false once drained.
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

/**
 * Terminal deadlock breaker. A terminal at 0 free capacity with energy below
 * ENERGY_TERMINAL_RECOVERY_TARGET is permanently stuck: no transfer can add
 * energy (ERR_FULL on any resource) and no deal (sell/buy/send) can fire
 * without enough energy already present to pay its fee. Withdraws the
 * terminal's single largest resource stack back into storage — which always
 * has ample room — freeing enough capacity for the next hauler cycle to seed
 * the terminal with energy via deliverToTerminalEnergy and let
 * sellSurplus/sendMineralsToHub/buyForLabs resume.
 *
 * Checks against ENERGY_TERMINAL_RECOVERY_TARGET, not ENERGY_TERMINAL_BUFFER
 * and not literally zero: a single withdrawal only frees room for one
 * hauler's worth of energy (typically far short of the target), and free
 * capacity collapses back to 0 the instant that energy lands — so gating on
 * "== 0 energy" stops this from running again after the first partial
 * success, permanently stalling at whatever partial amount arrived. Gating on
 * ENERGY_TERMINAL_BUFFER itself (5000) has the same failure mode one step
 * later: every fee-gated consumer needs *more* than that buffer to actually
 * fire (buffer + transaction cost), so a breaker that stops exactly at the
 * buffer leaves zero headroom and the terminal parks there forever (observed
 * live: W43N58 pinned at exactly 300000/300000 with energy exactly 5000 for
 * an extended period — this function, pickupForTerminal's reservation, and
 * sendMineralsToHub's hub-side reservation all treated "energy ==
 * ENERGY_TERMINAL_BUFFER" as "done" simultaneously, so all three stopped
 * protecting capacity at once and minerals refilled the terminal before
 * energy could climb past any fee gate). ENERGY_TERMINAL_RECOVERY_TARGET
 * (10000) leaves real headroom above the buffer so a typical fee can clear.
 *
 * Stamps forceStorageDelivery so the DELIVER state dumps the load straight
 * into storage rather than letting deliverToTerminalOrStorage's normal
 * floor-based routing send it right back into the capacity just freed (that
 * routing only avoids the terminal when the resource's storage stock is below
 * its floor — not guaranteed for whichever resource happens to be largest).
 */
function pickupTerminalOverflow(creep: Creep): boolean {
  const terminal = myTerminal(creep.room);
  const storage = myStorage(creep.room);
  if (!terminal || !storage) return false;
  if (terminal.store.getFreeCapacity() > 0) return false;
  if (terminal.store.getUsedCapacity(RESOURCE_ENERGY) >= ENERGY_TERMINAL_RECOVERY_TARGET)
    return false;

  let bestResource: ResourceConstant | undefined;
  let bestAmount = 0;
  for (const resource of Object.keys(terminal.store) as ResourceConstant[]) {
    const amount = terminal.store.getUsedCapacity(resource);
    if (amount > bestAmount) {
      bestAmount = amount;
      bestResource = resource;
    }
  }
  if (!bestResource) return false;

  creep.memory.targetId = terminal.id;
  creep.memory.forceStorageDelivery = true;
  const amount = Math.min(creep.store.getFreeCapacity(), bestAmount);
  if (creep.withdraw(terminal, bestResource, amount) === ERR_NOT_IN_RANGE) {
    moveTo(creep, terminal, {
      priority: PRIORITY_HAULER,
      visualizePathStyle: { stroke: '#ff0000' },
    });
  }
  return true;
}

function pickupForTerminal(creep: Creep): boolean {
  // Use ownership-aware helpers so we only move minerals from OUR storage to OUR terminal.
  const storage = myStorage(creep.room);
  const terminal = myTerminal(creep.room);
  if (!storage || !terminal || terminal.store.getFreeCapacity() < 1000) return false;
  // Reserve enough free capacity for energy to land whenever the terminal is
  // short of it. In normal operation the terminal has ample free capacity
  // (hundreds of thousands) so this never binds — it only matters once the
  // terminal is ALSO near full, which is exactly the state pickupTerminalOverflow
  // just fixed. Bounding the WITHDRAWAL AMOUNT (not just gating whether one
  // happens) is essential: capping only the gate still lets a full-capacity
  // withdrawal consume the capacity that fix just freed before
  // deliverToTerminalEnergy gets a chance to use it, recreating the deadlock
  // (observed live: freed capacity refilled with more Z/O within ticks, net
  // terminal free capacity never left 0). Reserves up to
  // ENERGY_TERMINAL_RECOVERY_TARGET, not ENERGY_TERMINAL_BUFFER — reserving
  // only up to the buffer left zero headroom for sellSurplus/buyForLabs'
  // "buffer + transaction cost" gates, so this reservation and
  // pickupTerminalOverflow's stop condition both went inert at the exact same
  // boundary (energy == buffer) and the terminal re-filled with minerals
  // before energy could ever clear a fee gate (see pickupTerminalOverflow's
  // doc comment for the live incident this fixes).
  const energyDeficit = Math.max(
    0,
    ENERGY_TERMINAL_RECOVERY_TARGET - terminal.store.getUsedCapacity(RESOURCE_ENERGY),
  );
  const shippableToTerminal = terminal.store.getFreeCapacity() - energyDeficit;
  if (shippableToTerminal < 1000) return false;

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
      // withdraw in pickupLabInput. Also capped to shippableToTerminal so this
      // trip doesn't eat into the capacity reserved for energy.
      const toWithdraw = Math.min(
        creep.store.getFreeCapacity(),
        available - floor,
        shippableToTerminal,
      );
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

/**
 * Refills the power spawn's power store from the terminal (power only ever
 * arrives there via the manual buyPower() console command — see main.ts).
 * Targeted, not greedy: only withdraws while the spawn is below
 * POWER_SPAWN_POWER_REFILL_THRESHOLD, so this is a finite, self-limiting job
 * ranked dead last in the pickup chain — it must never compete with anything
 * economically load-bearing.
 */
function pickupPowerForSpawn(creep: Creep): boolean {
  const mem = Memory.rooms[creep.room.name];
  if (!mem?.powerSpawnId) return false;
  const powerSpawn = Game.getObjectById(mem.powerSpawnId);
  if (!powerSpawn) return false;
  if (powerSpawn.store.getUsedCapacity(RESOURCE_POWER) >= POWER_SPAWN_POWER_REFILL_THRESHOLD)
    return false;

  const terminal = myTerminal(creep.room);
  const inTerminal = terminal?.store.getUsedCapacity(RESOURCE_POWER) ?? 0;
  if (!terminal || inTerminal === 0) return false;

  const toWithdraw = Math.min(
    creep.store.getFreeCapacity(),
    powerSpawn.store.getFreeCapacity(RESOURCE_POWER) ?? 0,
    inTerminal,
  );
  if (toWithdraw <= 0) return false;

  creep.memory.targetId = terminal.id;
  if (creep.withdraw(terminal, RESOURCE_POWER, toWithdraw) === ERR_NOT_IN_RANGE) {
    moveTo(creep, terminal, {
      priority: PRIORITY_HAULER,
      visualizePathStyle: { stroke: '#cc66ff' },
    });
  }
  return true;
}

// Finished sale-ready factory products to withdraw for the terminal. Battery
// is always a pure sale product. Wire is the silicon chain's actual goal
// output — utrium_bar is deliberately excluded: it's an intermediate the
// chain re-consumes for the next wire batch (same reasoning as the lab
// reaction chain's intermediates), so it's left in the factory rather than
// pulled out and sold.
const FACTORY_SALE_PRODUCTS: ResourceConstant[] = [RESOURCE_BATTERY, RESOURCE_WIRE];

function pickupFromFactory(creep: Creep): boolean {
  const mem = Memory.rooms[creep.room.name];
  if (!mem?.factoryId) return false;
  const factory = Game.getObjectById(mem.factoryId);
  if (!factory) return false;
  for (const resource of FACTORY_SALE_PRODUCTS) {
    if ((factory.store.getUsedCapacity(resource) ?? 0) === 0) continue;
    creep.memory.targetId = factory.id;
    if (creep.withdraw(factory, resource) === ERR_NOT_IN_RANGE) {
      moveTo(creep, factory, {
        priority: PRIORITY_HAULER,
        visualizePathStyle: { stroke: '#cc66ff' },
      });
    }
    return true;
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
  // Cargo withdrawn by pickupTerminalOverflow — force straight into storage.
  // Skipping the normal routing (deliverToTerminalOrStorage) is deliberate:
  // that function would send this exact resource right back into the terminal
  // capacity we just freed whenever the resource's storage stock happens to
  // already sit at/above its floor, undoing the fix.
  if (creep.memory.forceStorageDelivery) {
    const storage = myStorage(creep.room);
    const resource = (Object.keys(creep.store) as ResourceConstant[]).find(
      (r) => creep.store.getUsedCapacity(r) > 0,
    );
    if (storage && resource) {
      if (creep.transfer(storage, resource) === ERR_NOT_IN_RANGE) {
        moveTo(creep, storage, {
          priority: PRIORITY_HAULER,
          visualizePathStyle: { stroke: '#ff0000' },
        });
      } else {
        delete creep.memory.forceStorageDelivery;
      }
      return;
    }
    delete creep.memory.forceStorageDelivery;
  }

  // Non-energy resources: deliver to lab input, terminal, or storage.
  // If the room has no storage or terminal (young colony), drop the mineral rather
  // than getting permanently stuck in DELIVER with no valid target.
  if (creep.store.getUsedCapacity() > creep.store.getUsedCapacity(RESOURCE_ENERGY)) {
    if (deliverToBoostLab(creep)) return;
    if (deliverToPowerSpawn(creep)) return;
    if (deliverToLabInput(creep)) return;
    if (deliverToFactoryInputs(creep)) return;
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

  const tower = closestByRange(creep.pos, getRoomScan(creep.room).towersNeedingEnergy);
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

  if (deliverToPowerSpawn(creep)) return;

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

// Any room with genuine colony-wide surplus keeps the hub-level terminal floor,
// not just the hub itself — it needs that liquidity to actually act as a
// sendEnergyToColonies sender (broadened v1.0.299 to also cover mineral-priority
// siblings). Without this, a colony's terminal never holds more than
// TERMINAL_ENERGY_FLOOR_COLONY (5k), well under what a send requires (15k), even
// though its combined colonyEnergy clears HOME_SURPLUS_FLOOR — the room is
// "eligible" to send but never physically holds enough to do it. Live: W42N59
// and W44N57 terminals sat at ~13-14k (incidental leftovers, not maintained)
// while comfortably clearing HOME_SURPLUS_FLOOR, and zero energy ever reached
// W44N59 as a result.
function terminalEnergyFloor(room: Room): number {
  if (isLabHub(room)) return TERMINAL_ENERGY_FLOOR;
  const energy = Memory.holisticEconomy
    ? colonyEnergy(room)
    : (room.storage?.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0);
  return energy >= HOME_SURPLUS_FLOOR ? TERMINAL_ENERGY_FLOOR : TERMINAL_ENERGY_FLOOR_COLONY;
}

function deliverToTerminalEnergy(creep: Creep): boolean {
  // Only deposit into OWN terminal — a foreign terminal in a reclaimed room must
  // not receive our energy.
  const terminal = myTerminal(creep.room);
  if (!terminal) return false;
  const floor = terminalEnergyFloor(creep.room);
  if (terminal.store.getUsedCapacity(RESOURCE_ENERGY) >= floor) return false;
  if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) return false;
  // A terminal's free capacity is shared across all resources, not just energy —
  // when other minerals fill it up, an unbounded transfer() fails with ERR_FULL
  // the instant the carried amount exceeds whatever room is left, not just when
  // the terminal is completely full. Without this guard the caller (deliver())
  // still treats the attempt as "handled" (only ERR_NOT_IN_RANGE triggers a
  // fallback), so a hauler gets permanently stuck holding cargo it can never
  // unload here instead of falling through to storage. Transferring only the
  // amount that actually fits means a partially-full terminal (e.g. capacity
  // just freed by pickupTerminalOverflow) still gets topped up as far as
  // possible, and any leftover cargo correctly falls through to storage on the
  // next evaluation instead of retrying the same failing transfer forever.
  const amount = Math.min(
    creep.store.getUsedCapacity(RESOURCE_ENERGY),
    terminal.store.getFreeCapacity(),
  );
  if (amount <= 0) return false;
  if (creep.transfer(terminal, RESOURCE_ENERGY, amount) === ERR_NOT_IN_RANGE) {
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
  const floor = terminalEnergyFloor(creep.room);
  if (terminalE <= floor + TERMINAL_RESTOCK_MIN_BATCH) return false;
  const amount = Math.min(creep.store.getFreeCapacity(), terminalE - floor);
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

/**
 * Feeds the power spawn (GPL processing) — power (withdrawn by
 * pickupPowerForSpawn) delivers unconditionally since its capacity is
 * trivially small (100 units); energy delivery is gated on
 * POWER_SPAWN_ENERGY_FLOOR, deliberately ABOVE FACTORY_ENERGY_FLOOR since
 * GPL has no direct economic payback and must only ever spend genuine
 * surplus left over after the factory and upgraders are funded.
 */
function deliverToPowerSpawn(creep: Creep): boolean {
  const mem = Memory.rooms[creep.room.name];
  if (!mem?.powerSpawnId) return false;
  const powerSpawn = Game.getObjectById(mem.powerSpawnId);
  if (!powerSpawn) return false;

  if (creep.store.getUsedCapacity(RESOURCE_POWER) > 0) {
    if ((powerSpawn.store.getFreeCapacity(RESOURCE_POWER) ?? 0) === 0) return false;
    if (creep.transfer(powerSpawn, RESOURCE_POWER) === ERR_NOT_IN_RANGE) {
      moveTo(creep, powerSpawn, {
        priority: PRIORITY_HAULER,
        visualizePathStyle: { stroke: '#ff66ff' },
      });
    }
    return true;
  }

  if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) return false;
  const energyOk = Memory.holisticEconomy
    ? colonyEnergy(creep.room) > POWER_SPAWN_ENERGY_FLOOR
    : (() => {
        const storage = myStorage(creep.room);
        return (
          !!storage && storage.store.getUsedCapacity(RESOURCE_ENERGY) > POWER_SPAWN_ENERGY_FLOOR
        );
      })();
  if (!energyOk) return false;
  if ((powerSpawn.store.getFreeCapacity(RESOURCE_ENERGY) ?? 0) === 0) return false;
  if (creep.transfer(powerSpawn, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
    moveTo(creep, powerSpawn, {
      priority: PRIORITY_HAULER,
      visualizePathStyle: { stroke: '#ff66ff' },
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

/**
 * Delivers whatever the creep is carrying into the factory, if it's a
 * non-energy component the active recipe (mem.factoryRecipe) actually needs
 * — the delivery-side counterpart to pickupFactoryInput. Ranked alongside
 * deliverToLabInput, ahead of deliverToTerminalOrStorage, so a hauler that
 * picked up silicon/utrium_bar for the factory doesn't get misrouted back
 * into storage/terminal by the generic mineral-delivery fallback.
 */
function deliverToFactoryInputs(creep: Creep): boolean {
  const mem = Memory.rooms[creep.room.name];
  if (!mem?.factoryId || !mem.factoryRecipe) return false;
  const recipe = COMMODITIES[mem.factoryRecipe as keyof typeof COMMODITIES];
  if (!recipe) return false;
  const factory = Game.getObjectById(mem.factoryId);
  if (!factory) return false;

  const resourceTypes = Object.keys(creep.store) as ResourceConstant[];
  for (const resource of resourceTypes) {
    if (resource === RESOURCE_ENERGY) continue;
    if (creep.store.getUsedCapacity(resource) === 0) continue;
    if (!(resource in recipe.components)) continue;
    if ((factory.store.getFreeCapacity(resource) ?? 0) === 0) continue;

    if (creep.transfer(factory, resource) === ERR_NOT_IN_RANGE) {
      moveTo(creep, factory, {
        priority: PRIORITY_HAULER,
        visualizePathStyle: { stroke: '#00ff88' },
      });
    }
    return true;
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
