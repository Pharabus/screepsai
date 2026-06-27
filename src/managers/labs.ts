import {
  backedUpLeaves,
  buildReactionChain,
  chainMissingInputs,
  findNextChainStep,
  getReactionProduct,
  isReactionViable,
  nextStepFor,
  GOAL_CAPS,
  REACTION_GOALS,
} from '../utils/reactions';
import { INTERMEDIATE_SATURATION } from '../utils/thresholds';
import { isOperational } from '../utils/structures';
import { cached } from '../utils/tickCache';
import type { ReactionStep } from '../utils/reactions';

const REACTION_CHECK_INTERVAL = 500;
const MIN_INPUT_AMOUNT = 100;

/**
 * Heap cache tracking whether a goal is "satisfied" for a given room.
 *
 * A goal becomes satisfied when availableStock >= cap; it stays satisfied until
 * stock drops below cap * 0.5, providing hysteresis that prevents thrashing
 * near the boundary. Goals with no cap are never satisfied.
 *
 * Keyed as `${roomName}|${goalCompound}`.
 * Lives on the JS heap — a global reset clears it (safe; recomputes cheaply).
 */
const _reactionGoalSatisfied = new Map<string, boolean>();

/** Call in tests' beforeEach to prevent stale satisfied state leaking between cases. */
export function resetReactionGoalCache(): void {
  _reactionGoalSatisfied.clear();
}

/**
 * The lab "hub" is the single owned room where all reactions and lab-input
 * market buys concentrate. Under the full-feeder model, colonies mine their
 * mineral and ship it raw to the hub, which runs the boost chains — so only the
 * hub should spend credits buying lab inputs. A 3-lab colony buying H at ~100cr
 * to make tier-1 compounds it can't chain and nobody consumes is pure waste.
 *
 * Auto-detected as the owned room with the most built labs (`labIds`), ties
 * broken by higher RCL, then higher controller progress (more established room),
 * then room name for determinism. Cached per tick — lab counts change rarely.
 *
 * Controller progress as a tie-break after RCL prevents a freshly-built
 * colony from stealing the hub role the instant it matches an older room's lab
 * count — observed live when W42N59 (RCL7, 2.8% progress) beat W43N58 (RCL7,
 * 77.9%) purely on alphabetical name, starving itself by running reactions with
 * almost no energy (v1.0.290).
 */
export function getLabHubName(): string | undefined {
  return cached('labs:hubName', () => {
    let best: { name: string; labs: number; rcl: number; progress: number } | undefined;
    for (const room of Object.values(Game.rooms)) {
      if (!room.controller?.my) continue;
      const labs = Memory.rooms[room.name]?.labIds?.length ?? 0;
      if (labs === 0) continue;
      const rcl = room.controller.level;
      const progress = room.controller.progress;
      const better =
        !best ||
        labs > best.labs ||
        (labs === best.labs &&
          (rcl > best.rcl ||
            (rcl === best.rcl &&
              (progress > best.progress ||
                (progress === best.progress && room.name < best.name)))));
      if (better) best = { name: room.name, labs, rcl, progress };
    }
    return best?.name;
  });
}

/** True when `room` is the lab hub (the owned room reactions/buys concentrate in). */
export function isLabHub(room: Room): boolean {
  return getLabHubName() === room.name;
}

/**
 * Returns true when the goal compound is capped and the room's current stock
 * meets or exceeds the hysteresis threshold — meaning we should skip this goal
 * and rotate to the next one.
 */
function isGoalSatisfied(
  goal: ResourceConstant,
  available: Map<ResourceConstant, number>,
  roomName: string,
): boolean {
  const cap = GOAL_CAPS[goal];
  if (cap === undefined) return false; // uncapped — never satisfied

  const key = `${roomName}|${goal}`;
  const prev = _reactionGoalSatisfied.get(key) ?? false;
  const stock = available.get(goal) ?? 0;

  let satisfied: boolean;
  if (stock >= cap) {
    satisfied = true; // crossed upper threshold — now satisfied
  } else if (stock < cap * 0.5) {
    satisfied = false; // dropped below lower threshold — pursue again
  } else {
    satisfied = prev; // in hysteresis band — keep previous state
  }

  _reactionGoalSatisfied.set(key, satisfied);
  return satisfied;
}

export function buildAvailableMap(room: Room): Map<ResourceConstant, number> {
  const available = new Map<ResourceConstant, number>();
  const add = (resource: ResourceConstant, amount: number) => {
    available.set(resource, (available.get(resource) ?? 0) + amount);
  };

  const storage = room.storage;
  if (storage) {
    for (const [r, amt] of Object.entries(storage.store) as [ResourceConstant, number][]) {
      if (r !== RESOURCE_ENERGY) add(r, amt);
    }
  }
  if (room.terminal) {
    for (const [r, amt] of Object.entries(room.terminal.store) as [ResourceConstant, number][]) {
      if (r !== RESOURCE_ENERGY) add(r, amt);
    }
  }
  return available;
}

/**
 * If the input labs already hold a viable input pair, prefer that reaction
 * to avoid a flush cycle. Flushing consumes hauler bandwidth and stalls
 * energy logistics; finishing the existing batch is almost always cheaper
 * even if the resulting compound isn't the highest-tier goal.
 */
function findStickyReaction(
  room: Room,
  available: Map<ResourceConstant, number>,
): ReactionStep | undefined {
  const mem = Memory.rooms[room.name];
  if (!mem?.inputLabIds || mem.inputLabIds.length < 2) return undefined;
  const lab1 = Game.getObjectById(mem.inputLabIds[0]);
  const lab2 = Game.getObjectById(mem.inputLabIds[1]);
  const m1 = lab1?.mineralType;
  const m2 = lab2?.mineralType;
  if (!m1 || !m2) return undefined;

  // Try both orientations against the REACTIONS table
  const product1 = getReactionProduct(m1, m2);
  const product2 = getReactionProduct(m2, m1);

  let input1: ResourceConstant;
  let input2: ResourceConstant;
  let output: ResourceConstant;
  if (product1) {
    input1 = m1;
    input2 = m2;
    output = product1 as ResourceConstant;
  } else if (product2) {
    input1 = m2;
    input2 = m1;
    output = product2 as ResourceConstant;
  } else {
    return undefined;
  }

  // Count storage+terminal supply plus what's already in the labs
  const supply = (r: ResourceConstant) =>
    (available.get(r) ?? 0) +
    (lab1?.store.getUsedCapacity(r) ?? 0) +
    (lab2?.store.getUsedCapacity(r) ?? 0);
  if (supply(input1) < MIN_INPUT_AMOUNT || supply(input2) < MIN_INPUT_AMOUNT) return undefined;

  return { input1, input2, output };
}

/**
 * Goal-directed chain selection: try each REACTION_GOAL in priority order,
 * build its production chain, and return the highest viable step.
 * If no goal step is achievable, finish whatever the input labs already hold
 * (sticky — avoids a needless flush cycle). Falls back to greedy last.
 */
export function selectReaction(room: Room): ReactionStep | undefined {
  const available = buildAvailableMap(room);

  // Goal-directed selection takes precedence: pursue the highest viable step of
  // the highest-priority achievable goal. (The sticky check must NOT run first —
  // if the input labs hold a low-tier pair like H+O, stickiness would return OH
  // every tick and the goal loop would never be reached, welding the labs onto
  // an intermediate indefinitely.)
  for (const goal of REACTION_GOALS) {
    if (isGoalSatisfied(goal, available, room.name)) continue;
    // Goal-directed backward chaining (see nextStepFor doc comment): produce
    // the input the goal actually lacks, descending into precursors only when
    // a wanted downstream step is genuinely missing one. Returns undefined when
    // the goal is fully ready (handled elsewhere) or blocked on a missing base
    // mineral — either way, rotate to the next goal.
    const step = nextStepFor(goal, available);
    if (step) return step;
  }

  // No achievable goal step — finish whatever the input labs already hold to
  // avoid a needless flush of residual minerals.
  const sticky = findStickyReaction(room, available);
  if (sticky) return sticky;

  // Fallback: greedy — pick reaction with most available inputs
  let best:
    | {
        input1: ResourceConstant;
        input2: ResourceConstant;
        output: ResourceConstant;
        score: number;
      }
    | undefined;

  for (const [r1, reactions] of Object.entries(REACTIONS)) {
    const amt1 = available.get(r1 as ResourceConstant);
    if (!amt1 || amt1 < MIN_INPUT_AMOUNT) continue;
    for (const [r2, product] of Object.entries(reactions as Record<string, string>)) {
      const amt2 = available.get(r2 as ResourceConstant);
      if (!amt2 || amt2 < MIN_INPUT_AMOUNT) continue;
      const score = Math.min(amt1, amt2);
      if (!best || score > best.score) {
        best = {
          input1: r1 as ResourceConstant,
          input2: r2 as ResourceConstant,
          output: product as ResourceConstant,
          score,
        };
      }
    }
  }

  return best;
}

/**
 * Return which inputs the current reaction chain needs that we are missing.
 * Used by the terminal to decide what to buy.
 */
export function getChainBuyNeeds(room: Room): ResourceConstant[] {
  const available = buildAvailableMap(room);
  for (const goal of REACTION_GOALS) {
    if (isGoalSatisfied(goal, available, room.name)) continue;
    const chain = buildReactionChain(goal);
    if (chain.length === 0) continue;
    const needs = chainMissingInputs(chain, available);
    if (needs.length > 0) {
      // Don't buy a leaf whose product is already backed up downstream
      // (e.g. L when UL has piled to INTERMEDIATE_SATURATION) — the
      // bottleneck is lab time / a different input, not this leaf.
      const backedUp = backedUpLeaves(chain, available, INTERMEDIATE_SATURATION);
      const filtered = needs.filter((need) => !backedUp.has(need));
      if (filtered.length > 0) return filtered;
      continue; // everything missing is backed up — try the next goal
    }
    // If this goal has no missing inputs at any step, check next goal only if
    // this one is fully produced. Otherwise stick with this goal's needs.
    const nextStep = findNextChainStep(chain, available);
    if (nextStep) return []; // currently producing, nothing to buy
  }
  return [];
}

export function runLabs(): void {
  for (const room of Object.values(Game.rooms)) {
    if (!room.controller?.my) continue;
    // Full-feeder model: only the hub runs reactions. Feeder colonies mine and
    // ship their mineral to the hub (see terminal.ts sendMineralsToHub); their
    // labs stay idle rather than churning small tier-1 batches nobody consumes.
    if (!isLabHub(room)) {
      // Clear any stale reaction state left over from when this room ran its
      // own reactions (e.g. before it became a feeder). Without this,
      // deliverToLabInput (hauler.ts) is gated on mem.activeReaction and would
      // carry a just-drained mineral straight back into the input lab, creating
      // an infinite lab↔hauler loop. Clearing here ensures the deliver path
      // falls through to storage/terminal and sendMineralsToHub can ship it.
      const feederMem = Memory.rooms[room.name];
      if (feederMem) {
        delete feederMem.activeReaction;
        delete feederMem.labFlushing;
      }
      continue;
    }
    const mem = Memory.rooms[room.name];
    if (!mem?.inputLabIds || !mem.labIds || mem.labIds.length < 3) continue;

    const inputLab1 = Game.getObjectById(mem.inputLabIds[0]);
    const inputLab2 = Game.getObjectById(mem.inputLabIds[1]);
    if (!inputLab1 || !inputLab2) continue;
    if (!isOperational(inputLab1) || !isOperational(inputLab2)) continue;

    // Re-evaluate which reaction to run: periodically, or immediately when the
    // active reaction can no longer run (event-driven re-eval). The unviable
    // check is skipped while labFlushing — don't re-pick mid-flush, the
    // established flush path already handles a changed pick. Without this, the
    // hub could weld onto a stale reaction (e.g. activeReaction=G while ZK=1)
    // for up to REACTION_CHECK_INTERVAL ticks.
    const activeUnviable =
      !mem.labFlushing &&
      !!mem.activeReaction &&
      !isReactionViable(mem.activeReaction, buildAvailableMap(room), inputLab1, inputLab2);
    if (!mem.activeReaction || Game.time % REACTION_CHECK_INTERVAL === 0 || activeUnviable) {
      const prev = mem.activeReaction;
      const reaction = selectReaction(room);
      mem.activeReaction = reaction;

      if (
        reaction &&
        prev &&
        (reaction.input1 !== prev.input1 || reaction.input2 !== prev.input2)
      ) {
        const lab1Mineral = inputLab1.mineralType;
        const lab2Mineral = inputLab2.mineralType;
        if (
          (lab1Mineral && lab1Mineral !== reaction.input1) ||
          (lab2Mineral && lab2Mineral !== reaction.input2)
        ) {
          mem.labFlushing = true;
        }
      }
    }

    if (!mem.activeReaction) continue;

    // While flushing, check if input labs are clear of stale minerals
    if (mem.labFlushing) {
      const { input1, input2 } = mem.activeReaction;
      const lab1Clean = !inputLab1.mineralType || inputLab1.mineralType === input1;
      const lab2Clean = !inputLab2.mineralType || inputLab2.mineralType === input2;
      if (lab1Clean && lab2Clean) {
        mem.labFlushing = false;
      } else {
        continue;
      }
    }

    const { input1, input2 } = mem.activeReaction;

    // Check inputs are loaded
    if (
      (inputLab1.store.getUsedCapacity(input1) ?? 0) < LAB_REACTION_AMOUNT ||
      (inputLab2.store.getUsedCapacity(input2) ?? 0) < LAB_REACTION_AMOUNT
    ) {
      continue;
    }

    // Run reactions on all output labs
    const inputSet = new Set(mem.inputLabIds as Id<StructureLab>[]);
    for (const labId of mem.labIds) {
      if (inputSet.has(labId)) continue;
      if (labId === mem.boostLabId) continue;
      const lab = Game.getObjectById(labId);
      if (!lab || lab.cooldown > 0) continue;
      if (!isOperational(lab)) continue;
      if ((lab.store.getFreeCapacity(mem.activeReaction.output) ?? 0) < LAB_REACTION_AMOUNT)
        continue;
      lab.runReaction(inputLab1, inputLab2);
    }
  }
}
