import { getStructuresByType } from './tickCache';

/** NPC hostile owner usernames — sightings of only these get the short rejection window. */
const NPC_USERNAMES = new Set(['Invader', 'Source Keeper']);

// 1000 energy drops survive ~1000t at base decay (1/1000 per tick rounded up),
// long enough for a hauler to be dispatched. Smaller drops are noise — they
// either get cleared by the local hauler before scout returns, or decay before
// a remote dispatch could collect them.
const LOOT_DROP_THRESHOLD = 1000;

function recordLoot(room: Room, rmem: RoomMemory): void {
  const ruinEntries: NonNullable<RoomMemory['scoutedLoot']>['ruins'] = [];
  for (const ruin of room.find(FIND_RUINS)) {
    const total = ruin.store.getUsedCapacity();
    if (!total) continue;
    ruinEntries.push({
      id: ruin.id,
      x: ruin.pos.x,
      y: ruin.pos.y,
      energy: ruin.store.getUsedCapacity(RESOURCE_ENERGY),
      total,
    });
  }

  const tombstoneEntries: NonNullable<RoomMemory['scoutedLoot']>['tombstones'] = [];
  for (const tomb of room.find(FIND_TOMBSTONES)) {
    const total = tomb.store.getUsedCapacity();
    if (!total) continue;
    tombstoneEntries.push({
      id: tomb.id,
      x: tomb.pos.x,
      y: tomb.pos.y,
      energy: tomb.store.getUsedCapacity(RESOURCE_ENERGY),
      total,
    });
  }

  const dropEntries: NonNullable<RoomMemory['scoutedLoot']>['drops'] = [];
  for (const drop of room.find(FIND_DROPPED_RESOURCES)) {
    if (drop.amount < LOOT_DROP_THRESHOLD) continue;
    dropEntries.push({
      id: drop.id,
      x: drop.pos.x,
      y: drop.pos.y,
      resourceType: drop.resourceType,
      amount: drop.amount,
    });
  }

  if (ruinEntries.length === 0 && tombstoneEntries.length === 0 && dropEntries.length === 0) {
    delete rmem.scoutedLoot;
    return;
  }
  rmem.scoutedLoot = {
    recordedAt: Game.time,
    ...(ruinEntries.length ? { ruins: ruinEntries } : {}),
    ...(tombstoneEntries.length ? { tombstones: tombstoneEntries } : {}),
    ...(dropEntries.length ? { drops: dropEntries } : {}),
  };
}

/**
 * Records room intel (sources, controller, mineral, hostiles, keeper lairs,
 * loot) into RoomMemory from a currently-visible Room object. Shared by
 * `scout.ts` (vision from physically standing in the room) and
 * `observer.ts` (vision granted by StructureObserver.observeRoom) — both
 * grant the same kind of full room visibility, so the same `room.find()`
 * calls apply unmodified regardless of source.
 */
export function recordRoomIntel(room: Room): void {
  const rmem = (Memory.rooms[room.name] ??= {});

  const sources = room.find(FIND_SOURCES);
  rmem.scoutedSources = sources.length;
  rmem.scoutedSourceData = sources.map((s) => ({ id: s.id, x: s.pos.x, y: s.pos.y }));
  rmem.scoutedAt = Game.time;
  delete rmem.scoutAttempted;
  delete rmem.scoutUnreachable;

  const controller = room.controller;
  rmem.scoutedHasController = !!controller;
  if (controller) {
    rmem.scoutedOwner = controller.owner?.username;
    rmem.scoutedReservation = controller.reservation?.username;
    rmem.scoutedControllerPos = { x: controller.pos.x, y: controller.pos.y };
  }

  const mineral = room.find(FIND_MINERALS)[0];
  if (mineral) {
    rmem.scoutedMineral = {
      type: mineral.mineralType,
      x: mineral.pos.x,
      y: mineral.pos.y,
    };
  }

  const hostiles = room.find(FIND_HOSTILE_CREEPS);
  rmem.scoutedHostiles = hostiles.length;
  rmem.scoutedHostileIsPlayer = hostiles.some((h) => {
    const u = h.owner?.username;
    return !!u && !NPC_USERNAMES.has(u);
  });

  const keeperLairs = getStructuresByType(room)[STRUCTURE_KEEPER_LAIR] ?? [];
  rmem.scoutedHasKeepers = keeperLairs.length > 0;

  recordLoot(room, rmem);
}

// Power Bank viability thresholds (todo.md "Scan highway rooms for Power
// Banks"): a bank needs enough power to be worth the trip, enough remaining
// life to actually organize a squad around, and room for multiple attackers
// to stand adjacent (a single-attacker approach can't out-damage the bank's
// regen before it decays).
const POWER_BANK_MIN_POWER = 2000;
const POWER_BANK_MIN_DECAY = 3000;
const POWER_BANK_MIN_FREE_TILES = 2;

const EIGHT_NEIGHBOR_OFFSETS: [number, number][] = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

function countFreeAdjacentTiles(room: Room, x: number, y: number): number {
  const terrain = room.getTerrain();
  let count = 0;
  for (const [dx, dy] of EIGHT_NEIGHBOR_OFFSETS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || nx > 49 || ny < 0 || ny > 49) continue;
    if (terrain.get(nx, ny) !== TERRAIN_MASK_WALL) count++;
  }
  return count;
}

/**
 * Records Power Bank and Deposit intel from a currently-visible highway room
 * into RoomMemory. Highway rooms have no controller/sources, so this is
 * intentionally separate from `recordRoomIntel` rather than folded into it —
 * the two scan for entirely different things. Called from `observer.ts` when
 * a queued highway room gains vision.
 */
export function recordHighwayIntel(room: Room): void {
  const rmem = (Memory.rooms[room.name] ??= {});

  const bank = getStructuresByType(room)[STRUCTURE_POWER_BANK]?.[0] as
    | StructurePowerBank
    | undefined;
  const freeAdjacentTiles = bank ? countFreeAdjacentTiles(room, bank.pos.x, bank.pos.y) : 0;
  if (
    bank &&
    bank.power >= POWER_BANK_MIN_POWER &&
    bank.ticksToDecay >= POWER_BANK_MIN_DECAY &&
    freeAdjacentTiles >= POWER_BANK_MIN_FREE_TILES
  ) {
    rmem.scoutedPowerBank = {
      id: bank.id,
      x: bank.pos.x,
      y: bank.pos.y,
      power: bank.power,
      ticksToDecay: bank.ticksToDecay,
      freeAdjacentTiles,
      recordedAtTick: Game.time,
    };
  } else {
    delete rmem.scoutedPowerBank;
  }

  const deposits = room.find(FIND_DEPOSITS);
  if (deposits.length > 0) {
    rmem.scoutedDeposits = deposits.map((d) => ({
      id: d.id,
      x: d.pos.x,
      y: d.pos.y,
      depositType: d.depositType,
      lastCooldown: d.lastCooldown,
      recordedAtTick: Game.time,
    }));
  } else {
    delete rmem.scoutedDeposits;
  }
}
