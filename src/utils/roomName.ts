/**
 * Parses a Screeps room name (e.g. "W44N57") into its numeric world
 * coordinates. Returns undefined for non-standard-shaped strings (sim rooms,
 * malformed names) so callers can fail closed rather than mis-detect them.
 */
export function parseRoomName(roomName: string): { x: number; y: number } | undefined {
  const match = /^[WE](\d+)[NS](\d+)$/.exec(roomName);
  if (!match) return undefined;
  return { x: Number(match[1]), y: Number(match[2]) };
}

/**
 * Highway rooms sit on the grid lines between 10x10 sectors — every room
 * whose world x or y coordinate is a multiple of 10. They have no controller
 * or sources, but host Power Banks and commodity Deposits, and are the
 * corridor other players' caravans and military traffic route through.
 */
export function isHighwayRoom(roomName: string): boolean {
  const coords = parseRoomName(roomName);
  if (!coords) return false;
  return coords.x % 10 === 0 || coords.y % 10 === 0;
}
