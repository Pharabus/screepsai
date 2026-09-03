import { Role } from './Role';
import { gatherEnergy } from '../utils/sources';
import { moveTo } from '../utils/movement';
import { PRIORITY_WORKER } from '../utils/trafficManager';
import { runStateMachine, StateMachineDefinition } from '../utils/stateMachine';

const BUILD_PRIORITY: Partial<Record<BuildableStructureConstant, number>> = {
  [STRUCTURE_SPAWN]: 0,
  [STRUCTURE_EXTENSION]: 1,
  [STRUCTURE_TOWER]: 2,
  [STRUCTURE_CONTAINER]: 3,
  [STRUCTURE_STORAGE]: 4,
  [STRUCTURE_ROAD]: 6,
  [STRUCTURE_RAMPART]: 7,
};

// A road build cost of CONSTRUCTION_COST_ROAD_WALL_RATIO (150x) the base road
// cost means it crosses natural wall terrain -- a deliberate "tunnel"
// shortcut (see placeRemoteRoads's tunnel-aware planning) that the planner
// only places when it saves a large detour (~15+ tiles, per its own
// threshold). Every tick it sits unbuilt, creeps keep taking that long way
// around -- live-observed (2026-09-02): W44N57's 45000-cost tunnel at (37,11)
// sat at 0 progress, tied for the same priority as four ~300-1500-cost plain
// roads, so it never got picked ahead of them despite being the one site
// actually worth prioritising.
//
// Ranked AHEAD of CONTAINER/STORAGE, not just ahead of plain roads: a tunnel
// bridges a genuine terrain gap, and a structure on the far side of that same
// gap can be flat-out unreachable without it. Live case, same room: the
// tunnel at (37,11) sits in a 1-tile-wide wall neck, and the source container
// at (39,19) is on the far side of it -- ranking the container above the
// tunnel (the original choice here) sent every builder chasing a target
// PathFinder could only reach an INCOMPLETE path toward, and moveTo walked
// them to the closest reachable point of that incomplete path and stopped --
// a dead-end swamp pocket at (34-35,23-24), nowhere near either site,
// clustered there indefinitely. The tunnel side (36,11) is directly,
// fully-connected to the open core with no obstruction, so once it actually
// outranks the unreachable container, builders path there cleanly instead.
const TUNNEL_ROAD_COST = CONSTRUCTION_COST[STRUCTURE_ROAD] * CONSTRUCTION_COST_ROAD_WALL_RATIO;
const TUNNEL_ROAD_PRIORITY = 2.5; // behind TOWER (2), ahead of CONTAINER (3)

function buildPriority(site: ConstructionSite): number {
  if (site.structureType === STRUCTURE_ROAD && site.progressTotal >= TUNNEL_ROAD_COST) {
    return TUNNEL_ROAD_PRIORITY;
  }
  return BUILD_PRIORITY[site.structureType] ?? 5;
}

const states: StateMachineDefinition = {
  GATHER: {
    run(creep) {
      if (gatherEnergy(creep)) return 'BUILD';
      return undefined;
    },
    onEnter(creep) {
      delete creep.memory.targetId;
    },
  },
  BUILD: {
    run(creep) {
      if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) return 'GATHER';

      const sites = creep.room.find(FIND_MY_CONSTRUCTION_SITES);
      sites.sort((a, b) => buildPriority(a) - buildPriority(b));
      const site = sites[0];
      if (site) {
        if (creep.build(site) === ERR_NOT_IN_RANGE) {
          moveTo(creep, site, {
            range: 3,
            priority: PRIORITY_WORKER,
            visualizePathStyle: { stroke: '#33ff33' },
          });
        }
      } else {
        const homeRoomName = creep.memory.homeRoom ?? creep.room.name;
        if (creep.room.name !== homeRoomName) {
          // No sites in this room and it's not home — return rather than upgrading a foreign controller
          moveTo(creep, new RoomPosition(25, 25, homeRoomName), {
            range: 20,
            priority: PRIORITY_WORKER,
          });
        } else {
          const controller = creep.room.controller;
          if (controller) {
            if (creep.upgradeController(controller) === ERR_NOT_IN_RANGE) {
              moveTo(creep, controller, {
                range: 3,
                priority: PRIORITY_WORKER,
                visualizePathStyle: { stroke: '#3333ff' },
              });
            }
          }
        }
      }
      return undefined;
    },
  },
};

export const builder: Role = {
  run(creep: Creep): void {
    runStateMachine(creep, states, 'GATHER');
  },
};
