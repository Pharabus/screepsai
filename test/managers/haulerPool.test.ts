import { assignHaulers } from '../../src/managers/haulerPool';
import { mockRoom, resetGameGlobals } from '../mocks/screeps';
import { resetTickCache } from '../../src/utils/tickCache';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockStore(contents: Record<string, number> = {}, capacity = 2000): any {
  const store: Record<string, any> = { ...contents };
  Object.defineProperty(store, 'getUsedCapacity', {
    enumerable: false,
    value: vi.fn((r?: string) => {
      if (r === undefined) return Object.values(contents).reduce((a, b) => a + b, 0);
      return contents[r] ?? 0;
    }),
  });
  Object.defineProperty(store, 'getFreeCapacity', {
    enumerable: false,
    value: vi.fn(() => {
      const used = Object.values(contents).reduce((a, b) => a + b, 0);
      return Math.max(0, capacity - used);
    }),
  });
  return store;
}

function mockContainer(id: string, energy: number, x: number, y: number, roomName = 'W1N1'): any {
  return {
    id,
    structureType: STRUCTURE_CONTAINER,
    pos: new RoomPosition(x, y, roomName),
    store: mockStore({ energy }, 2000),
  };
}

function mockHaulerCreep(
  name: string,
  x: number,
  y: number,
  roomName = 'W1N1',
  freeCapacity = 300,
): any {
  return {
    name,
    memory: { role: 'hauler', homeRoom: roomName, state: 'PICKUP' },
    pos: new RoomPosition(x, y, roomName),
    store: {
      getFreeCapacity: vi.fn(() => freeCapacity),
      getUsedCapacity: vi.fn(() => 0),
    },
    room: { name: roomName },
  };
}

function setupRoom(containers: any[], haulers: any[], roomName = 'W1N1'): any {
  // Build Game.creeps from haulers
  const creepsMap: Record<string, any> = {};
  for (const h of haulers) creepsMap[h.name] = h;
  (Game as any).creeps = creepsMap;

  // Setup Memory.rooms
  (Memory as any).rooms = { [roomName]: {} };

  // Room.find(FIND_STRUCTURES) returns all containers
  const room = mockRoom({
    name: roomName,
    find: vi.fn((type: number) => {
      if (type === FIND_STRUCTURES) return [...containers];
      return [];
    }),
  });

  return room;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('assignHaulers', () => {
  beforeEach(() => {
    resetGameGlobals();
    resetTickCache();
  });

  it('returns empty map when there are no source containers', () => {
    const hauler1 = mockHaulerCreep('h1', 25, 25);
    const room = setupRoom([], [hauler1]);
    const result = assignHaulers(room);
    expect(result).toEqual({});
  });

  it('returns empty map when there are no PICKUP-state haulers', () => {
    const container = mockContainer('c1', 1500, 10, 10);
    const deliverHauler = {
      name: 'h1',
      memory: { role: 'hauler', homeRoom: 'W1N1', state: 'DELIVER' },
      pos: new RoomPosition(25, 25, 'W1N1'),
      store: { getFreeCapacity: vi.fn(() => 0), getUsedCapacity: vi.fn(() => 300) },
    };
    const room = setupRoom([container], [deliverHauler]);
    const result = assignHaulers(room);
    expect(result).toEqual({});
  });

  it('returns empty map when all containers have 0 energy', () => {
    const emptyContainer = mockContainer('c1', 0, 10, 10);
    const hauler1 = mockHaulerCreep('h1', 12, 12);
    const room = setupRoom([emptyContainer], [hauler1]);
    const result = assignHaulers(room);
    expect(result).toEqual({});
  });

  it('assigns sole hauler to the only source container', () => {
    const container = mockContainer('c1', 1500, 10, 10);
    const hauler1 = mockHaulerCreep('h1', 12, 12);
    const room = setupRoom([container], [hauler1]);
    const result = assignHaulers(room);
    expect(result['h1']).toBe('c1');
  });

  it('assigns hauler to the fullest container when only one hauler exists', () => {
    const big = mockContainer('cBig', 2000, 40, 40);
    const small = mockContainer('cSmall', 300, 10, 10);
    const hauler1 = mockHaulerCreep('h1', 12, 12); // near cSmall but cBig is fullest
    const room = setupRoom([small, big], [hauler1]);
    const result = assignHaulers(room);
    // Fullest container (cBig, 2000) gets the sole hauler
    expect(result['h1']).toBe('cBig');
  });

  it('spreads two haulers across two similarly-full containers', () => {
    // cA (1900) is near h2; cB (1800) is near h1.
    // Pool: round1 picks cA (highest), assigns nearest hauler (h2) → cA remaining 1600.
    //       round2: cB (1800) > cA (1600), assigns nearest hauler (h1) → cB.
    // Result: h1→cB (near h1), h2→cA (near h2). Haulers spread!
    const cA = mockContainer('cA', 1900, 10, 10);
    const cB = mockContainer('cB', 1800, 40, 40);
    const h1 = mockHaulerCreep('h1', 38, 38); // near cB
    const h2 = mockHaulerCreep('h2', 12, 12); // near cA
    const room = setupRoom([cA, cB], [h1, h2]);

    const result = assignHaulers(room);
    expect(result['h2']).toBe('cA'); // h2 (near cA) assigned to cA
    expect(result['h1']).toBe('cB'); // h1 (near cB) assigned to cB
  });

  it('does not assign both haulers to one near-empty container while a fuller one is unassigned', () => {
    // cFull (1800) and cEmpty (50). After assigning first hauler to cFull
    // (remaining = 1500), cFull (1500) >> cEmpty (50), so second hauler also goes to cFull.
    // Neither hauler is assigned to cEmpty.
    const cFull = mockContainer('cFull', 1800, 10, 10);
    const cEmpty = mockContainer('cEmpty', 50, 40, 40);
    const h1 = mockHaulerCreep('h1', 12, 12); // near cFull
    const h2 = mockHaulerCreep('h2', 42, 42); // near cEmpty
    const room = setupRoom([cFull, cEmpty], [h1, h2]);

    const result = assignHaulers(room);
    // Both haulers should be directed to cFull (much higher need)
    expect(result['h1']).toBe('cFull');
    expect(result['h2']).toBe('cFull');
    // cEmpty is near-empty — nobody should be assigned there
    expect(Object.values(result)).not.toContain('cEmpty');
  });

  it('leaves extra haulers unassigned when container need is satisfied', () => {
    // Container holds exactly one hauler's worth (300 energy, carry = 300).
    // Two haulers: second should be unassigned.
    const container = mockContainer('c1', 300, 10, 10);
    const h1 = mockHaulerCreep('h1', 12, 12, 'W1N1', 300);
    const h2 = mockHaulerCreep('h2', 15, 15, 'W1N1', 300);
    const room = setupRoom([container], [h1, h2]);

    const result = assignHaulers(room);
    const assignedCount = Object.keys(result).length;
    // After assigning h1 (nearest), container remaining = 0. h2 unassigned.
    expect(assignedCount).toBe(1);
    expect(Object.values(result)).toContain('c1');
  });

  it('excludes the controller container from assignment', () => {
    const sourceContainer = mockContainer('cSrc', 1500, 10, 10);
    const controllerContainer = mockContainer('cCtrl', 1500, 40, 40);
    (Memory as any).rooms['W1N1'] = { controllerContainerId: 'cCtrl' };

    const hauler1 = mockHaulerCreep('h1', 41, 41); // physically close to controller container
    const room = mockRoom({
      name: 'W1N1',
      find: vi.fn((type: number) => {
        if (type === FIND_STRUCTURES) return [sourceContainer, controllerContainer];
        return [];
      }),
    });
    (Game as any).creeps = { h1: hauler1 };

    const result = assignHaulers(room);
    // Must be assigned to source container, NOT controller container
    expect(result['h1']).toBe('cSrc');
    expect(result['h1']).not.toBe('cCtrl');
  });

  it('excludes the mineral container from assignment', () => {
    const sourceContainer = mockContainer('cSrc', 1500, 10, 10);
    const mineralContainer = mockContainer('cMin', 1500, 40, 40);
    (Memory as any).rooms['W1N1'] = { mineralContainerId: 'cMin' };

    const hauler1 = mockHaulerCreep('h1', 41, 41); // near mineral container
    const room = mockRoom({
      name: 'W1N1',
      find: vi.fn((type: number) => {
        if (type === FIND_STRUCTURES) return [sourceContainer, mineralContainer];
        return [];
      }),
    });
    (Game as any).creeps = { h1: hauler1 };

    const result = assignHaulers(room);
    // Must not be assigned to the mineral container
    expect(result['h1']).toBe('cSrc');
    expect(result['h1']).not.toBe('cMin');
  });

  it('uses proximity to break ties when containers have equal energy', () => {
    // Both containers have 1500 energy. h1 is closer to cB.
    // Round1: cA (1500) vs cB (1500) — tie-break by id. Let 'cA' < 'cB' lexicographically,
    // so cA wins. Nearest hauler to cA = h1 (range ~2).
    // But h1 is physically close to cB (range ~2) and far from cA (range ~28).
    // Proximity applies to which HAULER is nearest to the chosen container, not
    // which container is nearest to the hauler. cA is chosen first (fullest/id tie-break),
    // then h2 (range 2 from cA) is assigned. cB (remaining 1500) gets h1 (range 2 from cB).
    const cA = mockContainer('cA', 1500, 10, 10); // 'cA' < 'cB'
    const cB = mockContainer('cB', 1500, 40, 40);
    const h1 = mockHaulerCreep('h1', 38, 38, 'W1N1', 300); // near cB
    const h2 = mockHaulerCreep('h2', 12, 12, 'W1N1', 300); // near cA
    const room = setupRoom([cA, cB], [h1, h2]);

    const result = assignHaulers(room);
    // h2 (near cA) → cA, h1 (near cB) → cB
    expect(result['h2']).toBe('cA');
    expect(result['h1']).toBe('cB');
  });

  it('output is deterministic across repeated calls within the same tick', () => {
    const cA = mockContainer('cA', 1900, 10, 10);
    const cB = mockContainer('cB', 1800, 40, 40);
    const h1 = mockHaulerCreep('h1', 38, 38);
    const h2 = mockHaulerCreep('h2', 12, 12);
    const room = setupRoom([cA, cB], [h1, h2]);

    const result1 = assignHaulers(room);
    // Second call should return the cached object (same reference)
    const result2 = assignHaulers(room);
    expect(result2).toBe(result1);
  });

  it('only includes haulers with homeRoom matching the room', () => {
    const container = mockContainer('c1', 1500, 10, 10);
    const rightRoom = mockHaulerCreep('hRight', 12, 12, 'W1N1');
    const wrongRoom: any = {
      name: 'hWrong',
      memory: { role: 'hauler', homeRoom: 'W99N99', state: 'PICKUP' },
      pos: new RoomPosition(12, 12, 'W1N1'),
      store: { getFreeCapacity: vi.fn(() => 300), getUsedCapacity: vi.fn(() => 0) },
    };
    const room = setupRoom([container], [rightRoom, wrongRoom]);

    const result = assignHaulers(room);
    expect(result['hRight']).toBe('c1');
    expect(result['hWrong']).toBeUndefined();
  });

  it('ignores haulers not in PICKUP state', () => {
    const container = mockContainer('c1', 1500, 10, 10);
    const pickupHauler = mockHaulerCreep('hPickup', 12, 12, 'W1N1', 300);
    const deliverHauler: any = {
      name: 'hDeliver',
      memory: { role: 'hauler', homeRoom: 'W1N1', state: 'DELIVER' },
      pos: new RoomPosition(11, 11, 'W1N1'),
      store: { getFreeCapacity: vi.fn(() => 0), getUsedCapacity: vi.fn(() => 300) },
    };
    const room = setupRoom([container], [pickupHauler, deliverHauler]);

    const result = assignHaulers(room);
    expect(result['hPickup']).toBe('c1');
    expect(result['hDeliver']).toBeUndefined();
  });
});
