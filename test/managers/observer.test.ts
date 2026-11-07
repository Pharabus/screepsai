import { runObserver, shouldObserveNow, OBSERVE_INTERVAL } from '../../src/managers/observer';
import { mockRoom, resetGameGlobals } from '../mocks/screeps';

function mockObserverStub(overrides: Record<string, any> = {}): any {
  return {
    structureType: STRUCTURE_OBSERVER,
    observeRoom: vi.fn(() => OK),
    ...overrides,
  };
}

// Dispatches room.find(type) by FIND_ constant, defaulting to []. Used both
// for the owning room (needs FIND_MY_STRUCTURES -> observer) and for a
// dark/observed target room (needs the finds recordRoomIntel touches).
function makeFindDispatch(byType: Partial<Record<number, any[]>>) {
  return vi.fn((type: number) => byType[type] ?? []);
}

function makeOwningRoom(name: string, observer?: any): any {
  return mockRoom({
    name,
    controller: { my: true, level: 8 },
    find: makeFindDispatch(observer ? { [FIND_MY_STRUCTURES]: [observer] } : {}),
  });
}

/** Advance Game.time to the next tick on which every owned test room is due to observe. */
function runAligned(): void {
  const names = Object.values(Game.rooms)
    .filter((r) => r.controller?.my)
    .map((r) => r.name);
  for (let i = 0; i < OBSERVE_INTERVAL * 20; i++) {
    if (names.every((n) => shouldObserveNow(n, Game.time))) break;
    Game.time++;
  }
  runObserver();
}

describe('runObserver', () => {
  beforeEach(() => {
    resetGameGlobals();
  });

  it('builds the queue from remoteRooms (sorted, deduped) and observes the first target', () => {
    // W15N15 and its remotes sit well clear of any grid line (nearest is
    // x/y=10 or 20), so the highway-ring search contributes nothing here.
    const observer = mockObserverStub();
    const room = makeOwningRoom('W15N15', observer);
    Game.rooms['W15N15'] = room;
    Memory.rooms['W15N15'] = { remoteRooms: ['W17N15', 'W16N15', 'W16N15'] };

    runAligned();

    expect(observer.observeRoom).toHaveBeenCalledWith('W16N15');
    const mem = Memory.rooms['W15N15']!;
    expect(mem.observerQueue).toEqual(['W16N15', 'W17N15']);
    expect(mem.observerRequestedRoom).toBe('W16N15');
    expect(mem.observerQueueIdx).toBe(1);
  });

  it('harvests intel from the room requested last tick', () => {
    const observer = mockObserverStub();
    const room = makeOwningRoom('W1N1', observer);
    Game.rooms['W1N1'] = room;
    Memory.rooms['W1N1'] = {
      remoteRooms: ['W2N1'],
      observerQueue: ['W2N1'],
      observerQueueIdx: 0,
      observerQueueBuiltAt: Game.time,
      observerRequestedRoom: 'W2N1',
    };

    const source = { id: 's1' as Id<Source>, pos: { x: 10, y: 10 } };
    const observedRoom = mockRoom({
      name: 'W2N1',
      controller: undefined,
      find: makeFindDispatch({ [FIND_SOURCES]: [source] }),
    });
    Game.rooms['W2N1'] = observedRoom;

    runAligned();

    const targetMem = Memory.rooms['W2N1']!;
    expect(targetMem.scoutedSources).toBe(1);
    expect(targetMem.scoutedAt).toBe(Game.time);
    // requestedRoom is consumed after harvesting, and the next target is requested.
    expect(Memory.rooms['W1N1']!.observerRequestedRoom).toBe('W2N1');
  });

  it('clears a stale requestedRoom that never gained vision, without throwing', () => {
    const observer = mockObserverStub();
    const room = makeOwningRoom('W1N1', observer);
    Game.rooms['W1N1'] = room;
    Memory.rooms['W1N1'] = {
      remoteRooms: ['W2N1'],
      observerQueue: ['W2N1'],
      observerQueueIdx: 0,
      observerQueueBuiltAt: Game.time,
      observerRequestedRoom: 'W2N1',
    };
    // Game.rooms['W2N1'] deliberately left undefined (no vision arrived).

    expect(() => runAligned()).not.toThrow();
    expect(Memory.rooms['W2N1']).toBeUndefined();
  });

  it('wraps the queue index around after reaching the end', () => {
    const observer = mockObserverStub();
    const room = makeOwningRoom('W1N1', observer);
    Game.rooms['W1N1'] = room;
    Memory.rooms['W1N1'] = {
      remoteRooms: ['W2N1', 'W3N1'],
      observerQueue: ['W2N1', 'W3N1'],
      observerQueueIdx: 1,
      observerQueueBuiltAt: Game.time,
    };

    runAligned();

    expect(observer.observeRoom).toHaveBeenCalledWith('W3N1');
    expect(Memory.rooms['W1N1']!.observerQueueIdx).toBe(0);
  });

  it('rebuilds a stale queue after the rebuild interval and resets the cursor', () => {
    const observer = mockObserverStub();
    const room = makeOwningRoom('W15N15', observer);
    Game.rooms['W15N15'] = room;
    Game.time = 10_000;
    Memory.rooms['W15N15'] = {
      remoteRooms: ['W17N15'], // changed since the queue was last built
      observerQueue: ['W16N15', 'W18N15'],
      observerQueueIdx: 1,
      observerQueueBuiltAt: 9000, // > 500 ticks ago
    };

    runAligned();

    const mem = Memory.rooms['W15N15']!;
    expect(mem.observerQueue).toEqual(['W17N15']);
    expect(observer.observeRoom).toHaveBeenCalledWith('W17N15');
  });

  it('skips a room with no built observer', () => {
    const room = makeOwningRoom('W1N1'); // no observer
    Game.rooms['W1N1'] = room;
    Memory.rooms['W1N1'] = { remoteRooms: ['W2N1'] };

    runAligned();

    expect(Memory.rooms['W1N1']!.observerQueue).toBeUndefined();
  });

  it('skips unowned rooms entirely', () => {
    const observer = mockObserverStub();
    const room = mockRoom({
      name: 'W9N9',
      controller: { my: false, level: 3 },
      find: makeFindDispatch({ [FIND_MY_STRUCTURES]: [observer] }),
    });
    Game.rooms['W9N9'] = room;

    runAligned();

    expect(observer.observeRoom).not.toHaveBeenCalled();
  });

  it('does nothing when the queue is empty', () => {
    const observer = mockObserverStub();
    const room = makeOwningRoom('W15N15', observer);
    Game.rooms['W15N15'] = room;
    Memory.rooms['W15N15'] = { remoteRooms: [] };

    runAligned();

    expect(observer.observeRoom).not.toHaveBeenCalled();
  });

  it('finds a highway room only reachable at radius 2, not radius 1', () => {
    // W8N5: x=8 is 2 away from the x=10 grid line, so it only enters range
    // at dx=-2 (ring 1, dx=-1, lands on x=9 — not a highway). Since the
    // highway test is "x OR y is a multiple of 10", every dy at that dx
    // qualifies too (x=10 alone is enough), so the whole W10 column across
    // the scanned dy range comes back, not just one cell.
    const observer = mockObserverStub();
    const room = makeOwningRoom('W8N5', observer);
    Game.rooms['W8N5'] = room;
    Memory.rooms['W8N5'] = { remoteRooms: [] };

    runAligned();

    expect(Memory.rooms['W8N5']!.observerQueue).toEqual([
      'W10N3',
      'W10N4',
      'W10N5',
      'W10N6',
      'W10N7',
    ]);
  });

  it('includes highway rooms in the queue alongside remoteRooms (sorted, deduped)', () => {
    const observer = mockObserverStub();
    const room = makeOwningRoom('W8N5', observer);
    Game.rooms['W8N5'] = room;
    Memory.rooms['W8N5'] = { remoteRooms: ['W3N5', 'W10N5'] }; // W10N5 dups a highway hit

    runAligned();

    expect(Memory.rooms['W8N5']!.observerQueue).toEqual([
      'W10N3',
      'W10N4',
      'W10N5',
      'W10N6',
      'W10N7',
      'W3N5',
    ]);
  });

  it('harvests highway intel (power bank), not remote intel, for a highway-room target', () => {
    const observer = mockObserverStub();
    const room = makeOwningRoom('W1N1', observer);
    Game.rooms['W1N1'] = room;
    Memory.rooms['W1N1'] = {
      remoteRooms: [],
      observerQueue: ['W10N1'],
      observerQueueIdx: 0,
      observerQueueBuiltAt: Game.time,
      observerRequestedRoom: 'W10N1',
    };

    const bank = {
      id: 'bank1',
      structureType: STRUCTURE_POWER_BANK,
      pos: { x: 25, y: 25 },
      power: 4000,
      ticksToDecay: 4000,
    };
    const observedRoom = mockRoom({
      name: 'W10N1',
      controller: undefined,
      find: (type: number) => (type === FIND_STRUCTURES ? [bank] : []),
      getTerrain: () => ({ get: () => 0 }), // fully open terrain
    });
    Game.rooms['W10N1'] = observedRoom;

    runAligned();

    const targetMem = Memory.rooms['W10N1']!;
    expect(targetMem.scoutedPowerBank).toMatchObject({ id: 'bank1', power: 4000 });
    // recordRoomIntel (the remote-room path) must NOT have run for this target.
    expect(targetMem.scoutedSources).toBeUndefined();
  });
});

describe('observe interval', () => {
  beforeEach(() => {
    resetGameGlobals();
  });

  it('requests at most once per OBSERVE_INTERVAL ticks, but harvests a pending request every tick', () => {
    const observer = mockObserverStub();
    Game.rooms['W15N15'] = makeOwningRoom('W15N15', observer);
    Memory.rooms['W15N15'] = { remoteRooms: ['W16N15', 'W17N15'] };
    let requests = 0;
    for (let t = 5000; t < 5000 + OBSERVE_INTERVAL * 4; t++) {
      Game.time = t;
      observer.observeRoom.mockClear();
      runObserver();
      if (observer.observeRoom.mock.calls.length > 0) requests++;
    }
    expect(requests).toBe(4);
  });

  it('staggers rooms by name', () => {
    const phases = new Set(
      ['W42N59', 'W43N58', 'W44N57', 'W44N59'].map((r) => {
        for (let t = 0; t < OBSERVE_INTERVAL; t++) if (shouldObserveNow(r, t)) return t;
        return -1;
      }),
    );
    expect(phases.size).toBeGreaterThan(1);
  });
});
