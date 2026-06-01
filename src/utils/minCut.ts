/**
 * Min-cut (max-flow) barrier computation — Overmind-style vertex split graph.
 *
 * This module is Screeps-runtime-free so it can be unit-tested without mocks.
 * The only dependency is a terrain wall predicate.
 *
 * ## Algorithm
 *
 * Each non-wall tile is split into two nodes: an "in-node" and an "out-node",
 * connected by an internal edge whose capacity encodes how desirable it is to
 * cut that tile:
 *   - protected tile → capacity INF (never slice the interior)
 *   - other buildable tile → capacity 1 (rampart candidate)
 *   - border tile (always exit-reachable) → capacity INF (flow passes through freely)
 *
 * Adjacency edges (out-node → in-node of each neighbour) have capacity INF so
 * the cut never falls on these edges — only on the internal in→out edges.
 *
 * Super-source (S) connects to every protected tile's in-node with capacity INF.
 * Super-sink (T) connects from every border tile's out-node with capacity INF.
 *
 * After running Dinic's max-flow, the barrier tiles are those non-wall,
 * non-protected, buildable tiles (2–47) whose internal in→out edge is saturated
 * (remaining capacity = 0).
 *
 * ## Dinic's algorithm
 *
 * BFS builds a level graph; DFS pushes blocking flow. Repeat until no
 * augmenting path exists. Time complexity O(V²·E) — fast enough to run once
 * and cache per room.
 *
 * ## Usage
 *
 *   const tiles = computeMinCut({
 *     isWall: (x, y) => terrain.get(x, y) === TERRAIN_MASK_WALL,
 *     protected: protectedSet,   // Set<string> of "x,y" keys
 *     roomWidth: 50,
 *     roomHeight: 50,
 *   });
 *   // tiles: { x, y }[]
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Large finite value used instead of Infinity for residual arithmetic. */
const INF = 1_000_000;

/**
 * Room coordinates range 0–49. The exit ring (0 and 49) cannot hold structures
 * and is the graph sink. Walls/ramparts ARE buildable on the edge-adjacent ring
 * (1 and 48), and the min-cut MUST be allowed to place barrier tiles there — a
 * cut that leans on the room edge otherwise leaves a 1-tile leak lane at x1/y1/
 * x48/y48 that a hostile slips through (observed live on W43N58 toward 2,0).
 */
const BORDER_MIN = 0;
const BORDER_MAX = 49;
const BUILD_MIN = 1;
const BUILD_MAX = 48;

// 8-directional neighbourhood (matches perimeterPlanner DX8/DY8)
const DX8 = [-1, 0, 1, -1, 1, -1, 0, 1];
const DY8 = [-1, -1, -1, 0, 0, 1, 1, 1];

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface MinCutOptions {
  /** Returns true when (x,y) is a natural terrain wall tile — not a graph node. */
  isWall: (x: number, y: number) => boolean;
  /**
   * Set of "x,y"-encoded tiles that are considered protected (i.e. the interior
   * we are defending). Their internal edge capacity is INF.
   */
  protected: Set<string>;
  roomWidth?: number; // default 50
  roomHeight?: number; // default 50
}

export interface MinCutTile {
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// Dinic's max-flow internals
// ---------------------------------------------------------------------------

interface Edge {
  to: number;
  cap: number;
  rev: number; // index of reverse edge in graph[to]
}

type Graph = Edge[][];

function addEdge(graph: Graph, from: number, to: number, cap: number): void {
  graph[from]!.push({ to, cap, rev: graph[to]!.length });
  graph[to]!.push({ to: from, cap: 0, rev: graph[from]!.length - 1 });
}

/**
 * BFS to build the level graph.
 * Returns true if the sink is reachable from the source.
 */
function bfs(graph: Graph, s: number, t: number, level: Int32Array): boolean {
  level.fill(-1);
  level[s] = 0;
  const queue: number[] = [s];
  let head = 0;
  while (head < queue.length) {
    const v = queue[head++]!;
    for (const e of graph[v]!) {
      // Node indices are always in range (typed arrays sized nodeCount); the
      // non-null assertions satisfy noUncheckedIndexedAccess.
      if (e.cap > 0 && level[e.to]! < 0) {
        level[e.to] = level[v]! + 1;
        queue.push(e.to);
      }
    }
  }
  return level[t]! >= 0;
}

/**
 * DFS to push blocking flow along the level graph.
 * `iter` is the current edge index per node (advancing-pointer optimisation).
 */
function dfs(
  graph: Graph,
  v: number,
  t: number,
  f: number,
  level: Int32Array,
  iter: Int32Array,
): number {
  if (v === t) return f;
  const edges = graph[v]!;
  for (; iter[v]! < edges.length; iter[v]!++) {
    const e = edges[iter[v]!]!;
    if (e.cap <= 0 || level[v]! + 1 !== level[e.to]) continue;
    const d = dfs(graph, e.to, t, Math.min(f, e.cap), level, iter);
    if (d > 0) {
      e.cap -= d;
      graph[e.to]![e.rev]!.cap += d;
      return d;
    }
  }
  return 0;
}

/**
 * BFS over the RESIDUAL graph from the source — visits every node reachable via
 * edges with remaining capacity > 0. Used after max-flow to identify the
 * min-cut: nodes reachable here are on the source side of the cut.
 */
function reachableFromSource(graph: Graph, s: number, nodeCount: number): Uint8Array {
  const reachable = new Uint8Array(nodeCount);
  reachable[s] = 1;
  const queue: number[] = [s];
  let head = 0;
  while (head < queue.length) {
    const v = queue[head++]!;
    for (const e of graph[v]!) {
      if (e.cap > 0 && reachable[e.to] === 0) {
        reachable[e.to] = 1;
        queue.push(e.to);
      }
    }
  }
  return reachable;
}

/** Run Dinic's max-flow from s to t. Returns the flow value (not used directly). */
function maxFlow(graph: Graph, s: number, t: number, nodeCount: number): number {
  const level = new Int32Array(nodeCount);
  const iter = new Int32Array(nodeCount);
  let flow = 0;
  while (bfs(graph, s, t, level)) {
    iter.fill(0);
    let f: number;
    do {
      f = dfs(graph, s, t, INF, level, iter);
      flow += f;
    } while (f > 0);
  }
  return flow;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Compute the minimum-cut barrier tiles for a Screeps room.
 *
 * Returns an array of buildable (x,y) tiles that form the minimum barrier
 * separating the protected core from all exit-reachable border tiles.
 * Natural wall tiles are never returned (they are free barrier elements).
 */
export function computeMinCut(opts: MinCutOptions): MinCutTile[] {
  const W = opts.roomWidth ?? 50;
  const H = opts.roomHeight ?? 50;
  const { isWall } = opts;
  const protectedSet = opts.protected;

  // -------------------------------------------------------------------------
  // Node numbering
  // In-node for tile (x,y): tileId(x,y) * 2
  // Out-node for tile (x,y): tileId(x,y) * 2 + 1
  // Super-source: W*H*2
  // Super-sink:   W*H*2 + 1
  // -------------------------------------------------------------------------
  const tileId = (x: number, y: number): number => y * W + x;
  const inNode = (id: number): number => id * 2;
  const outNode = (id: number): number => id * 2 + 1;

  const S = W * H * 2; // super-source
  const T = W * H * 2 + 1; // super-sink
  const nodeCount = W * H * 2 + 2;

  // Initialise adjacency list
  const graph: Graph = Array.from({ length: nodeCount }, () => []);

  // -------------------------------------------------------------------------
  // Build graph
  // -------------------------------------------------------------------------
  for (let y = BORDER_MIN; y <= BORDER_MAX; y++) {
    for (let x = BORDER_MIN; x <= BORDER_MAX; x++) {
      if (isWall(x, y)) continue;

      const id = tileId(x, y);
      const key = `${x},${y}`;
      const isBorder = x === BORDER_MIN || x === BORDER_MAX || y === BORDER_MIN || y === BORDER_MAX;
      const isProtected = protectedSet.has(key);

      // Internal edge: in-node → out-node
      if (isProtected || isBorder) {
        // Never cut protected tiles or border tiles
        addEdge(graph, inNode(id), outNode(id), INF);
      } else {
        // Potentially cut this tile (capacity 1 = single rampart candidate)
        addEdge(graph, inNode(id), outNode(id), 1);
      }

      // Super-source → protected tiles
      if (isProtected) {
        addEdge(graph, S, inNode(id), INF);
      }

      // Border tile out-nodes → super-sink
      if (isBorder) {
        addEdge(graph, outNode(id), T, INF);
      }

      // Adjacency edges: out-node → in-node of each passable neighbour (8-dir)
      for (let d = 0; d < 8; d++) {
        const nx = x + DX8[d]!;
        const ny = y + DY8[d]!;
        if (nx < BORDER_MIN || nx > BORDER_MAX || ny < BORDER_MIN || ny > BORDER_MAX) continue;
        if (isWall(nx, ny)) continue;
        const nid = tileId(nx, ny);
        addEdge(graph, outNode(id), inNode(nid), INF);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Run max-flow
  // -------------------------------------------------------------------------
  maxFlow(graph, S, T, nodeCount);

  // -------------------------------------------------------------------------
  // Extract barrier tiles via residual reachability (the true min-cut).
  //
  // After max-flow, BFS from S over residual edges (cap > 0). A tile's internal
  // in→out edge is a min-cut edge iff its in-node is source-side (reachable)
  // and its out-node is sink-side (not reachable). A capacity-1 internal edge
  // saturating is NOT sufficient — flow merely passing through a tile also
  // saturates it; only the residual-reachability boundary identifies genuine
  // cut vertices. Protected/border tiles use INF internal edges and can never
  // be on this boundary, so the guards below are belt-and-braces.
  // -------------------------------------------------------------------------
  const reachable = reachableFromSource(graph, S, nodeCount);

  const result: MinCutTile[] = [];

  for (let y = BUILD_MIN; y <= BUILD_MAX; y++) {
    for (let x = BUILD_MIN; x <= BUILD_MAX; x++) {
      if (isWall(x, y)) continue;
      const key = `${x},${y}`;
      if (protectedSet.has(key)) continue;

      const id = tileId(x, y);
      if (reachable[inNode(id)] === 1 && reachable[outNode(id)] === 0) {
        result.push({ x, y });
      }
    }
  }

  return result;
}
