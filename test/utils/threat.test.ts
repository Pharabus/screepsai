import { threatScore, pickPriorityTarget } from '../../src/utils/threat';
import { mockCreep, mockRoom } from '../mocks/screeps';

describe('threatScore', () => {
  it('scores a healer higher than an attacker', () => {
    const healer = mockCreep({
      body: [{ type: HEAL, hits: 100 }],
    });
    const attacker = mockCreep({
      body: [{ type: ATTACK, hits: 100 }],
    });
    expect(threatScore(healer)).toBeGreaterThan(threatScore(attacker));
  });

  it('ignores dead body parts', () => {
    const creep = mockCreep({
      body: [
        { type: HEAL, hits: 0 },
        { type: ATTACK, hits: 100 },
      ],
    });
    // Only ATTACK scores (80), not HEAL
    expect(threatScore(creep)).toBe(80);
  });

  it('returns 0 for scout with no combat parts', () => {
    const scout = mockCreep({
      body: [
        { type: MOVE, hits: 100 },
        { type: TOUGH, hits: 100 },
      ],
    });
    expect(threatScore(scout)).toBe(0);
  });

  it('sums threat from multiple parts', () => {
    const creep = mockCreep({
      body: [
        { type: HEAL, hits: 100 },
        { type: HEAL, hits: 100 },
        { type: ATTACK, hits: 100 },
      ],
    });
    // 250 + 250 + 80 = 580
    expect(threatScore(creep)).toBe(580);
  });

  it('scores WORK parts for structure dismantling', () => {
    const dismantler = mockCreep({
      body: [{ type: WORK, hits: 100 }],
    });
    expect(threatScore(dismantler)).toBe(30);
  });
});

function hostileFind(hostiles: any[], towers: any[] = []) {
  return vi.fn((type: number) => {
    if (type === FIND_HOSTILE_CREEPS) return hostiles;
    if (type === FIND_MY_STRUCTURES) return towers;
    return [];
  });
}

describe('pickPriorityTarget', () => {
  it('returns undefined for room with no hostiles', () => {
    const room = mockRoom({
      find: hostileFind([]),
    });
    expect(pickPriorityTarget(room)).toBeUndefined();
  });

  it('returns the highest-scoring hostile', () => {
    const healer = mockCreep({
      name: 'healer',
      body: [{ type: HEAL, hits: 100 }],
      hits: 100,
    });
    const attacker = mockCreep({
      name: 'attacker',
      body: [{ type: ATTACK, hits: 100 }],
      hits: 100,
    });
    const room = mockRoom({
      find: hostileFind([attacker, healer]),
    });
    expect(pickPriorityTarget(room)).toBe(healer);
  });

  it('returns a zero-threat hostile (e.g. stripped invader or scout)', () => {
    const scout = mockCreep({
      name: 'scout',
      body: [{ type: MOVE, hits: 100 }],
      hits: 100,
    });
    const room = mockRoom({
      find: hostileFind([scout]),
    });
    expect(pickPriorityTarget(room)).toBe(scout);
  });

  it('breaks ties by lower hits', () => {
    const strong = mockCreep({
      name: 'strong',
      body: [{ type: ATTACK, hits: 100 }],
      hits: 200,
    });
    const weak = mockCreep({
      name: 'weak',
      body: [{ type: ATTACK, hits: 100 }],
      hits: 50,
    });
    const room = mockRoom({
      find: hostileFind([strong, weak]),
    });
    // Same threat score, but weak has lower hits → higher composite score
    expect(pickPriorityTarget(room)).toBe(weak);
  });

  it('prefers closer hostile when threat scores are equal', () => {
    const tower = {
      structureType: STRUCTURE_TOWER,
      pos: new RoomPosition(25, 25, 'W1N1'),
    };
    const nearHostile = mockCreep({
      name: 'near',
      body: [{ type: MOVE, hits: 100 }],
      hits: 100,
      pos: new RoomPosition(27, 25, 'W1N1'),
    });
    const farHostile = mockCreep({
      name: 'far',
      body: [{ type: MOVE, hits: 100 }],
      hits: 100,
      pos: new RoomPosition(48, 25, 'W1N1'),
    });
    const room = mockRoom({
      find: hostileFind([farHostile, nearHostile], [tower]),
    });
    expect(pickPriorityTarget(room)).toBe(nearHostile);
  });

  it('high-threat target at long range still beats zero-threat at short range', () => {
    const tower = {
      structureType: STRUCTURE_TOWER,
      pos: new RoomPosition(25, 25, 'W1N1'),
    };
    const healer = mockCreep({
      name: 'healer',
      body: [{ type: HEAL, hits: 100 }],
      hits: 100,
      pos: new RoomPosition(48, 25, 'W1N1'),
    });
    const scout = mockCreep({
      name: 'scout',
      body: [{ type: MOVE, hits: 100 }],
      hits: 100,
      pos: new RoomPosition(26, 25, 'W1N1'),
    });
    const room = mockRoom({
      find: hostileFind([scout, healer], [tower]),
    });
    expect(pickPriorityTarget(room)).toBe(healer);
  });

  it('uses average range across multiple towers', () => {
    const tower1 = {
      structureType: STRUCTURE_TOWER,
      pos: new RoomPosition(20, 25, 'W1N1'),
    };
    const tower2 = {
      structureType: STRUCTURE_TOWER,
      pos: new RoomPosition(30, 25, 'W1N1'),
    };
    // Hostile far from both towers: avg range 20
    const hostileFar = mockCreep({
      name: 'far',
      body: [{ type: MOVE, hits: 100 }],
      hits: 100,
      pos: new RoomPosition(45, 25, 'W1N1'),
    });
    // Hostile centered between towers: avg range 5
    const hostileCentered = mockCreep({
      name: 'centered',
      body: [{ type: MOVE, hits: 100 }],
      hits: 100,
      pos: new RoomPosition(25, 25, 'W1N1'),
    });
    const room = mockRoom({
      find: hostileFind([hostileFar, hostileCentered], [tower1, tower2]),
    });
    expect(pickPriorityTarget(room)).toBe(hostileCentered);
  });

  it('defaults to full effectiveness when no towers exist', () => {
    const near = mockCreep({
      name: 'near',
      body: [{ type: ATTACK, hits: 100 }],
      hits: 100,
      pos: new RoomPosition(26, 25, 'W1N1'),
    });
    const far = mockCreep({
      name: 'far',
      body: [{ type: ATTACK, hits: 100 }],
      hits: 100,
      pos: new RoomPosition(48, 25, 'W1N1'),
    });
    const room = mockRoom({
      find: hostileFind([far, near]),
    });
    // No towers → effectiveness is 1.0 for both → same score → first one wins
    // Both have same threat and hits, so the first in the array wins (far)
    expect(pickPriorityTarget(room)).toBe(far);
  });
});
