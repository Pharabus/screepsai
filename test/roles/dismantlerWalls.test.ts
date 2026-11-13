import { dismantler } from '../../src/roles/dismantler';
import { mockCreep, mockRoom, resetGameGlobals } from '../mocks/screeps';

const Pos = (x: number, y: number, room: string) =>
  new (globalThis as any).RoomPosition(x, y, room);

const wall = (x: number, y: number) => ({
  structureType: 'constructedWall',
  pos: Pos(x, y, 'W2N1'),
  hits: 1_000_000,
});

/** A target room whose lookForAt answers from a tile->structures table. */
const wallRoom = (walls: ReturnType<typeof wall>[], controller?: object) =>
  mockRoom({
    name: 'W2N1',
    ...(controller ? { controller } : {}),
    lookForAt: vi.fn((_type: string, x: number, y: number) =>
      walls.filter((w) => w.pos.x === x && w.pos.y === y),
    ),
  });

const breaker = (room: any, state = 'DISMANTLE') =>
  mockCreep({
    memory: {
      role: 'dismantler',
      homeRoom: 'W1N1',
      targetRoom: 'W2N1',
      state,
      wallTiles: [
        { x: 19, y: 2 },
        { x: 19, y: 3 },
      ],
    },
    room,
    pos: Pos(25, 25, 'W2N1'),
  });

beforeEach(() => {
  resetGameGlobals();
});

describe('dismantler wall-breaker mode', () => {
  it('dismantles the wall on the first listed tile', () => {
    const w1 = wall(19, 2);
    const w2 = wall(19, 3);
    const creep = breaker(wallRoom([w1, w2]));

    dismantler.run(creep);

    expect(creep.dismantle).toHaveBeenCalledWith(w1);
  });

  it('moves to the next listed tile once an earlier wall is gone', () => {
    const w2 = wall(19, 3);
    const creep = breaker(wallRoom([w2]));

    dismantler.run(creep);

    expect(creep.dismantle).toHaveBeenCalledWith(w2);
  });

  it('ignores any structure that is not a constructed wall on a listed tile', () => {
    const road = { structureType: 'road', pos: Pos(19, 2, 'W2N1'), hits: 5000 };
    const w2 = wall(19, 3);
    const creep = breaker(wallRoom([road as any, w2]));

    dismantler.run(creep);

    expect(creep.dismantle).toHaveBeenCalledTimes(1);
    expect(creep.dismantle).toHaveBeenCalledWith(w2);
  });

  it('clears the order and retreats once every listed wall is gone', () => {
    (Memory as any).dismantleWalls = {
      room: 'W2N1',
      homeRoom: 'W1N1',
      tiles: [{ x: 19, y: 2 }],
      count: 2,
    };
    const creep = breaker(wallRoom([]));

    dismantler.run(creep);

    expect(creep.dismantle).not.toHaveBeenCalled();
    expect((Memory as any).dismantleWalls).toBeUndefined();
    expect(creep.memory.state).toBe('RETREAT');
  });

  it('does not wait for the room to be unowned, unlike the obstacle dismantler', () => {
    const w1 = wall(19, 2);
    const creep = breaker(wallRoom([w1], { my: false, owner: { username: 'someone' } }));

    dismantler.run(creep);

    expect(creep.dismantle).toHaveBeenCalledWith(w1);
  });

  it('keeps travelling when not yet in the target room', () => {
    const creep = mockCreep({
      memory: {
        role: 'dismantler',
        homeRoom: 'W1N1',
        targetRoom: 'W2N1',
        state: 'TRAVEL',
        wallTiles: [{ x: 19, y: 2 }],
      },
      room: mockRoom({ name: 'W1N1' }),
      pos: Pos(25, 25, 'W1N1'),
    });

    dismantler.run(creep);

    expect(creep.memory.state).toBe('TRAVEL');
    expect(creep.dismantle).not.toHaveBeenCalled();
  });

  it('leaves a clearing order for another room untouched', () => {
    (Memory as any).dismantleWalls = {
      room: 'W9N9',
      homeRoom: 'W1N1',
      tiles: [{ x: 1, y: 1 }],
      count: 1,
    };
    const creep = breaker(wallRoom([]));

    dismantler.run(creep);

    expect((Memory as any).dismantleWalls).toBeDefined();
  });
});
