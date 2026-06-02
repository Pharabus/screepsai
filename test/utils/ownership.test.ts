/**
 * Tests for myStorage / myTerminal ownership helpers (src/utils/ownership.ts).
 */
import '../mocks/screeps';
import { myStorage, myTerminal } from '../../src/utils/ownership';
import { mockRoom, resetGameGlobals } from '../mocks/screeps';

beforeEach(() => {
  resetGameGlobals();
});

describe('myStorage', () => {
  it('returns the storage when room.storage.my is true', () => {
    const storage = { my: true, store: {}, pos: new RoomPosition(25, 25, 'W1N1') };
    const room = mockRoom({ name: 'W1N1', storage });
    expect(myStorage(room as any)).toBe(storage);
  });

  it('returns undefined when room.storage.my is false (foreign storage)', () => {
    const storage = { my: false, store: {}, pos: new RoomPosition(25, 25, 'W1N1') };
    const room = mockRoom({ name: 'W1N1', storage });
    expect(myStorage(room as any)).toBeUndefined();
  });

  it('returns undefined when room.storage is undefined', () => {
    const room = mockRoom({ name: 'W1N1', storage: undefined });
    expect(myStorage(room as any)).toBeUndefined();
  });

  it('returns undefined when room.storage.my is undefined (absent = not ours)', () => {
    // A storage object without a .my property should be treated as foreign.
    const storage = { store: {}, pos: new RoomPosition(25, 25, 'W1N1') };
    const room = mockRoom({ name: 'W1N1', storage });
    expect(myStorage(room as any)).toBeUndefined();
  });
});

describe('myTerminal', () => {
  it('returns the terminal when room.terminal.my is true', () => {
    const terminal = { my: true, store: {}, pos: new RoomPosition(26, 25, 'W1N1') };
    const room = mockRoom({ name: 'W1N1', terminal });
    expect(myTerminal(room as any)).toBe(terminal);
  });

  it('returns undefined when room.terminal.my is false (foreign terminal)', () => {
    const terminal = { my: false, store: {}, pos: new RoomPosition(26, 25, 'W1N1') };
    const room = mockRoom({ name: 'W1N1', terminal });
    expect(myTerminal(room as any)).toBeUndefined();
  });

  it('returns undefined when room.terminal is undefined', () => {
    const room = mockRoom({ name: 'W1N1', terminal: undefined });
    expect(myTerminal(room as any)).toBeUndefined();
  });

  it('returns undefined when room.terminal.my is undefined (absent = not ours)', () => {
    const terminal = { store: {}, pos: new RoomPosition(26, 25, 'W1N1') };
    const room = mockRoom({ name: 'W1N1', terminal });
    expect(myTerminal(room as any)).toBeUndefined();
  });
});
