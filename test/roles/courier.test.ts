/**
 * Tests for the courier role (src/roles/courier.ts) — the per-tick worker for a
 * TransportMission. COLLECT withdraws from the source's bank (incl. a foreign,
 * non-`my` storage); DELIVER deposits into the dest's OWN storage and credits the
 * mission's deliveredAmount; couriers stop pulling once the target cap is met.
 */
import { courier } from '../../src/roles/courier';
import {
  createTransportMission,
  resetMissions,
  TRANSPORT_DRAIN_ALL,
} from '../../src/utils/missions';
import { resetGameGlobals, mockCreep, mockRoom } from '../mocks/screeps';
import { resetTickCache } from '../../src/utils/tickCache';

const fullStore = (used: number, free = 0): any => ({
  getUsedCapacity: (_r?: string) => used,
  getFreeCapacity: (_r?: string) => free,
});

beforeEach(() => {
  resetGameGlobals();
  resetTickCache();
  resetMissions();
  (Memory as any).rooms = {};
});

describe('courier role', () => {
  it('COLLECT withdraws from the source room storage (incl. a foreign, non-my one)', () => {
    const m = createTransportMission('W2N1', 'W1N1', TRANSPORT_DRAIN_ALL);
    const foreignStorage = {
      my: false,
      pos: new RoomPosition(20, 20, 'W2N1'),
      store: { getUsedCapacity: (_r?: string) => 5000 },
    };
    const room = mockRoom({ name: 'W2N1', storage: foreignStorage, terminal: undefined });
    const creep = mockCreep({
      name: 'c1',
      room,
      memory: {
        role: 'courier',
        state: 'COLLECT',
        homeRoom: 'W1N1',
        targetRoom: 'W2N1',
        missionId: m.id,
      },
      store: fullStore(0, 1000),
      pos: new RoomPosition(20, 21, 'W2N1'),
    });
    Game.creeps = { c1: creep } as any;

    courier.run(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(
      foreignStorage,
      RESOURCE_ENERGY,
      expect.any(Number),
    );
  });

  it('DELIVER deposits into the dest OWN storage and credits deliveredAmount', () => {
    const m = createTransportMission('W2N1', 'W1N1', TRANSPORT_DRAIN_ALL);
    const ownStorage = {
      my: true,
      pos: new RoomPosition(16, 28, 'W1N1'),
      store: { getUsedCapacity: (_r?: string) => 0, getFreeCapacity: (_r?: string) => 1_000_000 },
    };
    const room = mockRoom({ name: 'W1N1', storage: ownStorage });
    const creep = mockCreep({
      name: 'c1',
      room,
      memory: {
        role: 'courier',
        state: 'DELIVER',
        homeRoom: 'W1N1',
        targetRoom: 'W2N1',
        missionId: m.id,
      },
      store: fullStore(500, 0),
      pos: new RoomPosition(16, 27, 'W1N1'),
    });
    Game.creeps = { c1: creep } as any;

    courier.run(creep);

    expect(creep.transfer).toHaveBeenCalledWith(ownStorage, RESOURCE_ENERGY);
    expect(m.deliveredAmount).toBe(500);
  });

  it('stops pulling once the target cap is met (goes to deliver what it carries)', () => {
    const m = createTransportMission('W2N1', 'W1N1', 100000);
    m.deliveredAmount = 100000; // target already met
    const room = mockRoom({
      name: 'W2N1',
      storage: {
        my: false,
        pos: new RoomPosition(20, 20, 'W2N1'),
        store: { getUsedCapacity: () => 5000 },
      },
    });
    const creep = mockCreep({
      name: 'c1',
      room,
      memory: {
        role: 'courier',
        state: 'COLLECT',
        homeRoom: 'W1N1',
        targetRoom: 'W2N1',
        missionId: m.id,
      },
      store: fullStore(200, 800), // carrying some
      pos: new RoomPosition(20, 21, 'W2N1'),
    });
    Game.creeps = { c1: creep } as any;

    courier.run(creep);

    expect(creep.withdraw).not.toHaveBeenCalled(); // target met → don't pull more
    expect(creep.memory.state).toBe('DELIVER'); // deliver the load it already has
  });
});
