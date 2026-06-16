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
 * Goal-directed backward chaining (3rd iteration on reaction selection — see
 * CLAUDE.md "Engineering lessons" and the v1.0.276 plan for why the first two
 * attempts didn't stick). Forward-greedy selection (`findNextChainStep`) picks
 * the highest-tier step whose inputs are viable, which is correct when building
 * up from base minerals but wrong when intermediates are *unevenly* pre-stocked:
 * live case `GH2O = GH + OH` with GH=5000 (plenty) and OH=50 (short) — greedy kept
 * making ZK/G (deep precursors of the already-stocked GH) instead of OH (the
 * goal's actual missing input), so GH2O never climbed off 264.
 *
 * `nextStepFor(goal, available)` walks the recipe graph backward from `goal`:
 * - An intermediate (non-goal) with `available >= MIN_STEP_AMOUNT` is treated
 *   as `'ready'` — we have enough, don't make more. The GOAL itself is never
 *   short-circuited this way (`isGoalSatisfied` in selectReaction already gates
 *   whether the goal is pursued at all; once pursued, it's pursued to its cap).
 * - A compound with no recipe (base mineral) that isn't in stock is `'blocked'`
 *   — nothing we can do in-lab; buying is handled separately by
 *   `getChainBuyNeeds`. A `seen` set guards against pathological cycles.
 * - Otherwise recurse into both recipe inputs. If either is `'blocked'`, the
 *   whole branch is `'blocked'`. If either is a concrete `ReactionStep` (i.e.
 *   that input itself needs to be made first), bubble it up — that's the step
 *   to run now. If both inputs are `'ready'`, this compound's own recipe step
 *   is what's missing — return it.
 *
 * `nextStepFor` returns `solve(goal, true)`, or `undefined` when the result is
 * `'ready'` (goal's own inputs both already on hand — caller should have
 * selected the goal step itself, this only occurs if goal has no recipe) or
 * `'blocked'` (some required base mineral is missing entirely — goal loop
 * rotates to the next goal).
 *
 * Worked example (live GH2O stall): need(GH2O) → GH ready (5000 >= threshold,
 * don't make), OH not ready (50 < threshold) → need(OH) → O ready, H ready →
 * both ready → return O+H→OH. Once OH climbs, the next eval finds GH2O's own
 * inputs (GH, OH) both ready → returns the GH2O step itself. ZK/G/UL are never
 * touched while GH is stocked — `need(GH)` short-circuits to `'ready'` and the
 * G/ZK/UL branch is never visited.
 */
export function nextStepFor(
  goal: ResourceConstant,
  available: Map<ResourceConstant, number>,
): ReactionStep | undefined {
  const seen = new Set<ResourceConstant>();

  function solve(compound: ResourceConstant, isGoal: boolean): 'ready' | 'blocked' | ReactionStep {
    if (!isGoal && (available.get(compound) ?? 0) >= MIN_STEP_AMOUNT) return 'ready';

    if (seen.has(compound)) return 'blocked';
    const recipe = findReactionProducing(compound);
    if (!recipe) return 'blocked'; // base mineral, not in stock

    seen.add(compound);

    const a = solve(recipe.input1, false);
    if (a === 'blocked') return 'blocked';
    if (a !== 'ready') return a; // make this input first

    const b = solve(recipe.input2, false);
    if (b === 'blocked') return 'blocked';
    if (b !== 'ready') return b; // make this input first

    // Both inputs ready — this compound's own recipe is the missing step.
    return { input1: recipe.input1, input2: recipe.input2, output: compound };
  }

  const result = solve(goal, true);
  return result === 'ready' || result === 'blocked' ? undefined : result;
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

/**
 * True when `reaction` can run right now: both inputs have supply >=
 * MIN_STEP_AMOUNT counting storage+terminal (`available`) PLUS whatever the
 * two input labs already hold. The lab-contents term matters — a loaded,
 * mid-consumption batch (storage drawn down as the labs work it) must still
 * read as viable, or runLabs would re-select away from a reaction that is
 * actively running and thrash.
 *
 * Used by runLabs to widen the re-eval trigger: re-select immediately when
 * the active reaction becomes unrunnable, instead of waiting up to
 * REACTION_CHECK_INTERVAL ticks on a stale pick.
 */
export function isReactionViable(
  reaction: ReactionStep,
  available: Map<ResourceConstant, number>,
  inputLab1: StructureLab,
  inputLab2: StructureLab,
): boolean {
  const supply = (resource: ResourceConstant) =>
    (available.get(resource) ?? 0) +
    (inputLab1.store.getUsedCapacity(resource) ?? 0) +
    (inputLab2.store.getUsedCapacity(resource) ?? 0);

  return supply(reaction.input1) >= MIN_STEP_AMOUNT && supply(reaction.input2) >= MIN_STEP_AMOUNT;
}

/**
 * For each step in `chain` whose output stock has reached `saturation`, add
 * that step's leaf inputs (base minerals not produced by an earlier step in
 * the same chain) to the returned set.
 *
 * Used to stop buying a leaf input when the chain is backed up downstream —
 * e.g. UL piles up while L keeps getting bought, because the bottleneck is
 * lab time (or a different input), not L. Excludes leaves of steps whose
 * output is below saturation, so unblocked legs of the chain keep buying.
 */
export function backedUpLeaves(
  chain: ReactionStep[],
  available: Map<ResourceConstant, number>,
  saturation: number,
): Set<ResourceConstant> {
  const producedInChain = new Set<ResourceConstant>(chain.map((s) => s.output));
  const leaves = new Set<ResourceConstant>();
  for (const step of chain) {
    if ((available.get(step.output) ?? 0) < saturation) continue;
    for (const input of [step.input1, step.input2]) {
      if (producedInChain.has(input)) continue; // produced upstream, not a leaf
      leaves.add(input);
    }
  }
  return leaves;
}
