---
name: HealthCheck
description: Run a full live health review of the Screeps bot on shard3 — CPU/bucket, per-room economy (storage/terminal energy + minerals), lab progression, terminal transfers, and market activity — then render a readable report. Use when the user asks to "health check", "check the bot", "how's the colony", "status of the empire", or at the start of a session to get a snapshot of live state.
---

# HealthCheck

Produces a one-shot snapshot of the live bot on **shard3** by running a few compact
console expressions through the `screeps-mcp` MCP server, then rendering the results as a
readable report. No bot deploy is needed — all gathering happens via console reads, and all
formatting lives here in the skill.

## What it reports

- **CPU & bucket** — limit, tickLimit, bucket (the key stability signal under the shard3 20-CPU cap), and the main-loop CPU EMA.
- **GCL & credits.**
- **Per owned room** — RCL + controller %, safe mode, spawn-energy fill, storage energy + minerals, terminal energy + minerals, labs (mineral + amount), active reaction, boost-lab reservation.
- **Terminal transfers** — recent intra-empire sends (confirms feeder→hub mineral routing works).
- **Market** — recent sells/buys (confirms selling surplus + buying lab inputs works) and order count.
- **Boosts** — `boostStatus()` per-room success/failure counters.

## How to run it

### Step 1 — fire all probes in one tick

Call `mcp__screeps-mcp__execute_command` **once per command below**, all with `shard: "shard3"`.
Fire them back-to-back (they all land on the same tick). Results are NOT returned by
`execute_command` — they appear on the **next** tick via `get_console`.

**Probe A — rooms** (storage/terminal/labs per owned room):

```js
JSON.stringify({hc:'rooms',r:Object.values(Game.rooms).filter(r=>r.controller&&r.controller.my).map(r=>{var s=r.storage,t=r.terminal,m=Memory.rooms[r.name]||{};var f=o=>{var x={};if(o)for(var k in o.store)if(k!='energy'&&o.store[k]>0)x[k]=o.store[k];return x;};return{n:r.name,rcl:r.controller.level,cp:+(100*r.controller.progress/(r.controller.progressTotal||1)).toFixed(1),sm:r.controller.safeMode||0,se:r.energyAvailable+'/'+r.energyCapacityAvailable,stE:s?s.store.energy:null,stM:f(s),tE:t?t.store.energy:null,tM:f(t),lab:r.find(FIND_MY_STRUCTURES).filter(x=>x.structureType=='lab').map(l=>(l.mineralType||'-')+':'+(l.mineralType?l.store[l.mineralType]:0)),bl:m.boostLabId?(m.boostCompound||'?'):null,rx:m.activeReaction?m.activeReaction.output:null};})})
```

**Probe B — system + market** (CPU/bucket/GCL/credits + recent transactions):

```js
JSON.stringify({hc:'sys',t:Game.time,b:Game.cpu.bucket,lim:Game.cpu.limit,tl:Game.cpu.tickLimit,gcl:Game.gcl.level,gp:+(100*Game.gcl.progress/Game.gcl.progressTotal).toFixed(1),cr:Math.round(Game.market.credits),ord:Object.keys(Game.market.orders||{}).length,loop:Memory.stats&&Memory.stats['main.loop']?+Memory.stats['main.loop'].avg.toFixed(2):null,sells:(Game.market.outgoingTransactions||[]).filter(x=>x.order).slice(0,5).map(x=>x.amount+x.resourceType+'@'+x.order.price.toFixed(2)),buys:(Game.market.incomingTransactions||[]).filter(x=>x.order).slice(0,5).map(x=>x.amount+x.resourceType+'@'+x.order.price.toFixed(2)),tr:(Game.market.incomingTransactions||[]).filter(x=>!x.order).slice(0,5).map(x=>x.amount+x.resourceType+' '+x.from+'>'+x.to)})
```

**Probe C — boosts** (the always-on diagnostic command):

```js
boostStatus()
```

> Optional deeper probes if the user wants more: `status()` (economy/links/perimeter per room),
> `colonies()` (priority scores + claim lifecycle), `combatLog()` (recent combat), `transports()`
> (active manual transport missions). Same fire-then-read-next-tick pattern.

### Step 2 — read results on the next tick

Call `mcp__screeps-mcp__get_console` with `shard: "shard3"`. Read the **`results`** array
(ignore the noisy `logs` array — that's spawn/terminal chatter).

**Gotcha: `results` is a rolling buffer that retains stale entries from earlier commands.**
Do not assume position. Parse each entry as JSON and pick the **last** one matching each shape:

- Probe A → object with `hc:"rooms"` (use its `.r` array).
- Probe B → object with `hc:"sys"`.
- Probe C → a plain string: either `"no boost activity recorded"` or per-room `ok=/timeout=/...` lines.

If a probe's result isn't present yet (ticks are ~4s; the read may beat the write), call
`get_console` again after a moment. Take the most recent matching entry each time.

### Step 3 — render the report

Format the parsed data as below. Convert relative things to plain language and **flag anomalies**.

```
🏥 Screeps Health — shard3 @ tick <t>

CPU      bucket <b>/10000 <flag>   loop <loop>ms / <lim> limit (tickLimit <tl>)
Empire   GCL <gcl> (<gp>%)   credits <cr>

Rooms
  <name>  RCL<rcl> (<cp>%)<safemode>   spawn <se>
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
  <boostStatus output>
```

## Interpretation guide (flag these)

- **Bucket** — `< 3000` = ⚠ low, `< 1000` = ⚠ CRITICAL (the bot self-throttles here). ~5000–10000 is healthy. `loop` near the CPU `lim` (e.g. >17 of 20) means little headroom.
- **`loop` is `null`** → `Memory.profiling` is off and the EMA is stale/absent; report bucket as the live CPU signal and note profiling is off.
- **Storage energy** — `stE: null` means the room has no own storage yet (early RCL or a reclaimed husk); fine for RCL<4. A mature room (RCL6+) sitting very low on storage energy is worth flagging.
- **Terminal transfers working** — expect recent `tr` entries (e.g. `Z W42N59>W43N58`, `O W44N57>W43N58`). **Empty `tr` is the signal terminal transfer may be broken** — flag it.
- **Lab progression working** — the lab hub (most labs; currently W43N58) should show an active reaction (`rx`) with its input labs loaded (e.g. `H:…`, `G:…`) and product accumulating. Feeder rooms (W42N59, W44N57) normally show empty/idle labs — that's expected. A feeder lab pinned with a stale mineral (e.g. `Z:1302`) is a known drain-lag case, not a fault, unless it persists.
- **Market working** — expect non-empty `sells` (surplus minerals like Z/O) and `buys` (lab inputs like U/L). `credits` should be healthy (hundreds of thousands+). Empty sells AND buys with high surplus = flag.
- **Safe mode** — any non-zero `sm` means safe mode is active in that room — surface it prominently.
- **Boosts** — `boostStatus()` showing a room flagged `⚠ FAILING` (failures > successes) means chronic boost starvation there. `"no boost activity recorded"` just means counters are fresh/cleared — not a fault.

Keep the report tight and lead with anything flagged. If everything is nominal, say so in one line at the top before the detail.
