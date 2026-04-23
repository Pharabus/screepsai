import { drawIdleIndicators } from '../utils/idle';

/**
 * Per-room debug overlay.
 *
 * Gated by `Memory.visuals` — drawing is surprisingly expensive, so it's
 * opt-in. Toggle at runtime from the console:
 *
 *   Memory.visuals = true
 *   Memory.visuals = false
 *
 * Currently draws, for each owned room:
 *   - Header with RCL, energy, and creep counts by role.
 *   - Last-tick CPU used (matches `stats()` "main.loop" entry when profiling).
 *   - Source assignment counts (how many creeps are camped on each source).
 */

const HEADER_X = 1;
const HEADER_Y = 1;

function countCreeps(room: Room): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const name in Game.creeps) {
    const c = Game.creeps[name];
    if (!c || c.room.name !== room.name) continue;
    counts[c.memory.role] = (counts[c.memory.role] ?? 0) + 1;
  }
  return counts;
}

function drawHeader(room: Room): void {
  const v = room.visual;
  const rcl = room.controller?.level ?? 0;
  const energy = `${room.energyAvailable}/${room.energyCapacityAvailable}`;
  const counts = countCreeps(room);
  const roleSummary =
    Object.entries(counts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([role, n]) => `${role}:${n}`)
      .join(' ') || '—';

  const mem = Memory.rooms[room.name];
  const economy = mem?.minerEconomy ? 'miner' : 'bootstrap';

  v.text(`RCL ${rcl}  energy ${energy}  [${economy}]`, HEADER_X, HEADER_Y, {
    align: 'left',
    color: '#ffffff',
    font: 0.6,
  });
  v.text(roleSummary, HEADER_X, HEADER_Y + 0.8, {
    align: 'left',
    color: '#cccccc',
    font: 0.5,
  });
  v.text(`cpu ${Game.cpu.getUsed().toFixed(2)} / ${Game.cpu.limit}`, HEADER_X, HEADER_Y + 1.5, {
    align: 'left',
    color: '#888888',
    font: 0.5,
  });
}

function drawSourceLoad(room: Room): void {
  const v = room.visual;
  const sources = room.find(FIND_SOURCES);
  for (const source of sources) {
    const nearby = Object.values(Game.creeps).filter(
      (c) => c.room.name === room.name && source.pos.inRangeTo(c, 2),
    ).length;
    v.text(`⛏ ${nearby}`, source.pos.x, source.pos.y - 0.7, {
      color: nearby === 0 ? '#ff6666' : '#ffff66',
      font: 0.5,
    });
  }
}

export function runVisuals(): void {
  if (!Memory.visuals) return;

  for (const room of Object.values(Game.rooms)) {
    if (!room.controller?.my) continue;
    drawHeader(room);
    drawSourceLoad(room);
  }
  drawIdleIndicators();
}
