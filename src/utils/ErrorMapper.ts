interface SourceMapMapping {
  generatedLine: number;
  generatedColumn: number;
  originalLine: number;
  originalColumn: number;
  source: string;
  name?: string;
}

// VLQ decoding for source map mappings
const VLQ_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function decodeVlq(encoded: string): number[] {
  const results: number[] = [];
  let shift = 0;
  let value = 0;

  for (const char of encoded) {
    const digit = VLQ_CHARS.indexOf(char);
    if (digit === -1) break;

    const continuation = digit & 32;
    value += (digit & 31) << shift;

    if (continuation) {
      shift += 5;
    } else {
      const negate = value & 1;
      value >>= 1;
      results.push(negate ? -value : value);
      value = 0;
      shift = 0;
    }
  }

  return results;
}

function parseMappings(mappingsStr: string, sources: string[]): SourceMapMapping[] {
  const mappings: SourceMapMapping[] = [];
  const lines = mappingsStr.split(';');

  let generatedLine = 0;
  let originalLine = 0;
  let originalColumn = 0;
  let sourceIndex = 0;

  for (const line of lines) {
    generatedLine++;
    let generatedColumn = 0;

    if (!line) continue;

    const segments = line.split(',');
    for (const segment of segments) {
      const decoded = decodeVlq(segment);
      if (decoded.length < 4) continue;

      generatedColumn += decoded[0]!;
      sourceIndex += decoded[1]!;
      originalLine += decoded[2]!;
      originalColumn += decoded[3]!;

      mappings.push({
        generatedLine,
        generatedColumn,
        originalLine: originalLine + 1, // 1-based
        originalColumn,
        source: sources[sourceIndex] ?? 'unknown',
      });
    }
  }

  return mappings;
}

interface SourceMap {
  mappings: SourceMapMapping[];
  loadedAt: number;
}

let cachedMap: SourceMap | undefined;

function getSourceMap(): SourceMapMapping[] | undefined {
  // Invalidate cache on global reset (new code deploy)
  if (cachedMap && cachedMap.loadedAt === Game.time) {
    return cachedMap.mappings;
  }

  // Only attempt to load once per tick on cache miss
  if (cachedMap) {
    return cachedMap.mappings;
  }

  try {
    const raw = require('main.js.map') as
      | {
          mappings?: string;
          sources?: string[];
        }
      | undefined;

    if (!raw?.mappings || !raw.sources) {
      return undefined;
    }

    const mappings = parseMappings(raw.mappings, raw.sources);
    cachedMap = { mappings, loadedAt: Game.time };
    return mappings;
  } catch {
    console.log('ErrorMapper: Could not load source map');
    return undefined;
  }
}

function findOriginalPosition(
  mappings: SourceMapMapping[],
  line: number,
  column: number,
): SourceMapMapping | undefined {
  // Find the closest mapping for the given generated position
  let best: SourceMapMapping | undefined;

  for (const mapping of mappings) {
    if (mapping.generatedLine === line) {
      if (mapping.generatedColumn <= column) {
        if (!best || mapping.generatedColumn > best.generatedColumn) {
          best = mapping;
        }
      }
    }
  }

  return best;
}

function sourceMapStackTrace(error: Error): string {
  const mappings = getSourceMap();
  const stack = error.stack;
  if (!stack) return '';
  if (!mappings) return stack;

  return stack
    .split('\n')
    .map((line) => {
      const match = /^\s*at\s+(.+?\s+)?\(?([A-Za-z0-9._\\-\\/]+):(\d+):(\d+)\)?$/g.exec(line);
      if (!match) return line;

      const name = match[1] ?? '';
      const fileName = match[2] ?? '';
      const lineNum = parseInt(match[3] ?? '0', 10);
      const colNum = parseInt(match[4] ?? '0', 10);

      if (fileName === 'main') {
        const pos = findOriginalPosition(mappings, lineNum, colNum);
        if (pos) {
          return `    at ${name}(${pos.source}:${pos.originalLine}:${pos.originalColumn})`;
        }
      }

      return line;
    })
    .join('\n');
}

export class ErrorMapper {
  public static wrapLoop(fn: () => void): () => void {
    return () => {
      try {
        fn();
      } catch (e: unknown) {
        if (e instanceof Error) {
          console.log(sourceMapStackTrace(e));
        } else {
          console.log(sourceMapStackTrace(new Error(String(e))));
        }
      }
    };
  }
}
