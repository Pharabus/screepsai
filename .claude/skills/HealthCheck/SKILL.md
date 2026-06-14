---
name: HealthCheck
description: Run a full live health review of the Screeps bot on shard3 — CPU/bucket, per-room economy (storage/terminal energy + minerals), lab progression, terminal transfers, and market activity — then render a readable report. Use when the user asks to "health check", "check the bot", "how's the colony", "status of the empire", or at the start of a session to get a snapshot of live state.
---

# HealthCheck

Produces a one-shot snapshot of the live bot on **shard3** by reading the bot's own
pre-computed health snapshot (`Memory._health`) over the Screeps HTTP API, then rendering
it as a readable report. **All filtering happens in-game** (the bot writes the compact
snapshot every few ticks via `writeHealthSnapshot`), so a single Memory-path read returns
everything — no console buffer, no MCP payload, minimal context.

> **Why not the MCP server?** The `screeps-mcp` read tools dump large raw payloads (console
> buffers full of spawn/terminal log chatter) into the agent context. The HTTP path here
> reads one scoped, already-filtered object. The MCP server is still available as a fallback
> (see below).

## What it reports

- **CPU & bucket** — limit, tickLimit, bucket (the key stability signal under the shard3 20-CPU cap), and the main-loop CPU EMA.
- **GCL & credits.**
- **Per owned room** — RCL + controller %, safe mode, spawn-energy fill, storage energy + minerals, terminal energy + minerals, labs (mineral + amount), active reaction, boost-lab reservation.
- **Terminal transfers** — recent intra-empire sends (confirms feeder→hub mineral routing works).
- **Market** — recent sells/buys (confirms selling surplus + buying lab inputs works) and order count.
- **Boosts** — `boostStatus()` per-room success/failure counters.

## How to run it

### Step 1 — read the snapshot (one call)

```bash
node scripts/screeps-query.mjs mem _health
```

This prints the snapshot as JSON. Auth (`SCREEPS_TOKEN`) is read from the gitignored `.env`
by the script — never passed on the command line. Run it from the repo root.

**The snapshot is refreshed every `HEALTH_SNAPSHOT_INTERVAL` ticks (10, ≈40s)**, so `t` may
lag the current tick by up to that much — fine for a health check. Read `t` and report it as
the snapshot tick.

**If it errors with `memory path "_health" is empty/undefined`:** the running bot predates the
snapshot feature (v1.0.269) or just did a global reset and hasn't hit a snapshot tick yet.
Either wait one cycle and retry, or use the **fallback** below.

### Step 2 — render the report

The JSON shape (terse field names map directly to the report):

- top: `t` (snapshot tick), `boost` (boostStatus string)
- `sys`: `b` bucket, `lim` cpu limit, `tl` tickLimit, `gcl`, `gp` gcl %, `cr` credits,
  `ord` market order count, `loop` main-loop EMA ms (or null), `sells[]`, `buys[]`,
  `tr[]` (intra-empire transfers)
- `rooms[]`: `n` name, `rcl`, `cp` controller %, `sm` safe-mode ticks, `se` spawn "avail/cap",
  `stE`/`stM` storage energy/minerals, `tE`/`tM` terminal energy/minerals, `lab[]`
  ("mineral:amount" per lab), `bl` boost-lab compound, `rx` active reaction output

Format it as below. Convert terse values to plain language and **flag anomalies**.

```
🏥 Screeps Health — shard3 @ tick <t>

CPU      bucket <b>/10000 <flag>   loop <loop>ms / <lim> limit (tickLimit <tl>)
Empire   GCL <gcl> (<gp>%)   credits <cr>

Rooms
  <n>  RCL<rcl> (<cp>%)<safemode>   spawn <se>
          storage  E <stE>   min <stM or "—">
          terminal E <tE>    min <tM or "—">
          labs <lab>   reaction <rx or "—">   boostLab <bl or "—">
  ... (one block per room)

Terminal transfers (feeder→hub)
  <tr lines, or "none recent ⚠">

Market
  orders <ord>
  sells  <sells, or "none recent ⚠">
  buys   <buys, or "none recent ⚠">

Boosts
  <boost>
```

## Deeper / ad-hoc inspection

- **Any Memory subtree:** `node scripts/screeps-query.mjs mem <path>` (dot path, e.g.
  `mem boostStats`, `mem missions.colony`, `mem rooms.W43N58`). One scoped GET, gzip-decoded.
- **Live `Game.*` data not in Memory** (small queries only — the console caps expression size
  at ~1KB): write a single-expression file and run
  `node scripts/screeps-query.mjs probe <file.js>`. It captures the expression's return value
  into `Memory._probe`, polls until fresh, and prints it. Note: the console command queue has
  variable latency (~12–60s), so prefer `mem` for anything that lives in Memory.
- **Larger console reports** (`status()`, `colonies()`, `combatLog()`, `transports()`) are
  best run through the MCP server (below) — they exceed the probe size limit.

## Fallback — MCP server

If the script path is unavailable (no `.env`, snapshot empty on a fresh reset, or a report
that exceeds the probe size limit), gather the same data through `screeps-mcp`:

1. Fire each probe with `mcp__screeps-mcp__execute_command` (all `shard: "shard3"`), back-to-back.
2. Read results next tick with `mcp__screeps-mcp__get_console` (`shard: "shard3"`). Parse the
   **`results`** array (ignore the noisy `logs` array); it's a rolling buffer, so take the
   **last** entry matching each shape.

**Probe A — rooms:**

```js
JSON.stringify({hc:'rooms',r:Object.values(Game.rooms).filter(r=>r.controller&&r.controller.my).map(r=>{var s=r.storage,t=r.terminal,m=Memory.rooms[r.name]||{};var f=o=>{var x={};if(o)for(var k in o.store)if(k!='energy'&&o.store[k]>0)x[k]=o.store[k];return x;};return{n:r.name,rcl:r.controller.level,cp:+(100*r.controller.progress/(r.controller.progressTotal||1)).toFixed(1),sm:r.controller.safeMode||0,se:r.energyAvailable+'/'+r.energyCapacityAvailable,stE:s?s.store.energy:null,stM:f(s),tE:t?t.store.energy:null,tM:f(t),lab:r.find(FIND_MY_STRUCTURES).filter(x=>x.structureType=='lab').map(l=>(l.mineralType||'-')+':'+(l.mineralType?l.store[l.mineralType]:0)),bl:m.boostLabId?(m.boostCompound||'?'):null,rx:m.activeReaction?m.activeReaction.output:null};})})
```

**Probe B — system + market:**

```js
JSON.stringify({hc:'sys',t:Game.time,b:Game.cpu.bucket,lim:Game.cpu.limit,tl:Game.cpu.tickLimit,gcl:Game.gcl.level,gp:+(100*Game.gcl.progress/Game.gcl.progressTotal).toFixed(1),cr:Math.round(Game.market.credits),ord:Object.keys(Game.market.orders||{}).length,loop:Memory.stats&&Memory.stats['main.loop']?+Memory.stats['main.loop'].avg.toFixed(2):null,sells:(Game.market.outgoingTransactions||[]).filter(x=>x.order).slice(0,5).map(x=>x.amount+x.resourceType+'@'+x.order.price.toFixed(2)),buys:(Game.market.incomingTransactions||[]).filter(x=>x.order).slice(0,5).map(x=>x.amount+x.resourceType+'@'+x.order.price.toFixed(2)),tr:(Game.market.incomingTransactions||[]).filter(x=>!x.order).slice(0,5).map(x=>x.amount+x.resourceType+' '+x.from+'>'+x.to)})
```

**Probe C — boosts:** `boostStatus()`

## Interpretation guide (flag these)

- **Bucket** — `< 3000` = ⚠ low, `< 1000` = ⚠ CRITICAL (the bot self-throttles here). ~5000–10000 is healthy. `loop` near the CPU `lim` (e.g. >17 of 20) means little headroom.
- **`loop` is `null`** → `Memory.profiling` is off and the EMA is stale/absent; report bucket as the live CPU signal and note profiling is off.
- **Storage energy** — `stE: null` means the room has no own storage yet (early RCL or a reclaimed husk); fine for RCL<4. A mature room (RCL6+) sitting very low on storage energy is worth flagging.
- **Terminal transfers working** — expect recent `tr` entries (e.g. `Z W42N59>W43N58`, `O W44N57>W43N58`). **Empty `tr` is the signal terminal transfer may be broken** — flag it.
- **Lab progression working** — the lab hub (most labs; currently W43N58) should show an active reaction (`rx`) with its input labs loaded (e.g. `H:…`, `G:…`) and product accumulating. Feeder rooms (W42N59, W44N57) normally show empty/idle labs — that's expected. A feeder lab pinned with a stale mineral (e.g. `Z:1302`) is a known drain-lag case, not a fault, unless it persists.
- **Market working** — expect non-empty `sells` (surplus minerals like Z/O) and `buys` (lab inputs like U/L). `credits` should be healthy (hundreds of thousands+). Empty sells AND buys with high surplus = flag.
- **Safe mode** — any non-zero `sm` means safe mode is active in that room — surface it prominently.
- **Boosts** — `boost` showing a room flagged `⚠ FAILING` (failures > successes) means chronic boost starvation there. `"no boost activity recorded"` just means counters are fresh/cleared — not a fault.

Keep the report tight and lead with anything flagged. If everything is nominal, say so in one line at the top before the detail.
