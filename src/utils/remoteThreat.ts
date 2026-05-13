import { threatScore } from './threat';
import { moveTo } from './movement';
import { PRIORITY_HAULER } from './trafficManager';

export const HOSTILE_COOLDOWN = 300;
export const HOSTILE_FLEE_RANGE = 5;

export function isRemoteRoomUnderThreat(roomName: string): boolean {
  const lastSeen = Memory.rooms[roomName]?.hostileLastSeen;
  if (lastSeen === undefined) return false;
  return Game.time - lastSeen < HOSTILE_COOLDOWN;
}

function recordHostile(roomName: string): void {
  if (!Memory.rooms[roomName]) {
    Memory.rooms[roomName] = {} as RoomMemory;
  }
  Memory.rooms[roomName].hostileLastSeen = Game.time;
}

function fleeToHome(creep: Creep): void {
  const homeRoom = creep.memory.homeRoom;
  if (!homeRoom) return;
  const room = Game.rooms[homeRoom];
  const target =
    room?.storage?.pos ?? room?.find(FIND_MY_SPAWNS)[0]?.pos ?? new RoomPosition(25, 25, homeRoom);
  moveTo(creep, target, {
    range: 5,
    priority: PRIORITY_HAULER,
    visualizePathStyle: { stroke: '#ff0000' },
  });
}

/**
 * Returns true when the creep should skip its normal state machine this tick
 * because the target remote room is (or was recently) hostile. Records a
 * fresh sighting if a threat-scoring hostile is within HOSTILE_FLEE_RANGE.
 *
 * Haulers carrying energy are allowed to proceed home through their normal
 * DELIVER state — only empty haulers are parked.
 */
export function handleRemoteThreat(creep: Creep): boolean {
  const targetRoom = creep.memory.targetRoom;
  if (!targetRoom) return false;

  if (creep.room.name === targetRoom) {
    const hostiles = creep.pos.findInRange(FIND_HOSTILE_CREEPS, HOSTILE_FLEE_RANGE, {
      filter: (h) => threatScore(h) > 0,
    });
    if (hostiles.length === 0) return false;
    recordHostile(targetRoom);
    fleeToHome(creep);
    return true;
  }

  if (!isRemoteRoomUnderThreat(targetRoom)) return false;

  // Hauler with cargo finishes its delivery rather than parking empty-handed
  if (creep.memory.role === 'remoteHauler' && creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
    return false;
  }

  fleeToHome(creep);
  return true;
}
