import {
  classifyKeeperKillerEnd,
  formatKeeperStats,
  observeKeeperLairs,
  recordKeeperKillerEnd,
  recordKillerPatrolTick,
  spawnTickFromName,
} from '../../src/utils/keeperStats';
import { resetTickCache } from '../../src/utils/tickCache';
import { mockRoom, resetGameGlobals } from '../mocks/screeps';

const lairRoom = (name: string, timers: (number | undefined)[]) =>
  mockRoom({
    name,
    find: vi.fn(() =>
      timers.map((t, i) => ({
        id: `${name}-lair${i}`,
        structureType: 'keeperLair',
        ticksToSpawn: t,
      })),
    ),
  });

describe('keeperStats', () => {
  beforeEach(() => {
    resetGameGlobals();
    resetTickCache();
    (globalThis as any).Memory.rooms = { W1N1: { scoutedHasKeepers: true } };
  });

  describe('classification', () => {
    it('parses the spawn tick from the creep name', () => {
      expect(spawnTickFromName('keeperKiller_W44N57_84306403')).toBe(84306403);
      expect(spawnTickFromName('nonumber')).toBeUndefined();
    });

    it('calls an early death without retreat a loss', () => {
      expect(classifyKeeperKillerEnd('PATROL', 400)).toBe('lost');
      expect(classifyKeeperKillerEnd('TRAVEL', 20)).toBe('lost');
    });

    it('calls a RETREAT death retired even when early', () => {
      expect(classifyKeeperKillerEnd('RETREAT', 1200)).toBe('retired');
    });

    it('calls a full-lifetime death expired', () => {
      expect(classifyKeeperKillerEnd('PATROL', 1500)).toBe('expired');
    });
  });

  describe('recordKeeperKillerEnd', () => {
    it('counts a lost killer, its age and logs it to the combat log', () => {
      (globalThis as any).Game.time = 1000;
      recordKeeperKillerEnd('keeperKiller_W2N2_700', {
        role: 'keeperKiller',
        targetRoom: 'W1N1',
        state: 'PATROL',
      } as any);
      const s = (globalThis as any).Memory.keeperStats.W1N1;
      expect(s.lost).toBe(1);
      expect(s.lostAgeSum).toBe(300);
      expect(s.lastLostTick).toBe(1000);
      const log = (globalThis as any).Memory.combatLog;
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({ room: 'W1N1', event: 'keeper_killer_lost' });
    });

    it('does not log retirements or expiries to the combat log', () => {
      (globalThis as any).Game.time = 3000;
      recordKeeperKillerEnd('keeperKiller_W2N2_1000', {
        role: 'keeperKiller',
        targetRoom: 'W1N1',
        state: 'PATROL',
      } as any);
      recordKeeperKillerEnd('keeperKiller_W2N2_2900', {
        role: 'keeperKiller',
        targetRoom: 'W1N1',
        state: 'RETREAT',
      } as any);
      const s = (globalThis as any).Memory.keeperStats.W1N1;
      expect(s.expired).toBe(1);
      expect(s.retired).toBe(1);
      expect(s.lost).toBe(0);
      expect((globalThis as any).Memory.combatLog).toBeUndefined();
    });

    it('ignores other roles and creeps without a target room', () => {
      recordKeeperKillerEnd('hauler_W2N2_10', { role: 'hauler', targetRoom: 'W1N1' } as any);
      recordKeeperKillerEnd('keeperKiller_W2N2_10', { role: 'keeperKiller' } as any);
      expect((globalThis as any).Memory.keeperStats).toBeUndefined();
    });
  });

  describe('observeKeeperLairs', () => {
    const tick = (timers: (number | undefined)[], time: number) => {
      (globalThis as any).Game.time = time;
      (globalThis as any).Game.rooms = { W1N1: lairRoom('W1N1', timers) };
      resetTickCache();
      observeKeeperLairs();
    };

    it('counts a kill when a lair timer appears after the keeper was alive', () => {
      tick([undefined, undefined], 100);
      expect((globalThis as any).Memory.keeperStats).toBeUndefined();
      tick([300, undefined], 101);
      tick([299, undefined], 102);
      const s = (globalThis as any).Memory.keeperStats.W1N1;
      expect(s.kills).toBe(1);
      expect(s.lastKillTick).toBe(101);
    });

    it('counts a second keeper dying later as its own kill', () => {
      tick([undefined, undefined], 200);
      tick([300, undefined], 201);
      tick([250, 300], 251);
      expect((globalThis as any).Memory.keeperStats.W1N1.kills).toBe(2);
    });

    it('does not count a stale timer first seen mid-countdown', () => {
      tick([120, undefined], 300);
      expect((globalThis as any).Memory.keeperStats).toBeUndefined();
    });

    it('ignores rooms that are not keeper rooms', () => {
      (globalThis as any).Memory.rooms = { W1N1: {} };
      tick([undefined], 400);
      tick([300], 401);
      expect((globalThis as any).Memory.keeperStats).toBeUndefined();
    });
  });

  describe('formatKeeperStats', () => {
    it('reports no activity when empty', () => {
      expect(formatKeeperStats()).toBe('no keeper activity recorded');
    });

    it('reports kills per 1000 patrol ticks and flags losing killers', () => {
      for (let i = 0; i < 500; i++) recordKillerPatrolTick('W1N1');
      (globalThis as any).Memory.keeperStats.W1N1.kills = 4;
      (globalThis as any).Memory.keeperStats.W1N1.lost = 2;
      const out = formatKeeperStats();
      expect(out).toContain('kills=4');
      expect(out).toContain('kills/1k=8.0');
      expect(out).toContain('killers lost=2');
      expect(out).toContain('LOSING KILLERS');
    });
  });
});
