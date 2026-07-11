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
