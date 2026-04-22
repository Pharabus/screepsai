import { runStateMachine, StateMachineDefinition } from '../../src/utils/stateMachine';
import { mockCreep } from '../mocks/screeps';

describe('runStateMachine', () => {
  const definition: StateMachineDefinition = {
    IDLE: {
      run: vi.fn(() => undefined),
    },
    WORK: {
      run: vi.fn(() => undefined),
      onEnter: vi.fn(),
    },
    DONE: {
      run: vi.fn(() => undefined),
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses defaultState when memory.state is undefined', () => {
    const creep = mockCreep({ memory: { role: 'harvester' } });
    runStateMachine(creep, definition, 'IDLE');
    expect(definition.IDLE.run).toHaveBeenCalledWith(creep);
    expect(creep.memory.state).toBe('IDLE');
  });

  it('falls back to defaultState when state not in definition', () => {
    const creep = mockCreep({ memory: { role: 'harvester', state: 'INVALID' } });
    runStateMachine(creep, definition, 'IDLE');
    expect(definition.IDLE.run).toHaveBeenCalledWith(creep);
    expect(creep.memory.state).toBe('IDLE');
  });

  it('calls handler.run() for current state', () => {
    const creep = mockCreep({ memory: { role: 'harvester', state: 'WORK' } });
    runStateMachine(creep, definition, 'IDLE');
    expect(definition.WORK.run).toHaveBeenCalledWith(creep);
    expect(definition.IDLE.run).not.toHaveBeenCalled();
  });

  it('transitions when run() returns a new valid state', () => {
    vi.mocked(definition.IDLE.run).mockReturnValueOnce('WORK');
    const creep = mockCreep({ memory: { role: 'harvester', state: 'IDLE' } });
    runStateMachine(creep, definition, 'IDLE');
    expect(creep.memory.state).toBe('WORK');
  });

  it('calls onEnter() on the new state during transition', () => {
    vi.mocked(definition.IDLE.run).mockReturnValueOnce('WORK');
    const creep = mockCreep({ memory: { role: 'harvester', state: 'IDLE' } });
    runStateMachine(creep, definition, 'IDLE');
    expect(definition.WORK.onEnter).toHaveBeenCalledWith(creep);
  });

  it('does NOT transition when run() returns undefined', () => {
    const creep = mockCreep({ memory: { role: 'harvester', state: 'IDLE' } });
    runStateMachine(creep, definition, 'IDLE');
    expect(creep.memory.state).toBe('IDLE');
  });

  it('does NOT transition when run() returns the same state', () => {
    vi.mocked(definition.IDLE.run).mockReturnValueOnce('IDLE');
    const creep = mockCreep({ memory: { role: 'harvester', state: 'IDLE' } });
    runStateMachine(creep, definition, 'IDLE');
    expect(creep.memory.state).toBe('IDLE');
    expect(definition.WORK.onEnter).not.toHaveBeenCalled();
  });

  it('does NOT transition to unknown state', () => {
    vi.mocked(definition.IDLE.run).mockReturnValueOnce('NONEXISTENT');
    const creep = mockCreep({ memory: { role: 'harvester', state: 'IDLE' } });
    runStateMachine(creep, definition, 'IDLE');
    expect(creep.memory.state).toBe('IDLE');
  });
});
