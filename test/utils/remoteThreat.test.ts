import {
  handleRemoteThreat,
  isRemoteRoomUnderThreat,
  HOSTILE_COOLDOWN,
  NPC_HOSTILE_COOLDOWN,
} from '../../src/utils/remoteThreat';
import { mockCreep, mockRoom, resetGameGlobals } from '../mocks/screeps';
import { resetTraffic } from '../../src/utils/trafficManager';

beforeEach(() => {
  resetGameGlobals();
  resetTraffic();
  (Game as any).time = 10000;
});

function hostileWithThreat(owner?: string): any {
  return {
    body: [
      { type: ATTACK, hits: 100 },
      { type: MOVE, hits: 100 },
    ],
    hits: 1000,
    hitsMax: 1000,
    owner: owner !== undefined ? { username: owner } : undefined,
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

  it('returns true within HOSTILE_COOLDOWN window (player)', () => {
    (Memory as any).rooms = { W2N1: { hostileLastSeen: 10000 - 100, hostileLastWasPlayer: true } };
    expect(isRemoteRoomUnderThreat('W2N1')).toBe(true);
  });

  it('returns false after HOSTILE_COOLDOWN elapses (player)', () => {
    (Memory as any).rooms = {
      W2N1: { hostileLastSeen: 10000 - HOSTILE_COOLDOWN - 1, hostileLastWasPlayer: true },
    };
    expect(isRemoteRoomUnderThreat('W2N1')).toBe(false);
  });

  // NPC (Invader / Source Keeper) — short cooldown
  it('returns false for NPC sighting older than NPC_HOSTILE_COOLDOWN', () => {
    // Just past the NPC window → no longer under threat
    (Memory as any).rooms = {
      W2N1: { hostileLastSeen: 10000 - NPC_HOSTILE_COOLDOWN - 1, hostileLastWasPlayer: false },
    };
    expect(isRemoteRoomUnderThreat('W2N1')).toBe(false);
  });

  it('returns true for NPC sighting within NPC_HOSTILE_COOLDOWN', () => {
    // Just inside the NPC window → still under threat
    (Memory as any).rooms = {
      W2N1: { hostileLastSeen: 10000 - (NPC_HOSTILE_COOLDOWN - 1), hostileLastWasPlayer: false },
    };
    expect(isRemoteRoomUnderThreat('W2N1')).toBe(true);
  });

  // Player hostile at 60 ticks ago — still within full 300-tick window
  it('returns true for player sighting 60 ticks ago (well within HOSTILE_COOLDOWN)', () => {
    (Memory as any).rooms = {
      W2N1: { hostileLastSeen: 10000 - 60, hostileLastWasPlayer: true },
    };
    expect(isRemoteRoomUnderThreat('W2N1')).toBe(true);
  });

  it('returns true for player sighting 299 ticks ago (just inside HOSTILE_COOLDOWN)', () => {
    (Memory as any).rooms = {
      W2N1: { hostileLastSeen: 10000 - (HOSTILE_COOLDOWN - 1), hostileLastWasPlayer: true },
    };
    expect(isRemoteRoomUnderThreat('W2N1')).toBe(true);
  });

  // Legacy memory: missing hostileLastWasPlayer → treat as player (safe/long cooldown)
  it('treats missing hostileLastWasPlayer as player (long cooldown) — 60 ticks ago still under threat', () => {
    (Memory as any).rooms = { W2N1: { hostileLastSeen: 10000 - 60 } };
    expect(isRemoteRoomUnderThreat('W2N1')).toBe(true);
  });

  it('treats missing hostileLastWasPlayer as player — only clears after full HOSTILE_COOLDOWN', () => {
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

  it('does not flee from Source Keepers in a keeperRoom', () => {
    // Miners in SK rooms should ignore Source Keepers — the keeperKiller handles them.
    const targetRoom = mockRoom({ name: 'W2N1' });
    (Memory as any).rooms = { W2N1: { remoteType: 'keeperRoom' } };

    const sourceKeeper = {
      body: [
        { type: ATTACK, hits: 100 },
        { type: MOVE, hits: 100 },
      ],
      hits: 1000,
      hitsMax: 1000,
      owner: { username: 'Source Keeper' },
    };

    const creep = mockCreep({
      memory: { role: 'miner', homeRoom: 'W1N1', targetRoom: 'W2N1' },
      room: targetRoom,
      pos: posWithHostiles(10, 10, 'W2N1', [sourceKeeper]),
    });

    expect(handleRemoteThreat(creep)).toBe(false);
    expect(Memory.rooms.W2N1.hostileLastSeen).toBeUndefined();
  });

  it('still flees from player hostiles in a keeperRoom', () => {
    // A player creep in an SK room is still a threat — flee regardless of remoteType.
    const targetRoom = mockRoom({ name: 'W2N1' });
    const homeRoom = mockRoom({
      name: 'W1N1',
      find: vi.fn(() => [{ pos: new (globalThis as any).RoomPosition(25, 25, 'W1N1') }]),
    });
    (Game as any).rooms = { W1N1: homeRoom, W2N1: targetRoom };
    (Memory as any).rooms = { W2N1: { remoteType: 'keeperRoom' } };

    const playerHostile = {
      body: [
        { type: ATTACK, hits: 100 },
        { type: MOVE, hits: 100 },
      ],
      hits: 1000,
      hitsMax: 1000,
      owner: { username: 'Attacker' },
    };

    const creep = mockCreep({
      memory: { role: 'miner', homeRoom: 'W1N1', targetRoom: 'W2N1' },
      room: targetRoom,
      pos: posWithHostiles(10, 10, 'W2N1', [playerHostile]),
    });

    expect(handleRemoteThreat(creep)).toBe(true);
  });

  // recordHostile classification tests — exercised via handleRemoteThreat

  it('records NPC flag false when sole hostile is an Invader', () => {
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
      pos: posWithHostiles(10, 10, 'W2N1', [hostileWithThreat('Invader')]),
    });

    const result = handleRemoteThreat(creep);

    expect(result).toBe(true);
    expect(Memory.rooms.W2N1.hostileLastSeen).toBe(10000);
    expect(Memory.rooms.W2N1.hostileLastWasPlayer).toBe(false);
  });

  it('records NPC flag false when sole hostile is a Source Keeper', () => {
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
      pos: posWithHostiles(10, 10, 'W2N1', [hostileWithThreat('Source Keeper')]),
    });

    const result = handleRemoteThreat(creep);

    expect(result).toBe(true);
    expect(Memory.rooms.W2N1.hostileLastSeen).toBe(10000);
    expect(Memory.rooms.W2N1.hostileLastWasPlayer).toBe(false);
  });

  it('records player flag true when hostile is a normal player (Pharabus)', () => {
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
      pos: posWithHostiles(10, 10, 'W2N1', [hostileWithThreat('Pharabus')]),
    });

    const result = handleRemoteThreat(creep);

    expect(result).toBe(true);
    expect(Memory.rooms.W2N1.hostileLastSeen).toBe(10000);
    expect(Memory.rooms.W2N1.hostileLastWasPlayer).toBe(true);
  });

  it('records player flag true when list contains one Invader and one player (mixed)', () => {
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
      pos: posWithHostiles(10, 10, 'W2N1', [
        hostileWithThreat('Invader'),
        hostileWithThreat('Pharabus'),
      ]),
    });

    const result = handleRemoteThreat(creep);

    expect(result).toBe(true);
    expect(Memory.rooms.W2N1.hostileLastSeen).toBe(10000);
    expect(Memory.rooms.W2N1.hostileLastWasPlayer).toBe(true);
  });

  it('records player flag true when hostile has no owner — unknown = conservative/safe', () => {
    // A creep with no identifiable owner is treated conservatively as a player
    // (long cooldown), so we never under-react on ambiguous data.
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
      // hostileWithThreat() with no owner → owner: undefined → unknown username → player
      pos: posWithHostiles(10, 10, 'W2N1', [hostileWithThreat()]),
    });

    const result = handleRemoteThreat(creep);

    expect(result).toBe(true);
    expect(Memory.rooms.W2N1.hostileLastWasPlayer).toBe(true);
  });
});
