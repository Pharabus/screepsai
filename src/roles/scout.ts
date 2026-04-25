import { Role } from './Role';
import { moveTo } from '../utils/movement';
import { PRIORITY_DEFAULT } from '../utils/trafficManager';
import { runStateMachine, StateMachineDefinition } from '../utils/stateMachine';
import { markIdle } from '../utils/idle';

function pickScoutTarget(creep: Creep): string | undefined {
  const homeRoom = creep.memory.homeRoom ?? creep.room.name;
  const exits = Game.map.describeExits(homeRoom);
  if (!exits) return undefined;

  const candidates = Object.values(exits);
  const mem = Memory.rooms[homeRoom];
  const alreadyRemote = new Set(mem?.remoteRooms ?? []);

  // Prefer rooms we haven't scouted yet (no Memory.rooms entry with scoutedAt)
  for (const roomName of candidates) {
    if (alreadyRemote.has(roomName)) continue;
    const rmem = Memory.rooms[roomName];
    if (!rmem?.scoutedAt) return roomName;
  }

  // Re-scout rooms whose data is older than 5000 ticks
  for (const roomName of candidates) {
    const rmem = Memory.rooms[roomName];
    if (rmem?.scoutedAt && Game.time - rmem.scoutedAt > 5000) return roomName;
  }

  return undefined;
}

function markUnreachable(targetRoom: string): void {
  const rmem = (Memory.rooms[targetRoom] ??= {});
  rmem.scoutedAt = Game.time;
  rmem.scoutedSources = 0;
}

const states: StateMachineDefinition = {
  SCOUT: {
    run(creep) {
      if (!creep.memory.targetRoom) {
        const target = pickScoutTarget(creep);
        if (!target) {
          markIdle(creep);
          return undefined;
        }
        creep.memory.targetRoom = target;
        delete creep.memory._scoutTick;
      }

      const targetRoom = creep.memory.targetRoom as string;

      if (creep.room.name === targetRoom) {
        const rmem = (Memory.rooms[targetRoom] ??= {});
        const sources = creep.room.find(FIND_SOURCES);
        rmem.scoutedSources = sources.length;
        rmem.scoutedSourceData = sources.map((s) => ({ id: s.id, x: s.pos.x, y: s.pos.y }));
        rmem.scoutedAt = Game.time;

        const controller = creep.room.controller;
        if (controller) {
          rmem.scoutedOwner = controller.owner?.username;
          rmem.scoutedReservation = controller.reservation?.username;
        }

        const hostiles = creep.room.find(FIND_HOSTILE_CREEPS);
        rmem.scoutedHostiles = hostiles.length;

        creep.memory.targetRoom = undefined;
        delete creep.memory._scoutTick;
        return undefined;
      }

      // Path to center of target room — PathFinder handles cross-room routing
      const targetPos = new RoomPosition(25, 25, targetRoom);
      moveTo(creep, targetPos, {
        range: 20,
        priority: PRIORITY_DEFAULT,
        visualizePathStyle: { stroke: '#aaaaaa' },
      });

      // Stuck detection: if we haven't changed rooms after a while, mark unreachable
      if (!creep.memory._scoutTick) {
        creep.memory._scoutTick = Game.time;
      } else if (Game.time - creep.memory._scoutTick > 50) {
        markUnreachable(targetRoom);
        creep.memory.targetRoom = undefined;
        delete creep.memory._scoutTick;
      }
      return undefined;
    },
  },
};

export const scout: Role = {
  run(creep: Creep): void {
    runStateMachine(creep, states, 'SCOUT');
  },
};
