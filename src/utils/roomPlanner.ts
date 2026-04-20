/**
 * Room planning layer.
 *
 * Scans the room once (on global reset or when data is missing) and caches
 * source IDs, container assignments, and miner assignments into RoomMemory.
 * Other managers read this instead of re-scanning each tick.
 */

/**
 * Ensure Memory.rooms[room.name].sources is populated with the room's source
 * IDs and any container/miner assignments. Call once per tick per room (cheap
 * after the first call — just validates existing data).
 */
export function ensureRoomPlan(room: Room): void {
  const mem = (Memory.rooms[room.name] ??= {});

  // Initialise sources array if missing
  if (!mem.sources) {
    const sources = room.find(FIND_SOURCES);
    mem.sources = sources.map((s) => ({ id: s.id }));
  }

  // Update container assignments for sources
  for (const entry of mem.sources) {
    // If we already have a valid container, skip
    if (entry.containerId) {
      const container = Game.getObjectById(entry.containerId);
      if (container) continue;
      // Container destroyed/decayed — clear assignment
      entry.containerId = undefined;
    }

    // Find a container within 1 tile of this source
    const source = Game.getObjectById(entry.id);
    if (!source) continue;
    const containers = source.pos.findInRange(FIND_STRUCTURES, 1, {
      filter: (s): s is StructureContainer => s.structureType === STRUCTURE_CONTAINER,
    });
    if (containers.length > 0) {
      entry.containerId = containers[0]!.id;
    }
  }

  // Update controller container assignment
  if (room.controller?.my) {
    if (mem.controllerContainerId) {
      const c = Game.getObjectById(mem.controllerContainerId);
      if (!c) mem.controllerContainerId = undefined;
    }
    if (!mem.controllerContainerId) {
      const containers = room.controller.pos.findInRange(FIND_STRUCTURES, 3, {
        filter: (s): s is StructureContainer => s.structureType === STRUCTURE_CONTAINER,
      });
      if (containers.length > 0) {
        mem.controllerContainerId = containers[0]!.id;
      }
    }
  }

  // Determine if we've transitioned to miner economy (at least one source has
  // a container built).
  mem.minerEconomy = mem.sources.some((s) => !!s.containerId);

  // Validate miner assignments (clear dead/reassigned miners)
  for (const entry of mem.sources) {
    if (entry.minerName) {
      const creep = Game.creeps[entry.minerName];
      if (!creep || creep.memory.role !== 'miner') {
        entry.minerName = undefined;
      }
    }
  }
}

/**
 * Find a source that has a container but no assigned miner, for spawning or
 * assigning a new miner.
 */
export function findUnminedSource(roomName: string): Id<Source> | undefined {
  const mem = Memory.rooms[roomName];
  if (!mem?.sources) return undefined;
  for (const entry of mem.sources) {
    if (entry.containerId && !entry.minerName) return entry.id;
  }
  return undefined;
}

/**
 * Assign a miner creep to a source in room memory.
 */
export function assignMiner(roomName: string, sourceId: Id<Source>, creepName: string): void {
  const mem = Memory.rooms[roomName];
  if (!mem?.sources) return;
  const entry = mem.sources.find((s) => s.id === sourceId);
  if (entry) entry.minerName = creepName;
}
