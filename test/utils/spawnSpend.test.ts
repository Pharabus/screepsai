import { recordSpawnSpend, SPAWN_SPEND_WINDOW } from '../../src/utils/spawnSpend';
import { resetGameGlobals } from '../mocks/screeps';

describe('recordSpawnSpend', () => {
  beforeEach(() => {
    resetGameGlobals();
    (globalThis as any).Game.time = 1000;
    (globalThis as any).BODYPART_COST = { work: 100, carry: 50, move: 50, claim: 600 };
  });

  it('accumulates count and cost per room and role', () => {
    recordSpawnSpend('W1N1', 'hauler', ['carry', 'move']);
    recordSpawnSpend('W1N1', 'hauler', ['carry', 'move']);
    expect((globalThis as any).Memory.spawnSpend.rooms.W1N1.hauler).toEqual({ n: 2, cost: 200 });
  });

  it('keys creeps working another room by role and target', () => {
    recordSpawnSpend('W1N1', 'miner', ['work', 'move'], 'W2N1');
    recordSpawnSpend('W1N1', 'miner', ['work', 'move'], 'W1N1');
    const rooms = (globalThis as any).Memory.spawnSpend.rooms.W1N1;
    expect(rooms['miner>W2N1'].n).toBe(1);
    expect(rooms.miner.n).toBe(1);
  });

  it('rolls the window and keeps the previous one', () => {
    recordSpawnSpend('W1N1', 'hauler', ['carry']);
    (globalThis as any).Game.time = 1000 + SPAWN_SPEND_WINDOW;
    recordSpawnSpend('W1N1', 'upgrader', ['work']);
    const s = (globalThis as any).Memory.spawnSpend;
    expect(s.prev.rooms.W1N1.hauler.cost).toBe(50);
    expect(s.rooms.W1N1.hauler).toBeUndefined();
    expect(s.rooms.W1N1.upgrader.cost).toBe(100);
  });
});
