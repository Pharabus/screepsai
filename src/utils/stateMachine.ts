export interface StateHandler {
  run(creep: Creep): string | undefined;
  onEnter?(creep: Creep): void;
}

export type StateMachineDefinition = Record<string, StateHandler>;

// Cap on chained state transitions per tick. 4 is enough for any realistic
// trip: a creep can land in a border tile and traverse TRAVEL → CLAIM → TRAVEL
// once before settling, plus headroom. Higher would mask a runaway loop.
const MAX_STATE_CHAIN = 4;

export function runStateMachine(
  creep: Creep,
  definition: StateMachineDefinition,
  defaultState: string,
): void {
  let state = creep.memory.state ?? defaultState;
  if (!definition[state]) {
    state = defaultState;
  }

  // Chain handlers when a state transition occurs in the same tick. The
  // canonical case: TRAVEL detects arrival in the target room and returns the
  // next state (CLAIM / HARVEST / etc.) without issuing a move. Without the
  // chain the creep ends the tick on the border exit-tile it just stepped into,
  // and the engine auto-evicts it back to the previous room next tick — the
  // creep ping-pongs across the border indefinitely. Running the new state's
  // handler immediately gives it a chance to queue a move toward the interior.
  for (let i = 0; i < MAX_STATE_CHAIN; i++) {
    const handler = definition[state]!;
    const next = handler.run(creep);
    if (next === undefined || next === state || !definition[next]) break;
    state = next;
    definition[state]!.onEnter?.(creep);
  }
  creep.memory.state = state;
}
