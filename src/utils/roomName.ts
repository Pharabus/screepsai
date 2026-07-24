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

/**
 * Steps `dx` rooms east (positive) / west (negative) and `dy` rooms south
 * (positive) / north (negative) from `roomName`, correctly crossing the
 * W0/E0 and N0/S0 seams — per-quadrant room numbers reset to 0 at the map's
 * center meridian/equator rather than continuing to increment, so naive
 * string-number arithmetic breaks there (e.g. one room east of "W0N0" is
 * "E0N0", not "W-1N0"). Returns undefined for a non-standard room name.
 */
export function offsetRoomName(roomName: string, dx: number, dy: number): string | undefined {
  const match = /^([WE])(\d+)([NS])(\d+)$/.exec(roomName);
  if (!match) return undefined;
  const [, ew, xStr, ns, yStr] = match;

  // Signed world coordinate: E/S numbers increase away from the meridian;
  // W/N numbers mirror them one room closer in (W0 sits immediately west of
  // E0, so it maps to -1, not 0) — this keeps the two quadrants' numbering
  // seamless across the boundary.
  const worldX = (ew === 'E' ? Number(xStr) : -Number(xStr) - 1) + dx;
  const worldY = (ns === 'S' ? Number(yStr) : -Number(yStr) - 1) + dy;

  const newEw = worldX >= 0 ? 'E' : 'W';
  const newX = worldX >= 0 ? worldX : -worldX - 1;
  const newNs = worldY >= 0 ? 'S' : 'N';
  const newY = worldY >= 0 ? worldY : -worldY - 1;

  return `${newEw}${newX}${newNs}${newY}`;
}
