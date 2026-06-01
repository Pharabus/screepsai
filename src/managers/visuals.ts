import { drawIdleIndicators } from '../utils/idle';
import { getColonyScore } from '../utils/colonyPlanner';

/**
 * Per-room debug overlay.
 *
 * Gated by `Memory.visuals` — drawing is surprisingly expensive, so it's
 * opt-in. Toggle at runtime from the console:
 *
 *   Memory.visuals = true    // enable all overlays
 *   Memory.visuals = false   // disable
 *
 * Additional sub-toggle:
 *   Memory.profileOverlay = true  // also draw sorted CPU stats table
 *
 * Currently draws, for each owned room:
 *   - Header with RCL, energy, economy mode, colony priority score.
 *   - Creep counts by role.
 *   - Last-tick CPU used + controller progress.
 *   - Source assignment counts (red when a source has no miner).
 *   - Idle creep indicators.
 *
 * When Memory.profileOverlay is also true, draws a sorted CPU stats table
 * on the first owned room (the "process debug overlay" from Phase 3 todo).
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

  // Colony priority score — higher means more worth investing upgrade time in
  const score = getColonyScore(room);
  const stored = room.storage?.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0;

  // Controller progress toward next RCL (not shown at RCL 8)
  const ctrl = room.controller;
  const progressStr =
    ctrl && ctrl.level < 8 && ctrl.progressTotal > 0
      ? ` prog=${((ctrl.progress / ctrl.progressTotal) * 100).toFixed(0)}%`
      : '';

  v.text(
    `RCL ${rcl}  energy ${energy}  [${economy}]  score=${score.toFixed(1)}`,
    HEADER_X,
    HEADER_Y,
    {
      align: 'left',
      color: '#ffffff',
      font: 0.6,
    },
  );
  v.text(roleSummary, HEADER_X, HEADER_Y + 0.8, {
    align: 'left',
    color: '#cccccc',
    font: 0.5,
  });
  v.text(
    `cpu ${Game.cpu.getUsed().toFixed(2)} / ${Game.cpu.limit}  storage=${stored}${progressStr}`,
    HEADER_X,
    HEADER_Y + 1.5,
    { align: 'left', color: '#888888', font: 0.5 },
  );
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

/**
 * Process debug overlay — draws sorted Memory.stats CPU averages as a compact
 * table on the given room. Intended for the first owned room so it doesn't
 * clutter every room visual.
 *
 * Gated by Memory.profileOverlay (separate from Memory.visuals) so this extra
 * information can be toggled independently:
 *   Memory.profileOverlay = true
 */
function drawStatsOverlay(room: Room): void {
  if (!Memory.profileOverlay) return;
  const stats = Memory.stats;
  if (!stats) return;

  const entries = Object.entries(stats)
    .sort(([, a], [, b]) => b.avg - a.avg) // highest average CPU first
    .slice(0, 12); // show top 12 to avoid overflow

  const v = room.visual;
  const startX = 26;
  const startY = 1;

  v.text('— cpu stats (avg) —', startX, startY, {
    align: 'left',
    color: '#aaaaaa',
    font: 0.5,
  });

  for (let i = 0; i < entries.length; i++) {
    const [label, sample] = entries[i]!;
    const color = sample.avg > 3 ? '#ff8888' : sample.avg > 1 ? '#ffcc66' : '#88cc88';
    v.text(`${label.padEnd(18)} ${sample.avg.toFixed(2)}ms`, startX, startY + 0.7 * (i + 1), {
      align: 'left',
      color,
      font: 0.45,
    });
  }
}

export function runVisuals(): void {
  if (!Memory.visuals) return;

  let first = true;
  for (const room of Object.values(Game.rooms)) {
    if (!room.controller?.my) continue;
    drawHeader(room);
    drawSourceLoad(room);
    // Draw the stats overlay only on the first owned room so it doesn't repeat
    if (first) {
      drawStatsOverlay(room);
      first = false;
    }
  }
  drawIdleIndicators();
}
