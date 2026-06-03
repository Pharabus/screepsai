import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockCreep, mockRoom, resetGameGlobals } from '../mocks/screeps';
import { resetTickCache } from '../../src/utils/tickCache';
import { resetMissions } from '../../src/utils/missions';
import { runDefense } from '../../src/managers/defense';

// runDefense pulls hostile threat + neighbor intel; stub both like defense.test.ts.
vi.mock('../../src/utils/neighbors', () => ({
  recordHostile: vi.fn(),
  requestNeighborSegment: vi.fn(),
}));
vi.mock('../../src/utils/threat', () => ({
  threatScore: vi.fn((creep: any) => creep._threatScore ?? 0),
}));

function makeHostile(opts: { threatScore?: number; owner?: string } = {}): any {
  return mockCreep({
    owner: { username: opts.owner ?? 'Enemy' },
    _threatScore: opts.threatScore ?? 80,
    body: [{ type: 'attack', hits: 100 }],
  });
}

/** Owned room whose find() returns the given hostiles for FIND_HOSTILE_CREEPS. */
function ownedRoomWith(hostiles: any[]): any {
  const room: any = mockRoom({ name: 'W1N1' });
  room.controller = { my: true, level: 5, pos: { x: 10, y: 10 }, safeModeAvailable: 0 };
  room.controller.activateSafeMode = vi.fn();
  room.find = vi.fn((type: number, opts?: any) => {
    if (type === FIND_HOSTILE_CREEPS) return opts?.filter ? hostiles.filter(opts.filter) : hostiles;
    return [];
  });
  Game.rooms['W1N1'] = room;
  return room;
}

function defenseMission() {
  return Memory.missions?.defense?.['W1N1'];
}

describe('DefenseMission lifecycle (runDefense)', () => {
  beforeEach(() => {
    resetGameGlobals();
    resetTickCache();
    resetMissions();
    Game.time = 1000;
    Memory.rooms['W1N1'] = {};
  });

  it('opens an active DefenseMission on the first threat tick', () => {
    ownedRoomWith([makeHostile({ threatScore: 260, owner: 'Enemy' })]);
    runDefense();

    const m = defenseMission()!;
    expect(m).toBeDefined();
    expect(m.type).toBe('defense');
    expect(m.id).toBe('W1N1');
    expect(m.roomName).toBe('W1N1');
    expect(m.status).toBe('active');
    expect(m.createdAt).toBe(1000);
    expect(m.threatScore).toBe(260);
    expect(m.hostileCount).toBe(1);
    expect(m.owners).toEqual(['Enemy']);
    expect(m.composition).toEqual({ melee: 0, ranged: 0, healer: 0 });
  });

  it('refreshes the threat snapshot and defender roster while active', () => {
    ownedRoomWith([makeHostile({ threatScore: 260 })]);
    runDefense(); // open

    // A defender and a healer now stand in the room; threat grows.
    Game.creeps['def1'] = mockCreep({
      name: 'def1',
      room: { name: 'W1N1' },
      memory: { role: 'defender' },
    });
    Game.creeps['rng1'] = mockCreep({
      name: 'rng1',
      room: { name: 'W1N1' },
      memory: { role: 'rangedDefender' },
    });
    Game.creeps['heal1'] = mockCreep({
      name: 'heal1',
      room: { name: 'W1N1' },
      memory: { role: 'healer' },
    });
    Game.time = 1005;
    resetTickCache(); // simulate new tick
    ownedRoomWith([
      makeHostile({ threatScore: 300, owner: 'Enemy' }),
      makeHostile({ threatScore: 100, owner: 'Enemy' }),
    ]);
    runDefense();

    const m = defenseMission()!;
    expect(m.status).toBe('active');
    expect(m.createdAt).toBe(1000); // unchanged — still the same engagement
    expect(m.lastSynced).toBe(1005);
    expect(m.threatScore).toBe(400);
    expect(m.hostileCount).toBe(2);
    expect(m.defenderIds.sort()).toEqual(['def1', 'rng1']);
    expect(m.healerIds).toEqual(['heal1']);
  });

  it('sets the mission retiring with endedAt when the threat clears', () => {
    ownedRoomWith([makeHostile({ threatScore: 260 })]);
    runDefense(); // open
    expect(defenseMission()!.status).toBe('active');

    Game.time = 1010;
    resetTickCache(); // simulate new tick
    ownedRoomWith([]); // hostiles gone
    runDefense();

    const m = defenseMission()!;
    expect(m.status).toBe('retiring');
    expect(m.endedAt).toBe(1010);
  });

  it('reactivates a retiring mission when a new threat appears', () => {
    ownedRoomWith([makeHostile({ threatScore: 260 })]);
    runDefense(); // open

    Game.time = 1010;
    resetTickCache(); // simulate new tick
    ownedRoomWith([]);
    runDefense(); // retiring
    expect(defenseMission()!.status).toBe('retiring');

    Game.time = 1020;
    resetTickCache(); // simulate new tick
    ownedRoomWith([makeHostile({ threatScore: 500, owner: 'Raider' })]);
    runDefense(); // reactivate

    const m = defenseMission()!;
    expect(m.status).toBe('active');
    expect(m.createdAt).toBe(1020); // fresh engagement
    expect(m.endedAt).toBeUndefined();
    expect(m.threatScore).toBe(500);
    expect(m.owners).toEqual(['Raider']);
  });
});
