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

describe('pickPriorityTarget', () => {
  it('returns undefined for room with no hostiles', () => {
    const room = mockRoom({
      find: vi.fn(() => []),
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
      find: vi.fn(() => [attacker, healer]),
    });
    expect(pickPriorityTarget(room)).toBe(healer);
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
      find: vi.fn(() => [strong, weak]),
    });
    // Same threat score, but weak has lower hits → higher composite score
    expect(pickPriorityTarget(room)).toBe(weak);
  });
});
