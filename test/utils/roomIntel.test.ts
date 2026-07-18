import { recordHighwayIntel } from '../../src/utils/roomIntel';
import { mockRoom, resetGameGlobals } from '../mocks/screeps';

function makeTerrain(walls: Array<[number, number]> = []): any {
  const wallSet = new Set(walls.map(([x, y]) => `${x},${y}`));
  return {
    get: (x: number, y: number) => (wallSet.has(`${x},${y}`) ? TERRAIN_MASK_WALL : 0),
  };
}

function makePowerBank(overrides: Record<string, any> = {}): any {
  return {
    id: 'bank1',
    structureType: STRUCTURE_POWER_BANK,
    pos: { x: 25, y: 25 },
    power: 4000,
    ticksToDecay: 4000,
    ...overrides,
  };
}

function makeDeposit(overrides: Record<string, any> = {}): any {
  return {
    id: 'dep1',
    pos: { x: 10, y: 10 },
    depositType: 'silicon',
    lastCooldown: 5,
    ...overrides,
  };
}

function makeFindDispatch(byType: Partial<Record<number, any[]>>) {
  return (type: number) => byType[type] ?? [];
}

describe('recordHighwayIntel', () => {
  beforeEach(() => {
    resetGameGlobals();
    (Memory as any).rooms = {};
  });

  it('records a qualifying power bank (power/decay/free-tiles all clear the floor)', () => {
    const bank = makePowerBank();
    const room = mockRoom({
      name: 'W40N57',
      find: makeFindDispatch({ [FIND_MY_STRUCTURES]: [], [FIND_DEPOSITS]: [] }),
      getTerrain: () => makeTerrain([]), // fully open — 8/8 free
    });
    // recordHighwayIntel reads structures via getStructuresByType, which uses
    // FIND_STRUCTURES (not FIND_MY_STRUCTURES) — a power bank is neutral.
    room.find = (type: number) => {
      if (type === FIND_STRUCTURES) return [bank];
      if (type === FIND_DEPOSITS) return [];
      return [];
    };

    recordHighwayIntel(room);

    const mem = Memory.rooms['W40N57']!;
    expect(mem.scoutedPowerBank).toEqual({
      id: 'bank1',
      x: 25,
      y: 25,
      power: 4000,
      ticksToDecay: 4000,
      freeAdjacentTiles: 8,
      recordedAtTick: Game.time,
    });
  });

  it('does not record a power bank below the power floor', () => {
    const bank = makePowerBank({ power: 1000 });
    const room = mockRoom({ name: 'W40N57' });
    room.find = (type: number) => (type === FIND_STRUCTURES ? [bank] : []);
    room.getTerrain = () => makeTerrain([]);

    recordHighwayIntel(room);

    expect(Memory.rooms['W40N57']?.scoutedPowerBank).toBeUndefined();
  });

  it('does not record a power bank too close to decaying', () => {
    const bank = makePowerBank({ ticksToDecay: 500 });
    const room = mockRoom({ name: 'W40N57' });
    room.find = (type: number) => (type === FIND_STRUCTURES ? [bank] : []);
    room.getTerrain = () => makeTerrain([]);

    recordHighwayIntel(room);

    expect(Memory.rooms['W40N57']?.scoutedPowerBank).toBeUndefined();
  });

  it('does not record a power bank with fewer than 2 free adjacent tiles', () => {
    const bank = makePowerBank();
    const room = mockRoom({ name: 'W40N57' });
    room.find = (type: number) => (type === FIND_STRUCTURES ? [bank] : []);
    // Wall off all but one of the 8 neighbors of (25,25).
    room.getTerrain = () =>
      makeTerrain([
        [24, 24],
        [25, 24],
        [26, 24],
        [24, 25],
        [26, 25],
        [24, 26],
        [25, 26],
        // (26,26) left open — only 1 free tile
      ]);

    recordHighwayIntel(room);

    expect(Memory.rooms['W40N57']?.scoutedPowerBank).toBeUndefined();
  });

  it('clears a previously-recorded power bank once it no longer qualifies (e.g. destroyed)', () => {
    (Memory as any).rooms['W40N57'] = {
      scoutedPowerBank: {
        id: 'bank1',
        x: 25,
        y: 25,
        power: 4000,
        ticksToDecay: 4000,
        freeAdjacentTiles: 8,
        recordedAtTick: 1,
      },
    };
    const room = mockRoom({ name: 'W40N57' });
    room.find = () => [];
    room.getTerrain = () => makeTerrain([]);

    recordHighwayIntel(room);

    expect(Memory.rooms['W40N57']?.scoutedPowerBank).toBeUndefined();
  });

  it('records deposits found in the room', () => {
    const deposit = makeDeposit();
    const room = mockRoom({ name: 'W40N57' });
    room.find = (type: number) => (type === FIND_DEPOSITS ? [deposit] : []);
    room.getTerrain = () => makeTerrain([]);

    recordHighwayIntel(room);

    expect(Memory.rooms['W40N57']?.scoutedDeposits).toEqual([
      {
        id: 'dep1',
        x: 10,
        y: 10,
        depositType: 'silicon',
        lastCooldown: 5,
        recordedAtTick: Game.time,
      },
    ]);
  });

  it('clears previously-recorded deposits once none remain', () => {
    (Memory as any).rooms['W40N57'] = {
      scoutedDeposits: [
        { id: 'dep1', x: 10, y: 10, depositType: 'silicon', lastCooldown: 5, recordedAtTick: 1 },
      ],
    };
    const room = mockRoom({ name: 'W40N57' });
    room.find = () => [];
    room.getTerrain = () => makeTerrain([]);

    recordHighwayIntel(room);

    expect(Memory.rooms['W40N57']?.scoutedDeposits).toBeUndefined();
  });
});
