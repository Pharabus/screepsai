import {
  buildReactionChain,
  chainMissingInputs,
  findNextChainStep,
  type ReactionStep,
} from '../../src/utils/reactions';
import { resetGameGlobals } from '../mocks/screeps';

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
