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
 * Build a remote miner body: WORK+MOVE pairs (1:1 for off-road travel)
 * plus 1 CARRY for building the source container. Caps at 5 WORK.
 */
export function buildRemoteMinerBody(energyAvailable: number, maxWork = 5): BodyPartConstant[] {
  const baseCost = 100; // 1 CARRY (50) + 1 MOVE for CARRY (50)
  if (energyAvailable < baseCost + 150) return []; // need at least 1 WORK + 1 MOVE + 1 CARRY + 1 MOVE
  const workCount = Math.min(Math.floor((energyAvailable - baseCost) / 150), maxWork);
  if (workCount === 0) return [];
  const body: BodyPartConstant[] = [];
  for (let i = 0; i < workCount; i++) body.push(WORK);
  body.push(CARRY);
  for (let i = 0; i <= workCount; i++) body.push(MOVE);
  return body;
}

/**
 * Build a hunter body for killing NPC invaders in remote/transit rooms.
 *
 * Three tiers keyed on energyCapacityAvailable:
 *   < 790  — can't field a useful fighter; returns [].
 *   790–1309 — [TOUGH×2, MOVE×4, ATTACK×4, HEAL×1] = 790e, road-speed.
 *   ≥ 1310 — [TOUGH×3, MOVE×6, ATTACK×6, HEAL×2] = 1310e, beats medium invaders.
 *
 * Body order: TOUGH first (absorbs hits), MOVE, ATTACK, HEAL last (most valuable).
 * Road-speed in both tiers (enough MOVE for 1 MOVE per 2 non-MOVE on roads).
 * Only targets Invader-owned NPC creeps — player combat is out of scope.
 */
export function buildHunterBody(energyCapacity: number): BodyPartConstant[] {
  if (energyCapacity >= 1310) {
    return [
      TOUGH,
      TOUGH,
      TOUGH,
      MOVE,
      MOVE,
      MOVE,
      MOVE,
      MOVE,
      MOVE,
      ATTACK,
      ATTACK,
      ATTACK,
      ATTACK,
      ATTACK,
      ATTACK,
      HEAL,
      HEAL,
    ];
  }
  if (energyCapacity >= 790) {
    return [TOUGH, TOUGH, MOVE, MOVE, MOVE, MOVE, ATTACK, ATTACK, ATTACK, ATTACK, HEAL];
  }
  return [];
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
