import {
  buildReactionChain,
  chainMissingInputs,
  findNextChainStep,
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
    // XZHO2 = ZHO2 + H, ZHO2 = ZH + O, ZH = Z + H
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

  it('returns the missing input for the first step', () => {
    const chain = buildReactionChain('ZHO2' as ResourceConstant);
    // Have Z but not H
    const available = new Map<ResourceConstant, number>([['Z', 500] as [ResourceConstant, number]]);
    const missing = chainMissingInputs(chain, available);
    expect(missing).toContain('H');
  });

  it('returns empty when first step inputs are both available', () => {
    const chain = buildReactionChain('ZHO2' as ResourceConstant);
    const available = new Map<ResourceConstant, number>([
      ['Z', 500] as [ResourceConstant, number],
      ['H', 500] as [ResourceConstant, number],
    ]);
    // Z and H are available, so the ZH→ZHO2 step is the blocker — but ZH is not yet produced
    // chainMissingInputs should return [] because we're currently producing ZH
    const missing = chainMissingInputs(chain, available);
    expect(missing).toHaveLength(0);
  });
});
