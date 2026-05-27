/**
 * Combat event logger.
 *
 * Persists a capped ring-buffer of significant combat events to
 * `Memory.combatLog` so post-mortem analysis survives room loss, bot restart,
 * or a global reset. Each event captures just enough context to answer three
 * questions after an attack:
 *   - What hit us, and when?
 *   - Did our defences respond correctly?
 *   - Where did they fail, and why?
 *
 * Events are written by `managers/defense.ts` (threat transitions, safe mode)
 * and `managers/towers.ts` (tower energy drain during combat). Events also
 * echo to the console in real time so you can watch a fight live.
 *
 * Console: `combatLog()` prints the full log in human-readable form.
 */

const MAX_LOG_ENTRIES = 100;

export function logCombat(event: CombatEvent): void {
  if (!Memory.combatLog) Memory.combatLog = [];
  Memory.combatLog.push(event);
  // Ring-buffer: drop the oldest entries when we exceed the cap.
  if (Memory.combatLog.length > MAX_LOG_ENTRIES) {
    Memory.combatLog.splice(0, Memory.combatLog.length - MAX_LOG_ENTRIES);
  }

  // Echo to console so events are visible in real time when watching a fight.
  const parts: string[] = [`[combat] t=${event.tick} ${event.room}: ${event.event}`];
  if (event.threatScore !== undefined) parts.push(`threat=${event.threatScore}`);
  if (event.hostileCount !== undefined) parts.push(`hostiles=${event.hostileCount}`);
  if (event.owners?.length) parts.push(`owners=[${event.owners.join(',')}]`);
  if (event.towerCount !== undefined) parts.push(`towers=${event.towerCount}`);
  if (event.minTowerEnergy !== undefined) parts.push(`minTowerEnergy=${event.minTowerEnergy}%`);
  if (event.safeModesLeft !== undefined) parts.push(`safeModesLeft=${event.safeModesLeft}`);
  if (event.details) parts.push(event.details);
  console.log(parts.join('  '));
}

export function formatCombatLog(): string {
  const log = Memory.combatLog;
  if (!log || log.length === 0) return 'No combat events recorded yet.';

  const lines = log.map((e) => {
    const parts: string[] = [`t=${e.tick}`, e.room.padEnd(8), e.event.padEnd(24)];
    if (e.threatScore !== undefined) parts.push(`threat=${e.threatScore}`);
    if (e.hostileCount !== undefined) parts.push(`hostiles=${e.hostileCount}`);
    if (e.owners?.length) parts.push(`owners=[${e.owners.join(',')}]`);
    if (e.towerCount !== undefined) parts.push(`towers=${e.towerCount}`);
    if (e.minTowerEnergy !== undefined) parts.push(`minTowerEnergy=${e.minTowerEnergy}%`);
    if (e.safeModesLeft !== undefined) parts.push(`safeModesLeft=${e.safeModesLeft}`);
    if (e.details) parts.push(e.details);
    return parts.join('  ');
  });

  return [`--- combat log (${log.length} events) ---`, ...lines].join('\n');
}
