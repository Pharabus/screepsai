# Next phase plan

Written 2026-11-05.
The economy runs itself (4 rooms at RCL 8, about 540M credits, nothing economic left in `todo.md`).
This document plans the four growth directions in the order chosen: CPU headroom, power creeps and commodities, highway raids, then war.

## Verified starting state (live, 2026-11-05)

- `Game.cpu.limit` 20, `shardLimits` is `{ shard3: 20 }`, `unlocked` false.
- Main loop averages about 19 of 20 CPU, bucket idles around 5000.
- GCL 8 (14% to GCL 9), so up to 8 owned rooms are allowed and 4 are used.
- GPL level 0, progress 550 of 1000.
- No power creeps exist.
- 4 power spawns, 4 nukers and 4 factories are built.
- All 4 factories are unleveled (`level` undefined), so they run only level-0 recipes.
- W44N57 terminal holds about 3600 silicon that nothing consumes beyond the wire chain.
- Two power banks are known (W44N60 with 437 ticks left, W46N60 with 1192 left), neither realistically worth attacking.

## Ground rules for every plan

- Ship dormant behind a `Memory.*` flag, validate live, then flip.
  This is engineering lesson 3.
- Reproduce and measure on live data before designing (lessons 2 and 5).
- Prove the load-bearing engine assumption with a live test first, as with the looter role.
- Each plan has kill criteria.
  If they trip, stop and write the lesson into `CLAUDE.md` so it is not re-attempted.
- Nothing aggressive toward a player is ever sent live without Andrew approving the specific target.

---

## Plan 1 - Break the CPU ceiling

### Goal

Free enough CPU to run rooms 5 to 8 on shard3.
GCL already allows them.
CPU is the only thing stopping growth.

### What is known

- shard3 hard-caps every player at 20 CPU, and no subscription or GCL changes that.
- Every creep action costs a flat 0.2 CPU, so only fewer creeps or fewer intents per creep lowers the floor (see the `cpu-intent-floor` memory).
- Rough cost of one more room is about 4 to 5 CPU (about 13 creeps per room at about 1.5 intents each).
  This estimate must be checked in step 1a.
- Smarter dispatch cannot win (haulerPool and LogisticsNetwork stay shelved).

### CPU profile flag (design rule for every trim)

- Every CPU trim in this plan is gated on a single helper, `isCpuConstrained()` (in `src/utils/cpuProfile.ts`), never on a shard name.
- It derives from the real budget: `Game.cpu.limit` at or below a threshold (start at 20, the shard3 cap), so it is true on shard3 and false on any shard with a larger CPU allowance.
- An optional `Memory.cpuProfile` (`'constrained'` or `'unconstrained'`) overrides the derived value, for testing and for forcing behaviour on a new shard.
- Trims that cost real output (fewer or smaller haulers, dropped remotes, capped upgraders) apply only when constrained.
  On an unconstrained shard the original, higher-output behaviour is kept.
- Trims that are pure waste removal (duplicate scans, uncached `find()` calls) apply everywhere and are not flagged.
- The room-count ceiling also reads the profile, so an unconstrained shard is not held to what shard3 can afford.
- `creepThrottle` bucket bands keep their own flag and are not affected.
- The helper is memoised per tick and covered by unit tests for both profiles and the override.
- This also keeps the multi-shard option cheap to try later, since the bot already knows which behaviour set to use.

### Steps

1. **1a - Measure the floor.**
   - Enable `Memory.profiling` for about 1000 ticks.
   - Record per-role creep count, per-role CPU per call, and non-creep intents per tick (labs, links, towers, factory, terminal, observer, power spawn).
   - Compute intents per tick as `main.loop avg / 0.2` and attribute it to roles and structures.
   - Output: a table in this file naming the top 5 cost centres.
#### 1a results (profiled ticks 84,091,291 to about 84,092,100, 829 samples, 43 creeps)

Method: `Memory.stats` holds per-call EMAs.
Amortised CPU per tick is estimated as `avg per call x calls / 829 ticks`.
Treat figures as roughly +/-10%, since EMAs weight recent samples and profiling adds a little CPU itself.
`main.loop` averaged 18.69 (max 41.8), which is about 93 intent-equivalents at 0.2 each, though part of that is JS overhead and not intents.

| Cost centre | Per call | Calls | About CPU per tick | Kind |
|---|---|---|---|---|
| `rooms` (all creep roles) | 12.66 | 829 | 12.7 | creep intents plus role logic |
| `towers` | 2.41 | 829 | 2.4 | mostly intents (about 12 per tick) |
| `construction` (whole manager) | 16.46 | 117 | 2.3 | pure overhead |
| `spawner` | 1.85 | 829 | 1.9 | pure overhead |
| `observer` | 1.04 | 410 | 0.5 | scans plus 1 intent |
| `terminal`, `labs`, `links`, rest | under 0.5 each | | about 0.9 | mixed |

Inside `rooms` (per-call average x creeps working per tick):

| Role | Avg CPU per call | Creeps per tick | About CPU per tick |
|---|---|---|---|
| hauler | 0.43 | 11.3 | 4.8 |
| miner | 0.37 | 9.9 | 3.7 |
| remoteHauler | 0.30 | 7.4 | 2.2 |
| repairer | 0.36 | 2.9 | 1.0 |
| upgrader | 0.22 | 3.0 | 0.7 |
| reserver | 0.22 | 2.8 | 0.6 |
| hunter, mineralMiner, builder, keeperKiller, remoteBuilder | under 0.35 | under 1 | 0.2 |

Inside `construction` (4 rooms, each sub-step runs once per room per sweep):

| Sub-step | Per call | About CPU per tick |
|---|---|---|
| `clearBlockingExtensions` | 1.93 | 1.1 |
| `placeLabs` | 0.94 (max 12.7) | 0.5 |
| `placeRoads` | 0.40 | 0.2 |
| `placeRamparts` | 0.27 | 0.15 |
| everything else | under 0.1 each | about 0.4 |

Findings:

- About 4.5 to 5 CPU per tick is pure overhead with no creep intents: construction (2.3), spawner (1.9), observer scans (0.5).
  Overhead like this sits above the intent floor and can be removed without losing any output.
- `clearBlockingExtensions` and `placeLabs` run a full sweep every 5 ticks per room even though all four rooms are RCL 8 and fully built.
  Together they cost about 1.6 CPU per tick.
- The spawner rebuilds its queue every tick, and its max is 8.9.
- Towers cost 2.4 CPU per tick, which is the largest single non-creep item.
  Wall repair on every tick is the likely driver, to be confirmed.
- Creep floor: haulers (4.8), miners (3.7) and remote haulers (2.2) are income-critical and make up 10.7 of the 12.7 in `rooms`.
- Repairers cost 1.0 CPU per tick for 4 creeps on fully built RCL 8 rooms, which makes them the best creep-side trim candidate.
- Spikes: `main.loop` max 41.8 is driven by `placeLabs` (12.7), `construction` (24.6 in one sweep), `placePerimeterWalls` (8.1), `factory` (8.4), `remoteHauler` (9.0) and `spawner` (8.9).
  Single-tick spikes drain bucket even when the average is fine.

Conclusion for 1b: the 5 CPU target looks reachable from overhead alone, without touching income-critical creeps.
Because it needs no output loss, that overhead work applies on every shard and is not gated on `isCpuConstrained()`.
Creep trims (repairers, hauler consolidation) stay gated and are only needed if the overhead work falls short.

#### Trim 1 result: skip settled-room construction sweeps (v1.0.377, 822 ticks from tick 84,094,452)

| Metric | Baseline (1a) | After | Note |
|---|---|---|---|
| `construction` CPU per tick (amortised) | 2.32 | 0.31 | saved about 2.0, the direct effect of the trim |
| `clearBlockingExtensions` calls | 468 | 64 | about 7x fewer sweeps, as designed |
| `placeLabs` calls | 468 | 64 | same |
| `main.loop` average | 18.69 | 15.59 | partly confounded, see below |
| `main.loop` max | 41.8 | 48.1 | not improved yet, see below |
| bucket | about 5000 | 6203 | rising |
| errors | none | none | `Memory._errors` empty |

Confounders and open questions:

- Only the 2.0 CPU construction drop is directly attributable to the trim.
- `towers` fell from 2.41 to 0.69 and `rooms` from 12.66 to 10.81 between runs without any related change.
  Tower and creep CPU swing with activity (repairs, creep counts), so treat the rest of the 3.1 CPU loop drop as unexplained until a longer window confirms it.
- `observer` rose from 0.51 to 0.97 per tick because it runs on more ticks now.
  Managers gated at `THROTTLE_NORMAL` (bucket 5000) were being skipped about half the time in the baseline run, and the bucket is now above that floor.
  Any CPU saving that lifts the bucket also makes these managers run more, which will partly offset later trims.
- The `main.loop` max of 48.1 and `construction` max of 28.8 may be a cold-start spike right after the deploy's global reset, since the max sticks.
  This needs a spike check from a longer window, or a `resetStats()` once things are warm, before concluding the spikes persist.

2. **1b - Rank trims by CPU saved per unit of lost output.**
   Candidates to evaluate, not commitments:
   - RCL 8 upgraders: the controller caps at 15 energy per tick per room, so check whether upgrader count or body exceeds what the cap can use.
   - Hauler fleet: fewer, larger haulers per room (the hauler body cap, route length and link coverage decide this).
   - Remote haulers and miners: merge or drop the lowest-yield remotes.
   - Idle or low-value creeps (repairers, builders, scouts) that run when there is little to do.
   - Structure intents: lab reactions across output labs, link transfers, tower actions.
   - Throttle tiers in `creepThrottle.ts`: confirm they shed the right roles first.
3. **1c - Add `isCpuConstrained()`, then implement the top 2 or 3 trims behind it.**
   - One trim per deploy, measured for 2000+ ticks each.
   - Success metric: `main.loop` average down and bucket trend flat or rising, with storage energy and controller progress unchanged.
4. **1d - Claim room 5.**
   - Gate: loop average at or below about 15 and bucket above 6000 for a sustained window.
   - Use the existing `claimCandidates()` and `claim()` pipeline, one room at a time.
   - Measure the real per-room cost and revise the room 6 to 8 targets from it.

### Decision for Andrew (not recommended first)

- **Multi-shard expansion** would need a paid CPU unlock to get 20 + GCL x 10 on other shards.
- Memory is per shard, so the bot would need `InterShardMemory`, portal logistics and per-shard CPU splitting.
- That is a large rework with a recurring cost.
  Revisit only if shard3 trims cannot reach 8 rooms.

### Kill criteria

- If 1a shows the floor is dominated by income-critical creeps (miners, source haulers), trims will cost real income.
  Then cap the room count at what the data supports and stop.

---

## Plan 3 - Power creeps and commodities

### Goal

Add the missing power-creep layer: reach GPL 1, run an operator, and use it to level a factory and boost output.
The silicon chain stops at wire today because deeper recipes need a factory level, which only `PWR_OPERATE_FACTORY` sets.

### What is known

- GPL is 550 of 1000, so about 450 more power processed reaches GPL 1.
- The power pipeline exists: `powerSpawn.processPower`, `buyPower()`, `powerBankSquad()`, and hauler feeding of power spawns.
- No code touches `PowerCreep`.

### Steps

1. **3a - Reach GPL 1 and prove the mechanics.**
   - Check how much power is in stock, then `buyPower()` the remainder (credits are not a constraint) and let the power spawns process it.
   - Before designing anything, read the engine constants (`POWER_INFO`, `POWER_CREEP_*`) and record in this file the real GPL budget, level requirements per power, renewal rules, and the `enableRoom` requirement.
   - Do a live test: create one operator, spawn it, enable the room, renew it.
2. **3b - `src/managers/powerCreep.ts`.**
   - Lifecycle: create, spawn, renew before the TTL expires, and handle death.
   - Registered like a manager, not a creep role, because power creeps are not in `Game.creeps`.
   - Wrapped in `profile()` and gated behind a flag.
3. **3c - First powers.**
   - `PWR_GENERATE_OPS` first, because ops fund every other power.
   - `PWR_OPERATE_FACTORY` to set a factory level (the level choice is permanent, so pick it from the recipe plan below).
4. **3d - Recipe plan.**
   - Choose which commodity chains to build from the deposit types actually found live (only silicon so far).
   - Extend `factory.ts` with level-gated recipes and the hauler input and output logistics it already supports generically.
5. **3e - Optional boosts.**
   - `PWR_OPERATE_LAB` and `PWR_OPERATE_TOWER` only if the live data shows they pay for their CPU.

### Honest caveats

- This adds depth and GPL progress, not CPU headroom, and it adds a little CPU.
- Credits are already abundant, so commodity sales are not the payoff.
  Decide up front what success means (GPL rank, higher-tier boosts, or just capability) before building 3d.

### Kill criteria

- If 3a shows the first power needs a level the GPL budget cannot afford, stop at the research notes.

---

## Plan 4 - Highway raids

### Goal

Turn the existing highway scanning into occasional, low-risk income: power banks, deposits, then Invader Core strongholds.

### What is known

- Observer scanning records power banks and deposits into room memory.
- The power squad (attacker, healer, hauler) and the `depositMiner` role exist but are launched manually.
- A bank has 2M hit points, so a one-attacker plan takes about 2200 ticks and the 1000 to 1200 tick banks seen so far are not feasible.
- Strongholds are not scanned at all.

### Steps

1. **4a - Make power banks pay.**
   - Add a viability calculator: damage per tick from available bodies, travel time, decay left, reflected damage, free tiles.
   - Add an advisory report (a `highwayStatus()` console command) that says go or no-go per bank.
   - Only after a few reports match reality, consider automatic launch.
2. **4b - Deposits.**
   - Report cooldown trend and expected yield per trip.
   - Decide a rule for automatic `mineDeposit` only if the report shows consistent profit.
3. **4c - Stronghold intel.**
   - Extend `recordHighwayIntel` to record Invader Core level, tower and rampart counts, and loot containers.
   - Intel only, no combat.
4. **4d - Stronghold assault (gated).**
   - Needs a formation primitive for a ranged/healer pair.
   - Build that primitive here, in the smallest form, and have Plan 2 reuse it.
   - Start at level 1 strongholds only and escalate one level at a time.

### Kill criteria

- If squad losses exceed loot value over the first three attempts, freeze at intel and advisory reports.
  This mirrors how SK engagement was gated after live keeper-killer losses.

---

## Plan 2 - War

### Goal

Take rooms from a weaker neighbouring player, using what already exists (boosts, dismantler, defenders, healers, 4 nukers) plus the missing coordination layer.

### What is known

- Four nukers are built and sit empty, because no manager loads or fires them.
- A nuker needs 300k energy and 5k ghodium to load, and G stock is only about 700 right now, so arming even one needs a G production goal.
- `dismantler` exists and has been used to clear a degraded room.
- Taking an inactive room by waiting for controller decay and then claiming it is already proven (W44N59), and it needs no combat.

### Steps

1. **2a - Intel on neighbours.**
   - Use the observer and a cheap scout to build a per-player profile: room count, RCL, tower count, wall HP, creep activity.
   - Add a `warTargets()` console report that ranks targets by weakness and distance.
2. **2b - Nuker manager (`src/managers/nuker.ts`).**
   - Auto-load, and add a `G` goal to the lab chain so the stock exists.
   - Firing only through an explicit `nuke(room, x, y)` command with checks against our own rooms and our own creeps' positions.
3. **2c - Formation manager.**
   - Reuse the primitive from Plan 4d and extend it to 2 to 4 creeps in lockstep.
   - Unit-test the movement logic heavily, since a live aggressor is hard to produce for validation.
4. **2d - Breach squad.**
   - Dismantler plus healer pairs, boosted, with retreat on low HP.
   - Run as a new `attack` mission type in the mission registry (spawn quotas and lifecycle only, no per-tick dispatch).
5. **2e - Capture.**
   - Once spawns and towers are down, use the existing `claim()` and foreign-store loot pipeline.
6. **2f - Defensive posture.**
   - Attacking invites retaliation.
   - Before any live strike, confirm tower, rampart and safe-mode readiness in all four rooms, and check the cross-room defense dispatch item in `todo.md`.

### Gates

- Plan 1 must have freed CPU first, since squads add creeps.
- Andrew approves each target explicitly before anything leaves our borders.

### Kill criteria

- If 2a finds no target where the expected cost is clearly below the gain, do 2b only (a ready nuker is also a deterrent) and stop.

---

## Suggested first three actions

1. Run the 1a profiling window and fill in the cost table above.
2. Probe current power stock and read the engine power constants for 3a.
3. Pick the first claim candidate for room 5 so the target is ready when the CPU gate passes.
