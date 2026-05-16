export interface ReactionStep {
  input1: ResourceConstant;
  input2: ResourceConstant;
  output: ResourceConstant;
}

/**
 * Look up the product of combining two minerals/compounds in the REACTIONS table.
 * Isolates the unsafe `as Record<...>` cast in one place so all callers get a
 * typed interface with a clean `string | undefined` return.
 */
export function getReactionProduct(
  r1: MineralConstant | MineralCompoundConstant,
  r2: MineralConstant | MineralCompoundConstant,
): string | undefined {
  return (REACTIONS as Record<string, Record<string, string>>)[r1]?.[r2];
}

// Priority-ordered target compounds, from most defensively useful to most economic.
// The chain builder works backward from these through the REACTIONS table.
export const REACTION_GOALS: ResourceConstant[] = [
  'XGHO2' as ResourceConstant, // TOUGH boost (50% dmg reduction)
  'XLHO2' as ResourceConstant, // HEAL boost
  'XKHO2' as ResourceConstant, // RANGED_ATTACK boost
  'XGH2O' as ResourceConstant, // UPGRADE boost
  'XZHO2' as ResourceConstant, // DISMANTLE boost
  'GHO2' as ResourceConstant, // TOUGH tier 2 precursor
  'LHO2' as ResourceConstant, // HEAL tier 2 precursor
  'KHO2' as ResourceConstant, // RANGED_ATTACK tier 2 precursor (defensive, reachable from K+O+H)
  'GH2O' as ResourceConstant, // UPGRADE tier 2 precursor
  'ZHO2' as ResourceConstant, // DISMANTLE tier 2 precursor (offensive — lower priority for a single-room base)
  'OH' as ResourceConstant, // Universal tier 1 intermediate
];

// Minimum amount of each input required before the step is considered viable
const MIN_STEP_AMOUNT = 200;

function findReactionProducing(
  product: ResourceConstant,
): { input1: ResourceConstant; input2: ResourceConstant } | undefined {
  for (const [r1, reactions] of Object.entries(REACTIONS)) {
    for (const [r2, output] of Object.entries(reactions as Record<string, string>)) {
      if (output === product) {
        return { input1: r1 as ResourceConstant, input2: r2 as ResourceConstant };
      }
    }
  }
  return undefined;
}

/**
 * Build the full production chain for a target compound, ordered from
 * earliest prerequisite to the target itself. Returns an empty array if
 * the target is a base mineral (not produced by any reaction).
 */
export function buildReactionChain(target: ResourceConstant): ReactionStep[] {
  const steps: ReactionStep[] = [];
  const seen = new Set<ResourceConstant>();

  function expand(compound: ResourceConstant): void {
    if (seen.has(compound)) return;
    seen.add(compound);
    const reaction = findReactionProducing(compound);
    if (!reaction) return; // base mineral, nothing to produce
    expand(reaction.input1);
    expand(reaction.input2);
    steps.push({ input1: reaction.input1, input2: reaction.input2, output: compound });
  }

  expand(target);
  return steps;
}

/**
 * Given available resources and a production chain (ordered prerequisite-first),
 * find the highest-tier step where both inputs meet the minimum threshold.
 * "Highest tier" = the step closest to the final goal = pick the last viable one.
 */
export function findNextChainStep(
  chain: ReactionStep[],
  available: Map<ResourceConstant, number>,
): ReactionStep | undefined {
  let best: ReactionStep | undefined;
  for (const step of chain) {
    const amt1 = available.get(step.input1) ?? 0;
    const amt2 = available.get(step.input2) ?? 0;
    if (amt1 >= MIN_STEP_AMOUNT && amt2 >= MIN_STEP_AMOUNT) {
      best = step; // overwrite → keeps last (highest-tier) viable step
    }
  }
  return best;
}

/**
 * Return the resources needed by the first unblocked step of the chain that
 * are below MIN_STEP_AMOUNT. Used by the terminal to decide what to buy.
 * Only looks at the lowest runnable gap (the step that would unblock the chain).
 */
export function chainMissingInputs(
  chain: ReactionStep[],
  available: Map<ResourceConstant, number>,
): ResourceConstant[] {
  for (const step of chain) {
    const amt1 = available.get(step.input1) ?? 0;
    const amt2 = available.get(step.input2) ?? 0;
    const missing: ResourceConstant[] = [];
    if (amt1 < MIN_STEP_AMOUNT) missing.push(step.input1);
    if (amt2 < MIN_STEP_AMOUNT) missing.push(step.input2);
    if (missing.length > 0) return missing;
    // Both inputs are available for this step — check if output needs to be produced
    const outAmt = available.get(step.output) ?? 0;
    if (outAmt < MIN_STEP_AMOUNT) return []; // producing, no need to buy anything here
  }
  return [];
}
