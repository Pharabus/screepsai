export const MINERAL_STORAGE_FLOOR = 5000;
export const MINERAL_TERMINAL_CEILING = 50000;
export const ENERGY_TERMINAL_BUFFER = 50000;

export function isTerminalSurplus(room: Room, resource: ResourceConstant): boolean {
  const terminal = room.terminal;
  if (!terminal) return false;
  return terminal.store.getUsedCapacity(resource) > MINERAL_TERMINAL_CEILING;
}
