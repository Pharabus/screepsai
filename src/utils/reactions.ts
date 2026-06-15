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

// Priority-ordered target compounds. GH2O (tier-2 upgrade boost, +50%, no
// catalyst) is first — it's the strongest upgrade boost we can actually source,
// since the catalysed X-tier (XGH2O etc.) needs catalyst X, which has no market
// orders at our price cap on shard3 (cheapest ~747 vs 150 cap). The X-tier goals
// remain below as aspirational fallbacks, active only if an X supply appears.
// The chain builder works backward from these through the REACTIONS table.
export const REACTION_GOALS: ResourceConstant[] = [
  'GH2O' as ResourceConstant, // UPGRADE boost (+50%, no catalyst) — PRIMARY, achievable now
  'XGH2O' as ResourceConstant, // UPGRADE +100% — needs catalyst X (unbuyable on shard3 at our cap)
  'XGHO2' as ResourceConstant, // TOUGH boost (50% dmg reduction)
  'XLHO2' as ResourceConstant, // HEAL boost
  'XKHO2' as ResourceConstant, // RANGED_ATTACK boost
  'XZHO2' as ResourceConstant, // DISMANTLE boost
  'GHO2' as ResourceConstant, // TOUGH tier 2 precursor
  'LHO2' as ResourceConstant, // HEAL tier 2 precursor
  'KHO2' as ResourceConstant, // RANGED_ATTACK tier 2 precursor (defensive, reachable from K+O+H)
  'ZHO2' as ResourceConstant, // DISMANTLE tier 2 precursor (offensive — lower priority for a single-room base)
  'OH' as ResourceConstant, // Universal tier 1 intermediate
];

/**
 * Per-goal satisfaction caps. Once a goal's compound stock reaches the cap the
 * lab system rotates to the next reachable goal; production resumes when stock
 * falls below cap × 0.5 (hysteresis prevents thrashing near the boundary).
 *
 * Goals absent from this map are uncapped and always pursued when reachable.
 *
 * GH2O cap (4000) is deliberately above the upgrader boost floor (1500) so
 * rotation never starves the upgrader. Defensive precursor caps (2000) each
 * hold enough for several full-squad boosts.
 */
export const GOAL_CAPS: Partial<Record<ResourceConstant, number>> = {
  GH2O: 4000, // upgrader boost — primary goal; cap >> upgraderBoostWanted floor (1500)
  GHO2: 2000, // tough tier-2 precursor for defenders
  LHO2: 2000, // heal tier-2 precursor for healers
  KHO2: 2000, // ranged-attack tier-2 precursor for rangedDefenders
};

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
 * Compounds that are *intermediates* in the reaction goal chains — i.e. produced
 * by one step and re-consumed by another (e.g. ZK, UL, OH, G, GH, GO, and the
 * tier-2 boosts GH2O/GHO2/KHO2/LHO2 which the X-tier goals consume). These are
 * minerals we spent credits/energy to build and intend to consume, so they must
 * never be sold as "surplus" (the buy-L→make-UL→sell-UL-at-a-loss sawtooth that
 * drained the wallet 1.5M→1).
 *
 * Base elements (H,O,U,K,L,Z,X) are consumed but never produced → not
 * intermediates → still sellable as raw surplus. The X-tier finals (XGH2O…) are
 * produced but never consumed → still sellable. Anything not in a goal chain
 * (e.g. RESOURCE_BATTERY) is likewise unaffected.
 *
 * REACTION_GOALS is a compile-time constant, so the set is computed once and
 * memoised on the module heap (a global reset re-derives it cheaply).
 */
let _chainIntermediates: Set<ResourceConstant> | undefined;
export function getChainIntermediates(): Set<ResourceConstant> {
  if (_chainIntermediates) return _chainIntermediates;
  const produced = new Set<ResourceConstant>();
  const consumed = new Set<ResourceConstant>();
  for (const goal of REACTION_GOALS) {
    for (const step of buildReactionChain(goal)) {
      produced.add(step.output);
      consumed.add(step.input1);
      consumed.add(step.input2);
    }
  }
  const intermediates = new Set<ResourceConstant>();
  for (const compound of produced) {
    if (consumed.has(compound)) intermediates.add(compound);
  }
  _chainIntermediates = intermediates;
  return intermediates;
}

/**
 * Scan every step in the chain and return all leaf inputs (base minerals /
 * catalyst) that are below MIN_STEP_AMOUNT.  Intermediate compounds whose
 * output is produced by an earlier step in the same chain are never returned
 * — those are made in-lab, not bought.
 *
 * This whole-chain scan ensures that missing inputs deep in the reaction tree
 * (e.g. the X catalyst or base minerals for ghodium branches) are surfaced
 * even when a shallow step's inputs happen to be fully stocked.  Returns []
 * when every leaf input is already at or above MIN_STEP_AMOUNT (fully stocked,
 * nothing to buy).
 */
export function chainMissingInputs(
  chain: ReactionStep[],
  available: Map<ResourceConstant, number>,
): ResourceConstant[] {
  // Inputs produced by an earlier step are made in-lab, not bought. Only
  // leaf inputs (base minerals + catalyst) are buy candidates.
  const producedInChain = new Set<ResourceConstant>(chain.map((s) => s.output));
  const missing = new Set<ResourceConstant>();
  for (const step of chain) {
    for (const input of [step.input1, step.input2]) {
      if (producedInChain.has(input)) continue; // produced upstream, don't buy
      if ((available.get(input) ?? 0) < MIN_STEP_AMOUNT) missing.add(input);
    }
  }
  return [...missing];
}
