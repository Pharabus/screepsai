export interface StateHandler {
  run(creep: Creep): string | undefined;
  onEnter?(creep: Creep): void;
}

export type StateMachineDefinition = Record<string, StateHandler>;

export function runStateMachine(
  creep: Creep,
  definition: StateMachineDefinition,
  defaultState: string,
): void {
  let state = creep.memory.state ?? defaultState;

  if (!definition[state]) {
    state = defaultState;
  }

  const handler = definition[state]!;
  const next = handler.run(creep);

  if (next !== undefined && next !== state && definition[next]) {
    creep.memory.state = next;
    definition[next]!.onEnter?.(creep);
  } else {
    creep.memory.state = state;
  }
}
