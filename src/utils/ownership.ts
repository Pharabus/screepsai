/**
 * Ownership-aware accessors for storage and terminal.
 *
 * room.storage and room.terminal are owner-agnostic: in a reclaimed room they
 * return the previous owner's structure. Use these helpers at every
 * OWNERSHIP-SENSITIVE site — anything that deposits into, places, links to, or
 * gates on the existence of "our" storage or terminal.
 *
 * Do NOT replace owner-agnostic reads where draining the foreign store is
 * intended (e.g. pickupForeignStore in hauler.ts).
 */

export function myStorage(room: Room): StructureStorage | undefined {
  return room.storage?.my ? room.storage : undefined;
}

export function myTerminal(room: Room): StructureTerminal | undefined {
  return room.terminal?.my ? room.terminal : undefined;
}
