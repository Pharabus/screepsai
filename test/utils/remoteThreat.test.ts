import {
  handleRemoteThreat,
  isRemoteRoomUnderThreat,
  HOSTILE_COOLDOWN,
} from '../../src/utils/remoteThreat';
import { mockCreep, mockRoom, resetGameGlobals } from '../mocks/screeps';
import { resetTraffic } from '../../src/utils/trafficManager';

beforeEach(() => {
  resetGameGlobals();
  resetTraffic();
  (Game as any).time = 10000;
});

function hostileWithThreat(): any {
  return {
    body: [
      { type: ATTACK, hits: 100 },
      { type: MOVE, hits: 100 },
    ],
    hits: 1000,
    hitsMax: 1000,
  };
}

function posWithHostiles(x: number, y: number, roomName: string, hostiles: any[]): any {
  const pos = new (globalThis as any).RoomPosition(x, y, roomName);
  pos.findInRange = vi.fn((_type: any, _range: number, opts?: any) => {
    if (opts?.filter) return hostiles.filter(opts.filter);
    return hostiles;
  });
  return pos;
}

describe('isRemoteRoomUnderThreat', () => {
  it('returns false when hostileLastSeen is undefined', () => {
    (Memory as any).rooms = { W2N1: {} };
    expect(isRemoteRoomUnderThreat('W2N1')).toBe(false);
  });

  it('returns true within HOSTILE_COOLDOWN window', () => {
    (Memory as any).rooms = { W2N1: { hostileLastSeen: 10000 - 100 } };
    expect(isRemoteRoomUnderThreat('W2N1')).toBe(true);
  });

  it('returns false after HOSTILE_COOLDOWN elapses', () => {
    (Memory as any).rooms = { W2N1: { hostileLastSeen: 10000 - HOSTILE_COOLDOWN - 1 } };
    expect(isRemoteRoomUnderThreat('W2N1')).toBe(false);
  });
});

describe('handleRemoteThreat', () => {
  it('returns false for creeps without a targetRoom (home miner)', () => {
    const creep = mockCreep({
      memory: { role: 'miner' },
      room: mockRoom({ name: 'W1N1' }),
    });
    expect(handleRemoteThreat(creep)).toBe(false);
  });

  it('records hostile and flees when threat-scoring hostile is in range in target room', () => {
    const targetRoom = mockRoom({ name: 'W2N1' });
    const homeRoom = mockRoom({
      name: 'W1N1',
      find: vi.fn(() => [{ pos: new (globalThis as any).RoomPosition(25, 25, 'W1N1') }]),
    });
    (Game as any).rooms = { W1N1: homeRoom, W2N1: targetRoom };
    (Memory as any).rooms = { W2N1: {} };

    const creep = mockCreep({
      memory: { role: 'miner', homeRoom: 'W1N1', targetRoom: 'W2N1' },
      room: targetRoom,
      pos: posWithHostiles(10, 10, 'W2N1', [hostileWithThreat()]),
    });

    const result = handleRemoteThreat(creep);

    expect(result).toBe(true);
    expect(Memory.rooms.W2N1.hostileLastSeen).toBe(10000);
  });

  it('does not flee or record when no hostile is in range in target room', () => {
    const targetRoom = mockRoom({ name: 'W2N1' });
    (Memory as any).rooms = { W2N1: {} };

    const creep = mockCreep({
      memory: { role: 'miner', homeRoom: 'W1N1', targetRoom: 'W2N1' },
      room: targetRoom,
      pos: posWithHostiles(10, 10, 'W2N1', []),
    });

    expect(handleRemoteThreat(creep)).toBe(false);
    expect(Memory.rooms.W2N1.hostileLastSeen).toBeUndefined();
  });

  it('ignores threat-zero hostiles (scouts) in target room', () => {
    const targetRoom = mockRoom({ name: 'W2N1' });
    (Memory as any).rooms = { W2N1: {} };

    const scout = {
      body: [{ type: MOVE, hits: 100 }],
      hits: 50,
      hitsMax: 50,
    };
    const creep = mockCreep({
      memory: { role: 'miner', homeRoom: 'W1N1', targetRoom: 'W2N1' },
      room: targetRoom,
      pos: posWithHostiles(10, 10, 'W2N1', [scout]),
    });

    expect(handleRemoteThreat(creep)).toBe(false);
    expect(Memory.rooms.W2N1.hostileLastSeen).toBeUndefined();
  });

  it('parks at home when target room is under threat and creep is at home', () => {
    const homeRoom = mockRoom({
      name: 'W1N1',
      find: vi.fn(() => [{ pos: new (globalThis as any).RoomPosition(25, 25, 'W1N1') }]),
    });
    (Game as any).rooms = { W1N1: homeRoom };
    (Memory as any).rooms = { W2N1: { hostileLastSeen: 10000 - 50 } };

    const creep = mockCreep({
      memory: { role: 'miner', homeRoom: 'W1N1', targetRoom: 'W2N1' },
      room: homeRoom,
    });

    expect(handleRemoteThreat(creep)).toBe(true);
  });

  it('lets a loaded remoteHauler continue its DELIVER trip while target room is under threat', () => {
    const homeRoom = mockRoom({ name: 'W1N1' });
    (Game as any).rooms = { W1N1: homeRoom };
    (Memory as any).rooms = { W2N1: { hostileLastSeen: 10000 - 50 } };

    const creep = mockCreep({
      memory: { role: 'remoteHauler', homeRoom: 'W1N1', targetRoom: 'W2N1' },
      room: homeRoom,
      store: { getUsedCapacity: () => 400, getFreeCapacity: () => 0 },
    });

    expect(handleRemoteThreat(creep)).toBe(false);
  });

  it('parks an empty remoteHauler while target room is under threat', () => {
    const homeRoom = mockRoom({
      name: 'W1N1',
      find: vi.fn(() => [{ pos: new (globalThis as any).RoomPosition(25, 25, 'W1N1') }]),
    });
    (Game as any).rooms = { W1N1: homeRoom };
    (Memory as any).rooms = { W2N1: { hostileLastSeen: 10000 - 50 } };

    const creep = mockCreep({
      memory: { role: 'remoteHauler', homeRoom: 'W1N1', targetRoom: 'W2N1' },
      room: homeRoom,
      store: { getUsedCapacity: () => 0, getFreeCapacity: () => 400 },
    });

    expect(handleRemoteThreat(creep)).toBe(true);
  });

  it('resumes normal operation once HOSTILE_COOLDOWN expires', () => {
    const homeRoom = mockRoom({ name: 'W1N1' });
    (Game as any).rooms = { W1N1: homeRoom };
    (Memory as any).rooms = { W2N1: { hostileLastSeen: 10000 - HOSTILE_COOLDOWN - 1 } };

    const creep = mockCreep({
      memory: { role: 'miner', homeRoom: 'W1N1', targetRoom: 'W2N1' },
      room: homeRoom,
    });

    expect(handleRemoteThreat(creep)).toBe(false);
  });
});
