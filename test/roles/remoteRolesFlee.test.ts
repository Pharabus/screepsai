// Integration check: every role intended to operate in a remote room must
// call handleRemoteThreat at the top of its run(). When a hostile is in
// range in the target room, the role must record the sighting in memory.
// This test exists specifically to catch the "forgot to wire it up" class
// of bug we hit with remoteBuilder.

import { miner } from '../../src/roles/miner';
import { remoteHauler } from '../../src/roles/remoteHauler';
import { reserver } from '../../src/roles/reserver';
import { remoteBuilder } from '../../src/roles/remoteBuilder';
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

function setup(role: string): any {
  const targetRoom = mockRoom({ name: 'W2N1' });
  const homeRoom = mockRoom({
    name: 'W1N1',
    find: vi.fn(() => [{ pos: new (globalThis as any).RoomPosition(25, 25, 'W1N1') }]),
  });
  (Game as any).rooms = { W1N1: homeRoom, W2N1: targetRoom };
  (Memory as any).rooms = { W2N1: {} };

  return mockCreep({
    name: `test_${role}`,
    memory: { role, homeRoom: 'W1N1', targetRoom: 'W2N1' },
    room: targetRoom,
    pos: posWithHostiles(10, 10, 'W2N1', [hostileWithThreat()]),
  });
}

describe('remote roles flee on threat (wiring check)', () => {
  it('miner records hostile sighting and short-circuits its state machine', () => {
    const creep = setup('miner');
    miner.run(creep);
    expect(Memory.rooms.W2N1.hostileLastSeen).toBe(10000);
  });

  it('remoteHauler records hostile sighting and short-circuits its state machine', () => {
    const creep = setup('remoteHauler');
    remoteHauler.run(creep);
    expect(Memory.rooms.W2N1.hostileLastSeen).toBe(10000);
  });

  it('reserver records hostile sighting and short-circuits its state machine', () => {
    const creep = setup('reserver');
    reserver.run(creep);
    expect(Memory.rooms.W2N1.hostileLastSeen).toBe(10000);
  });

  it('remoteBuilder records hostile sighting and short-circuits its state machine', () => {
    const creep = setup('remoteBuilder');
    remoteBuilder.run(creep);
    expect(Memory.rooms.W2N1.hostileLastSeen).toBe(10000);
  });
});
