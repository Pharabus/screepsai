const REACTION_CHECK_INTERVAL = 500;
const MIN_INPUT_AMOUNT = 100;

function selectReaction(
  room: Room,
): { input1: ResourceConstant; input2: ResourceConstant; output: ResourceConstant } | undefined {
  const storage = room.storage;
  if (!storage) return undefined;

  const available: Partial<Record<ResourceConstant, number>> = {};
  for (const [resource, amount] of Object.entries(storage.store) as [ResourceConstant, number][]) {
    if (resource === RESOURCE_ENERGY) continue;
    available[resource] = (available[resource] ?? 0) + amount;
  }
  if (room.terminal) {
    for (const [resource, amount] of Object.entries(room.terminal.store) as [
      ResourceConstant,
      number,
    ][]) {
      if (resource === RESOURCE_ENERGY) continue;
      available[resource] = (available[resource] ?? 0) + amount;
    }
  }

  let best:
    | {
        input1: ResourceConstant;
        input2: ResourceConstant;
        output: ResourceConstant;
        score: number;
      }
    | undefined;

  for (const [r1, reactions] of Object.entries(REACTIONS)) {
    const amt1 = available[r1 as ResourceConstant];
    if (!amt1 || amt1 < MIN_INPUT_AMOUNT) continue;
    for (const [r2, product] of Object.entries(reactions as Record<string, string>)) {
      const amt2 = available[r2 as ResourceConstant];
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

  return best ? { input1: best.input1, input2: best.input2, output: best.output } : undefined;
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
      const reaction = selectReaction(room);
      mem.activeReaction = reaction;
    }

    if (!mem.activeReaction) continue;

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
