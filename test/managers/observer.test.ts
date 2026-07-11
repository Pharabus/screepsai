import { runObserver } from '../../src/managers/observer';
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

describe('runObserver', () => {
  beforeEach(() => {
    resetGameGlobals();
  });

  it('builds the queue from remoteRooms (sorted, deduped) and observes the first target', () => {
    const observer = mockObserverStub();
    const room = makeOwningRoom('W1N1', observer);
    Game.rooms['W1N1'] = room;
    Memory.rooms['W1N1'] = { remoteRooms: ['W3N1', 'W2N1', 'W2N1'] };

    runObserver();

    expect(observer.observeRoom).toHaveBeenCalledWith('W2N1');
    const mem = Memory.rooms['W1N1']!;
    expect(mem.observerQueue).toEqual(['W2N1', 'W3N1']);
    expect(mem.observerRequestedRoom).toBe('W2N1');
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

    runObserver();

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

    expect(() => runObserver()).not.toThrow();
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

    runObserver();

    expect(observer.observeRoom).toHaveBeenCalledWith('W3N1');
    expect(Memory.rooms['W1N1']!.observerQueueIdx).toBe(0);
  });

  it('rebuilds a stale queue after the rebuild interval and resets the cursor', () => {
    const observer = mockObserverStub();
    const room = makeOwningRoom('W1N1', observer);
    Game.rooms['W1N1'] = room;
    Game.time = 10_000;
    Memory.rooms['W1N1'] = {
      remoteRooms: ['W4N1'], // changed since the queue was last built
      observerQueue: ['W2N1', 'W3N1'],
      observerQueueIdx: 1,
      observerQueueBuiltAt: 9000, // > 500 ticks ago
    };

    runObserver();

    const mem = Memory.rooms['W1N1']!;
    expect(mem.observerQueue).toEqual(['W4N1']);
    expect(observer.observeRoom).toHaveBeenCalledWith('W4N1');
  });

  it('skips a room with no built observer', () => {
    const room = makeOwningRoom('W1N1'); // no observer
    Game.rooms['W1N1'] = room;
    Memory.rooms['W1N1'] = { remoteRooms: ['W2N1'] };

    runObserver();

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

    runObserver();

    expect(observer.observeRoom).not.toHaveBeenCalled();
  });

  it('does nothing when the queue is empty', () => {
    const observer = mockObserverStub();
    const room = makeOwningRoom('W1N1', observer);
    Game.rooms['W1N1'] = room;
    Memory.rooms['W1N1'] = { remoteRooms: [] };

    runObserver();

    expect(observer.observeRoom).not.toHaveBeenCalled();
  });
});
