import {
  buildReactionChain,
  chainMissingInputs,
  findNextChainStep,
  REACTION_GOALS,
} from '../utils/reactions';
import type { ReactionStep } from '../utils/reactions';

const REACTION_CHECK_INTERVAL = 500;
const MIN_INPUT_AMOUNT = 100;

function buildAvailableMap(room: Room): Map<ResourceConstant, number> {
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
  const product1 = (REACTIONS as Record<string, Record<string, string>>)[m1]?.[m2];
  const product2 = (REACTIONS as Record<string, Record<string, string>>)[m2]?.[m1];

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
 * Falls back to greedy if no goal chain is achievable.
 */
function selectReaction(room: Room): ReactionStep | undefined {
  const available = buildAvailableMap(room);

  // Stickiness check first — prevents needless flush cycles when the prior
  // reaction's residual minerals still form a viable pair.
  const sticky = findStickyReaction(room, available);
  if (sticky) return sticky;

  // Try each goal in priority order
  for (const goal of REACTION_GOALS) {
    const chain = buildReactionChain(goal);
    if (chain.length === 0) continue;
    const step = findNextChainStep(chain, available);
    if (step) return step;
  }

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
    const chain = buildReactionChain(goal);
    if (chain.length === 0) continue;
    const needs = chainMissingInputs(chain, available);
    if (needs.length > 0) return needs;
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
    const mem = Memory.rooms[room.name];
    if (!mem?.inputLabIds || !mem.labIds || mem.labIds.length < 3) continue;

    const inputLab1 = Game.getObjectById(mem.inputLabIds[0]);
    const inputLab2 = Game.getObjectById(mem.inputLabIds[1]);
    if (!inputLab1 || !inputLab2) continue;

    // Periodically re-evaluate which reaction to run
    if (!mem.activeReaction || Game.time % REACTION_CHECK_INTERVAL === 0) {
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
      const lab = Game.getObjectById(labId);
      if (!lab || lab.cooldown > 0) continue;
      if ((lab.store.getFreeCapacity(mem.activeReaction.output) ?? 0) < LAB_REACTION_AMOUNT)
        continue;
      lab.runReaction(inputLab1, inputLab2);
    }
  }
}
