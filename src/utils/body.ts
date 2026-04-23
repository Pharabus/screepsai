const BODY_COSTS: Record<string, number> = {
  [MOVE]: 50,
  [WORK]: 100,
  [CARRY]: 50,
  [ATTACK]: 80,
  [RANGED_ATTACK]: 150,
  [HEAL]: 250,
  [CLAIM]: 600,
  [TOUGH]: 10,
};

/**
 * Build a miner body that maximises WORK parts.
 * Reserves 1 MOVE (50) and 1 CARRY (50) for link transfers, then fills
 * remaining budget with WORK. Caps at 50 total parts / 6 WORK (source saturation).
 */
export function buildMinerBody(energyAvailable: number): BodyPartConstant[] {
  const baseCost = 100; // 1 MOVE + 1 CARRY
  if (energyAvailable < baseCost + 100) return []; // need at least 1 WORK
  const workCount = Math.min(Math.floor((energyAvailable - baseCost) / 100), 6);
  const body: BodyPartConstant[] = [];
  for (let i = 0; i < workCount; i++) body.push(WORK);
  body.push(CARRY, MOVE);
  return body;
}

/**
 * Build an upgrader body that maximises WORK parts.
 * Reserves 1 MOVE (50) and 1 CARRY (50) for withdrawing from containers/storage,
 * then fills remaining budget with WORK. Caps at 15 WORK (RCL 8 upgrade cap).
 */
export function buildUpgraderBody(energyAvailable: number): BodyPartConstant[] {
  const baseCost = 100; // 1 MOVE + 1 CARRY
  if (energyAvailable < baseCost + 100) return [];
  const workCount = Math.min(Math.floor((energyAvailable - baseCost) / 100), 15);
  const body: BodyPartConstant[] = [];
  for (let i = 0; i < workCount; i++) body.push(WORK);
  body.push(CARRY, MOVE);
  return body;
}

/**
 * Build the largest creep body that fits within the available energy,
 * repeating a pattern of body parts up to a maximum number of repetitions.
 *
 * Example: buildBody([WORK, CARRY, MOVE], 550, 5) => [WORK, CARRY, MOVE, WORK, CARRY, MOVE]
 */
export function buildBody(
  pattern: BodyPartConstant[],
  energyAvailable: number,
  maxRepeats = 50 / pattern.length,
): BodyPartConstant[] {
  const patternCost = pattern.reduce((sum, part) => sum + (BODY_COSTS[part] ?? 0), 0);
  if (patternCost === 0) return [];

  const repeats = Math.min(Math.floor(energyAvailable / patternCost), maxRepeats);
  if (repeats === 0) return [];

  const body: BodyPartConstant[] = [];
  for (let i = 0; i < repeats; i++) {
    body.push(...pattern);
  }
  return body;
}
