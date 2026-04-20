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
  const costs: Record<string, number> = {
    [MOVE]: 50,
    [WORK]: 100,
    [CARRY]: 50,
    [ATTACK]: 80,
    [RANGED_ATTACK]: 150,
    [HEAL]: 250,
    [CLAIM]: 600,
    [TOUGH]: 10,
  };

  const patternCost = pattern.reduce((sum, part) => sum + (costs[part] ?? 0), 0);
  if (patternCost === 0) return [];

  const repeats = Math.min(Math.floor(energyAvailable / patternCost), maxRepeats);
  if (repeats === 0) return [];

  const body: BodyPartConstant[] = [];
  for (let i = 0; i < repeats; i++) {
    body.push(...pattern);
  }
  return body;
}
