import { parseRoomName, isHighwayRoom, offsetRoomName } from '../../src/utils/roomName';

describe('parseRoomName', () => {
  it('parses all four quadrant sign combinations', () => {
    expect(parseRoomName('W44N57')).toEqual({ x: 44, y: 57 });
    expect(parseRoomName('E12N3')).toEqual({ x: 12, y: 3 });
    expect(parseRoomName('W8S20')).toEqual({ x: 8, y: 20 });
    expect(parseRoomName('E0S0')).toEqual({ x: 0, y: 0 });
  });

  it('returns undefined for a malformed or non-room-shaped string', () => {
    expect(parseRoomName('not-a-room')).toBeUndefined();
    expect(parseRoomName('sim')).toBeUndefined();
    expect(parseRoomName('')).toBeUndefined();
  });
});

describe('isHighwayRoom', () => {
  it('is true when the x coordinate is a multiple of 10', () => {
    expect(isHighwayRoom('W40N23')).toBe(true);
    expect(isHighwayRoom('E10S5')).toBe(true);
    expect(isHighwayRoom('W0N5')).toBe(true);
  });

  it('is true when the y coordinate is a multiple of 10', () => {
    expect(isHighwayRoom('W23N40')).toBe(true);
    expect(isHighwayRoom('E5S10')).toBe(true);
  });

  it('is false when neither coordinate is a multiple of 10', () => {
    expect(isHighwayRoom('W44N57')).toBe(false);
    expect(isHighwayRoom('E12N3')).toBe(false);
  });

  it('correctly rejects a 3-digit coordinate that merely contains a 0 digit', () => {
    // Regression guard against the naive "roomName.includes('0')" shortcut
    // (seen in other bots) — 105 is not a multiple of 10.
    expect(isHighwayRoom('W105N23')).toBe(false);
  });

  it('is false for a malformed room name', () => {
    expect(isHighwayRoom('sim')).toBe(false);
  });
});

describe('offsetRoomName', () => {
  it('steps within a single quadrant without crossing a seam', () => {
    expect(offsetRoomName('W15N15', -2, 0)).toBe('W17N15'); // west increases W-number
    expect(offsetRoomName('W15N15', 2, 0)).toBe('W13N15'); // east decreases W-number
    expect(offsetRoomName('W15N15', 0, -2)).toBe('W15N17'); // north increases N-number
    expect(offsetRoomName('W15N15', 0, 2)).toBe('W15N13'); // south decreases N-number
  });

  it('crosses the W0/E0 seam correctly', () => {
    expect(offsetRoomName('W0N15', 1, 0)).toBe('E0N15'); // one room east of W0 is E0, not W-1
    expect(offsetRoomName('E0N15', -1, 0)).toBe('W0N15');
    expect(offsetRoomName('E5N15', -6, 0)).toBe('W0N15');
    expect(offsetRoomName('W5N15', 6, 0)).toBe('E0N15');
  });

  it('crosses the N0/S0 seam correctly', () => {
    expect(offsetRoomName('W15N0', 0, 1)).toBe('W15S0'); // one room south of N0 is S0, not N-1
    expect(offsetRoomName('W15S0', 0, -1)).toBe('W15N0');
  });

  it('crosses both seams simultaneously', () => {
    expect(offsetRoomName('W2S2', 3, -3)).toBe('E0N0');
  });

  it('returns undefined for a malformed room name', () => {
    expect(offsetRoomName('sim', 1, 1)).toBeUndefined();
  });
});
