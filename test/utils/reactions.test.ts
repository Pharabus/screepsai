import {
  backedUpLeaves,
  buildReactionChain,
  chainMissingInputs,
  findNextChainStep,
  getChainIntermediates,
  isReactionViable,
  type ReactionStep,
} from '../../src/utils/reactions';
import { resetGameGlobals } from '../mocks/screeps';

/** Minimal StructureLab stub exposing only store.getUsedCapacity. */
function mockInputLab(stored: Partial<Record<ResourceConstant, number>> = {}): any {
  return {
    store: {
      getUsedCapacity: (r?: ResourceConstant) => (r ? (stored[r] ?? 0) : 0),
    },
  };
}

beforeEach(() => {
  resetGameGlobals();
});

describe('buildReactionChain', () => {
  it('returns empty array for a base mineral', () => {
    const chain = buildReactionChain('H' as ResourceConstant);
    expect(chain).toHaveLength(0);
  });

  it('returns single step for a tier-1 compound', () => {
    const chain = buildReactionChain('OH' as ResourceConstant);
    expect(chain).toHaveLength(1);
    expect(chain[0]).toMatchObject({ output: 'OH' });
    const step = chain[0]!;
    const inputs = [step.input1, step.input2].sort();
    expect(inputs).toEqual(['H', 'O']);
  });

  it('builds a multi-step chain for a tier-2 compound', () => {
    // ZHO2 = ZH + O, ZH = Z + H
    const chain = buildReactionChain('ZHO2' as ResourceConstant);
    expect(chain.length).toBeGreaterThanOrEqual(2);
    const outputs = chain.map((s) => s.output);
    expect(outputs).toContain('ZH');
    expect(outputs).toContain('ZHO2');
    // ZH must appear before ZHO2 in the chain
    expect(outputs.indexOf('ZH')).toBeLessThan(outputs.indexOf('ZHO2'));
  });

  it('builds a 3-step chain for a tier-3 compound', () => {
    // XZHO2 = ZHO2 + X (catalyst), ZHO2 = ZH + O, ZH = Z + H
    const chain = buildReactionChain('XZHO2' as ResourceConstant);
    expect(chain.length).toBeGreaterThanOrEqual(3);
    const outputs = chain.map((s) => s.output);
    expect(outputs).toContain('ZH');
    expect(outputs).toContain('ZHO2');
    expect(outputs).toContain('XZHO2');
  });

  it('does not revisit the same compound twice', () => {
    const chain = buildReactionChain('XZHO2' as ResourceConstant);
    const outputs = chain.map((s) => s.output);
    const unique = new Set(outputs);
    expect(unique.size).toBe(outputs.length);
  });
});

describe('findNextChainStep', () => {
  it('returns undefined when no step has sufficient inputs', () => {
    const chain = buildReactionChain('ZHO2' as ResourceConstant);
    const available = new Map<ResourceConstant, number>();
    expect(findNextChainStep(chain, available)).toBeUndefined();
  });

  it('returns the lowest tier step when only base inputs are available', () => {
    const chain = buildReactionChain('ZHO2' as ResourceConstant);
    const available = new Map<ResourceConstant, number>([
      ['Z', 500] as [ResourceConstant, number],
      ['H', 500] as [ResourceConstant, number],
    ]);
    const step = findNextChainStep(chain, available);
    expect(step?.output).toBe('ZH'); // Z+H→ZH is the viable first step
  });

  it('returns the highest tier step when intermediates are available', () => {
    const chain = buildReactionChain('ZHO2' as ResourceConstant);
    const available = new Map<ResourceConstant, number>([
      ['Z', 500] as [ResourceConstant, number],
      ['H', 500] as [ResourceConstant, number],
      ['ZH', 500] as [ResourceConstant, number],
      ['O', 500] as [ResourceConstant, number],
    ]);
    const step = findNextChainStep(chain, available);
    // ZHO2 = ZH + O, both available → this is the higher tier step
    expect(step?.output).toBe('ZHO2');
  });

  it('requires minimum threshold of 200', () => {
    const chain = buildReactionChain('ZHO2' as ResourceConstant);
    const available = new Map<ResourceConstant, number>([
      ['Z', 100] as [ResourceConstant, number], // below threshold
      ['H', 500] as [ResourceConstant, number],
    ]);
    expect(findNextChainStep(chain, available)).toBeUndefined();
  });

  describe('with saturation', () => {
    it('skips a step whose output is already saturated and returns the next-best viable step', () => {
      const chain = buildReactionChain('ZHO2' as ResourceConstant);
      const available = new Map<ResourceConstant, number>([
        ['Z', 500] as [ResourceConstant, number],
        ['H', 500] as [ResourceConstant, number],
        ['ZH', 5000] as [ResourceConstant, number], // saturated output of Z+H->ZH
        ['O', 500] as [ResourceConstant, number],
      ]);
      // Without saturation: ZHO2 (ZH+O) is the highest-tier viable step.
      expect(findNextChainStep(chain, available)?.output).toBe('ZHO2');

      // ZHO2's own output is well below saturation, so it's still picked even
      // when ZH (an upstream output) is saturated — saturation only blocks
      // making MORE of an already-piled-up compound, not consuming it.
      expect(findNextChainStep(chain, available, 5000)?.output).toBe('ZHO2');
    });

    it('skips the final step when ITS output is saturated, falling back to an earlier step', () => {
      const chain = buildReactionChain('ZHO2' as ResourceConstant);
      const available = new Map<ResourceConstant, number>([
        ['Z', 500] as [ResourceConstant, number],
        ['H', 500] as [ResourceConstant, number],
        ['ZH', 500] as [ResourceConstant, number],
        ['O', 500] as [ResourceConstant, number],
        ['ZHO2', 5000] as [ResourceConstant, number], // saturated final output
      ]);
      // Without saturation: ZHO2 (the highest tier) wins.
      expect(findNextChainStep(chain, available)?.output).toBe('ZHO2');

      // With saturation: ZHO2 is skipped (output already at saturation), so the
      // earlier Z+H->ZH step (also viable) is returned instead.
      expect(findNextChainStep(chain, available, 5000)?.output).toBe('ZH');
    });

    it('without saturation arg, behavior is unchanged', () => {
      const chain = buildReactionChain('ZHO2' as ResourceConstant);
      const available = new Map<ResourceConstant, number>([
        ['Z', 500] as [ResourceConstant, number],
        ['H', 500] as [ResourceConstant, number],
        ['ZH', 5000] as [ResourceConstant, number],
        ['O', 500] as [ResourceConstant, number],
        ['ZHO2', 5000] as [ResourceConstant, number],
      ]);
      expect(findNextChainStep(chain, available)?.output).toBe('ZHO2');
    });
  });
});

describe('chainMissingInputs', () => {
  it('returns empty when chain is empty', () => {
    expect(chainMissingInputs([], new Map())).toEqual([]);
  });

  it('returns all missing leaf inputs across the chain', () => {
    const chain = buildReactionChain('ZHO2' as ResourceConstant);
    // Have Z but not H — O is also missing (needed for ZH+O→ZHO2)
    const available = new Map<ResourceConstant, number>([['Z', 500] as [ResourceConstant, number]]);
    const missing = chainMissingInputs(chain, available);
    // H is a leaf (needed for Z+H→ZH) and O is a leaf (needed for ZH+O→ZHO2)
    expect(missing).toContain('H');
    expect(missing).toContain('O');
    // ZH is produced by the chain — must NOT appear as a buy candidate
    expect(missing).not.toContain('ZH');
  });

  it('returns empty when all leaf inputs are at or above MIN_STEP_AMOUNT', () => {
    const chain = buildReactionChain('ZHO2' as ResourceConstant);
    const available = new Map<ResourceConstant, number>([
      ['Z', 500] as [ResourceConstant, number],
      ['H', 500] as [ResourceConstant, number],
      ['O', 500] as [ResourceConstant, number],
    ]);
    // All leaf inputs stocked — ZH will be produced in-lab, nothing to buy
    const missing = chainMissingInputs(chain, available);
    expect(missing).toHaveLength(0);
  });

  it('does not stop early at a "producing" step — scans all branches', () => {
    // Reproduces the live stuck state: XGHO2 goal, OH is low (59) but its
    // leaf inputs O/H are stocked; the old code returned [] here and never
    // checked the missing X catalyst.
    //
    // Hardcoded XGHO2 chain matching the path through the OH intermediate:
    //   O + H   → OH
    //   G + H   → GH
    //   OH + GH → GH2O
    //   GH2O + O → GHO2
    //   GHO2 + X → XGHO2
    const chain: ReactionStep[] = [
      {
        input1: 'O' as ResourceConstant,
        input2: 'H' as ResourceConstant,
        output: 'OH' as ResourceConstant,
      },
      {
        input1: 'G' as ResourceConstant,
        input2: 'H' as ResourceConstant,
        output: 'GH' as ResourceConstant,
      },
      {
        input1: 'OH' as ResourceConstant,
        input2: 'GH' as ResourceConstant,
        output: 'GH2O' as ResourceConstant,
      },
      {
        input1: 'GH2O' as ResourceConstant,
        input2: 'O' as ResourceConstant,
        output: 'GHO2' as ResourceConstant,
      },
      {
        input1: 'GHO2' as ResourceConstant,
        input2: 'X' as ResourceConstant,
        output: 'XGHO2' as ResourceConstant,
      },
    ];

    // Live availability from storage+terminal (buildAvailableMap snapshot)
    const available = new Map<ResourceConstant, number>([
      ['O', 3000] as [ResourceConstant, number],
      ['H', 15000] as [ResourceConstant, number],
      ['OH', 59] as [ResourceConstant, number],
      ['U', 0] as [ResourceConstant, number],
      ['L', 0] as [ResourceConstant, number],
      ['Z', 65] as [ResourceConstant, number],
      ['K', 2] as [ResourceConstant, number],
      ['G', 0] as [ResourceConstant, number],
      ['GO', 95] as [ResourceConstant, number],
      ['GHO2', 1055] as [ResourceConstant, number],
      ['X', 0] as [ResourceConstant, number],
    ]);

    const missing = chainMissingInputs(chain, available);

    // G and X are the missing leaf inputs (O and H are stocked)
    expect(missing).toContain('G' as ResourceConstant);
    expect(missing).toContain('X' as ResourceConstant);
    // Must NOT be empty — this is exactly the bug the fix addresses
    expect(missing.length).toBeGreaterThan(0);
    // OH, GH, GH2O, GHO2, XGHO2 are all produced by the chain — never bought
    expect(missing).not.toContain('OH' as ResourceConstant);
    expect(missing).not.toContain('GH' as ResourceConstant);
    expect(missing).not.toContain('GH2O' as ResourceConstant);
    expect(missing).not.toContain('GHO2' as ResourceConstant);
  });

  it('returns empty when all leaf inputs are fully stocked (nothing to buy)', () => {
    // Same chain structure, but all leaf inputs are at MIN_STEP_AMOUNT (200)
    const chain: ReactionStep[] = [
      {
        input1: 'O' as ResourceConstant,
        input2: 'H' as ResourceConstant,
        output: 'OH' as ResourceConstant,
      },
      {
        input1: 'G' as ResourceConstant,
        input2: 'H' as ResourceConstant,
        output: 'GH' as ResourceConstant,
      },
      {
        input1: 'OH' as ResourceConstant,
        input2: 'GH' as ResourceConstant,
        output: 'GH2O' as ResourceConstant,
      },
      {
        input1: 'GH2O' as ResourceConstant,
        input2: 'O' as ResourceConstant,
        output: 'GHO2' as ResourceConstant,
      },
      {
        input1: 'GHO2' as ResourceConstant,
        input2: 'X' as ResourceConstant,
        output: 'XGHO2' as ResourceConstant,
      },
    ];

    const available = new Map<ResourceConstant, number>([
      ['O', 500] as [ResourceConstant, number],
      ['H', 500] as [ResourceConstant, number],
      ['G', 500] as [ResourceConstant, number],
      ['X', 500] as [ResourceConstant, number],
    ]);

    expect(chainMissingInputs(chain, available)).toHaveLength(0);
  });
});

describe('getChainIntermediates', () => {
  // NB: the test mock's REACTIONS table omits the real ghodium reaction
  // (ZK + UL → G) and so treats G as a base mineral. In the live game UL/ZK/G
  // ARE produced-and-reconsumed intermediates (Game.REACTIONS has ZK+UL→G); the
  // production code derives the set from that real table. Here we assert the
  // classification *logic* against what the mock topology supports: OH/GH and the
  // tier-2 boosts are produced-and-consumed → intermediates; base elements and
  // X-tier finals are not.
  const intermediates = getChainIntermediates();

  it('contains compounds that are both produced and re-consumed in goal chains', () => {
    for (const compound of ['OH', 'GH'] as ResourceConstant[]) {
      expect(intermediates.has(compound)).toBe(true);
    }
  });

  it('contains tier-2 boosts the X-tier goals consume (so they are held, not sold)', () => {
    for (const compound of ['GH2O', 'GHO2', 'KHO2', 'LHO2'] as ResourceConstant[]) {
      expect(intermediates.has(compound)).toBe(true);
    }
  });

  it('excludes base elements (consumed but never produced — sellable as raw surplus)', () => {
    for (const element of ['H', 'O', 'U', 'K', 'L', 'Z', 'X'] as ResourceConstant[]) {
      expect(intermediates.has(element)).toBe(false);
    }
  });

  it('excludes the X-tier finals (produced but never consumed — sellable)', () => {
    for (const compound of ['XGH2O', 'XGHO2', 'XLHO2', 'XKHO2', 'XZHO2'] as ResourceConstant[]) {
      expect(intermediates.has(compound)).toBe(false);
    }
  });

  it('excludes RESOURCE_BATTERY (not in any reaction chain)', () => {
    expect(intermediates.has(RESOURCE_BATTERY)).toBe(false);
  });
});

describe('isReactionViable', () => {
  const reaction: ReactionStep = {
    input1: 'Z' as ResourceConstant,
    input2: 'K' as ResourceConstant,
    output: 'ZK' as ResourceConstant,
  };

  it('is viable when both inputs meet MIN_STEP_AMOUNT via storage/terminal alone', () => {
    const available = new Map<ResourceConstant, number>([
      ['Z', 500] as [ResourceConstant, number],
      ['K', 500] as [ResourceConstant, number],
    ]);
    const lab1 = mockInputLab();
    const lab2 = mockInputLab();
    expect(isReactionViable(reaction, available, lab1, lab2)).toBe(true);
  });

  it('is viable when supply comes from the input labs rather than storage', () => {
    // A loaded, mid-consumption batch: storage is drawn down to 0 but the
    // input labs still hold a viable pair — must NOT read as unviable, or
    // runLabs would thrash off a reaction that's actively running.
    const available = new Map<ResourceConstant, number>();
    const lab1 = mockInputLab({ Z: 300 } as Partial<Record<ResourceConstant, number>>);
    const lab2 = mockInputLab({ K: 300 } as Partial<Record<ResourceConstant, number>>);
    expect(isReactionViable(reaction, available, lab1, lab2)).toBe(true);
  });

  it('combines storage and lab contents to reach the threshold', () => {
    const available = new Map<ResourceConstant, number>([
      ['Z', 100] as [ResourceConstant, number],
      ['K', 100] as [ResourceConstant, number],
    ]);
    const lab1 = mockInputLab({ Z: 100 } as Partial<Record<ResourceConstant, number>>);
    const lab2 = mockInputLab({ K: 100 } as Partial<Record<ResourceConstant, number>>);
    // 100 + 100 = 200 = MIN_STEP_AMOUNT for each input
    expect(isReactionViable(reaction, available, lab1, lab2)).toBe(true);
  });

  it('is not viable when neither storage nor labs hold enough of an input', () => {
    const available = new Map<ResourceConstant, number>([
      ['Z', 500] as [ResourceConstant, number],
      // K missing entirely
    ]);
    const lab1 = mockInputLab();
    const lab2 = mockInputLab();
    expect(isReactionViable(reaction, available, lab1, lab2)).toBe(false);
  });
});

describe('backedUpLeaves', () => {
  // NB: the mock REACTIONS table treats G as a base mineral (no ZK+UL->G), so
  // OH/GH are the representative produced-and-consumed intermediates here.
  // Chain for GH2O: O+H->OH, G+H->GH, OH+GH->GH2O.
  const chain: ReactionStep[] = [
    {
      input1: 'O' as ResourceConstant,
      input2: 'H' as ResourceConstant,
      output: 'OH' as ResourceConstant,
    },
    {
      input1: 'G' as ResourceConstant,
      input2: 'H' as ResourceConstant,
      output: 'GH' as ResourceConstant,
    },
    {
      input1: 'OH' as ResourceConstant,
      input2: 'GH' as ResourceConstant,
      output: 'GH2O' as ResourceConstant,
    },
  ];

  it('returns the leaf inputs of a step whose output is saturated', () => {
    const available = new Map<ResourceConstant, number>([
      ['OH', 6000] as [ResourceConstant, number], // >= saturation (5000)
      ['GH', 100] as [ResourceConstant, number],
    ]);
    const leaves = backedUpLeaves(chain, available, 5000);
    // OH is saturated -> its leaves O and H are backed up
    expect(leaves.has('O' as ResourceConstant)).toBe(true);
    expect(leaves.has('H' as ResourceConstant)).toBe(true);
    // GH is below saturation -> its leaf G is NOT backed up (just from this step)
    expect(leaves.has('G' as ResourceConstant)).toBe(false);
  });

  it('excludes leaves of steps whose output is below saturation', () => {
    const available = new Map<ResourceConstant, number>([
      ['OH', 100] as [ResourceConstant, number],
      ['GH', 100] as [ResourceConstant, number],
      ['GH2O', 100] as [ResourceConstant, number],
    ]);
    const leaves = backedUpLeaves(chain, available, 5000);
    expect(leaves.size).toBe(0);
  });

  it('does not return intermediate outputs as leaves (only base minerals)', () => {
    const available = new Map<ResourceConstant, number>([
      ['GH2O', 6000] as [ResourceConstant, number], // saturated final step
    ]);
    const leaves = backedUpLeaves(chain, available, 5000);
    // GH2O's inputs are OH and GH, both produced earlier in the chain — not leaves
    expect(leaves.has('OH' as ResourceConstant)).toBe(false);
    expect(leaves.has('GH' as ResourceConstant)).toBe(false);
  });
});
