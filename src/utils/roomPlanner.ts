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

  // Initialise sources array if missing or outdated (no position data)
  if (!mem.sources || (mem.sources.length > 0 && mem.sources[0]!.x === undefined)) {
    const sources = room.find(FIND_SOURCES);
    mem.sources = sources.map((s) => ({ id: s.id, x: s.pos.x, y: s.pos.y }));
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

  // Update link assignments for sources
  for (const entry of mem.sources) {
    if (entry.linkId) {
      const link = Game.getObjectById(entry.linkId);
      if (!link) entry.linkId = undefined;
    }
    if (!entry.linkId) {
      const source = Game.getObjectById(entry.id);
      if (source) {
        const links = source.pos.findInRange(FIND_MY_STRUCTURES, 2, {
          filter: (s): s is StructureLink => s.structureType === STRUCTURE_LINK,
        });
        if (links.length > 0) entry.linkId = links[0]!.id;
      }
    }
  }

  // Update storage link
  if (room.storage) {
    if (mem.storageLinkId) {
      const link = Game.getObjectById(mem.storageLinkId);
      if (!link) mem.storageLinkId = undefined;
    }
    if (!mem.storageLinkId) {
      const links = room.storage.pos.findInRange(FIND_MY_STRUCTURES, 2, {
        filter: (s): s is StructureLink => s.structureType === STRUCTURE_LINK,
      });
      // Exclude links already assigned to sources
      const sourceLinks = new Set(mem.sources.map((s) => s.linkId).filter(Boolean));
      const storageLink = links.find((l) => !sourceLinks.has(l.id));
      if (storageLink) mem.storageLinkId = storageLink.id;
    }
  }

  // Update controller link
  if (room.controller?.my) {
    if (mem.controllerLinkId) {
      const link = Game.getObjectById(mem.controllerLinkId);
      if (!link) mem.controllerLinkId = undefined;
    }
    if (!mem.controllerLinkId) {
      const links = room.controller.pos.findInRange(FIND_MY_STRUCTURES, 3, {
        filter: (s): s is StructureLink => s.structureType === STRUCTURE_LINK,
      });
      const sourceLinks = new Set(mem.sources.map((s) => s.linkId).filter(Boolean));
      const ctrlLink = links.find((l) => !sourceLinks.has(l.id) && l.id !== mem.storageLinkId);
      if (ctrlLink) mem.controllerLinkId = ctrlLink.id;
    }
  }

  // Mineral tracking (RCL 6+)
  if (!mem.mineralId) {
    const minerals = room.find(FIND_MINERALS);
    if (minerals.length > 0) mem.mineralId = minerals[0]!.id;
  }
  if (mem.mineralId) {
    if (mem.mineralContainerId) {
      const c = Game.getObjectById(mem.mineralContainerId);
      if (!c) mem.mineralContainerId = undefined;
    }
    if (!mem.mineralContainerId) {
      const mineral = Game.getObjectById(mem.mineralId);
      if (mineral) {
        const containers = mineral.pos.findInRange(FIND_STRUCTURES, 1, {
          filter: (s): s is StructureContainer => s.structureType === STRUCTURE_CONTAINER,
        });
        if (containers.length > 0) mem.mineralContainerId = containers[0]!.id;
      }
    }
    if (mem.mineralMinerName) {
      const creep = Game.creeps[mem.mineralMinerName];
      if (!creep || creep.memory.role !== 'mineralMiner') {
        mem.mineralMinerName = undefined;
      }
    }
  }

  // Lab tracking (RCL 6+)
  if ((room.controller?.level ?? 0) >= 6) {
    const knownLabs = mem.labIds ?? [];
    // Validate existing IDs
    const validLabs = knownLabs.filter((id) => !!Game.getObjectById(id));
    // Discover new labs
    const allLabs = room.find(FIND_MY_STRUCTURES, {
      filter: (s): s is StructureLab => s.structureType === STRUCTURE_LAB,
    });
    const knownSet = new Set(validLabs);
    for (const lab of allLabs) {
      if (!knownSet.has(lab.id)) validLabs.push(lab.id);
    }
    mem.labIds = validLabs.length > 0 ? validLabs : undefined;

    // Designate first two labs as input labs (stable once assigned)
    if (mem.labIds && mem.labIds.length >= 2) {
      if (
        !mem.inputLabIds ||
        !Game.getObjectById(mem.inputLabIds[0]) ||
        !Game.getObjectById(mem.inputLabIds[1])
      ) {
        mem.inputLabIds = [mem.labIds[0]!, mem.labIds[1]!];
      }
    } else {
      mem.inputLabIds = undefined;
    }
  }

  // Determine if we've transitioned to miner economy (at least one source has
  // a container built).
  mem.minerEconomy = mem.sources.some((s) => !!s.containerId);

  // Validate miner assignments (clear dead/reassigned miners, restore orphaned ones)
  for (const entry of mem.sources) {
    if (entry.minerName) {
      const creep = Game.creeps[entry.minerName];
      if (!creep || creep.memory.role !== 'miner') {
        entry.minerName = undefined;
      }
    }
    if (!entry.minerName) {
      for (const creep of Object.values(Game.creeps)) {
        if (creep.memory.role === 'miner' && creep.memory.targetId === entry.id) {
          entry.minerName = creep.name;
          break;
        }
      }
    }
  }
}

/**
 * Scan sources in a remote (unowned) room and populate Memory.rooms[roomName].sources.
 * Only tracks source IDs — no containers, links, or controller tracking.
 */
export function ensureRemoteRoomPlan(roomName: string): void {
  const mem = (Memory.rooms[roomName] ??= {});
  const room = Game.rooms[roomName];

  if (room && (!mem.sources || (mem.sources.length > 0 && mem.sources[0]!.x === undefined))) {
    const sources = room.find(FIND_SOURCES);
    mem.sources = sources.map((s) => ({ id: s.id, x: s.pos.x, y: s.pos.y }));
  }

  // Bootstrap sources from scout data when we don't have visibility yet
  if (!mem.sources && mem.scoutedSourceData) {
    mem.sources = mem.scoutedSourceData.map((s) => ({ id: s.id, x: s.x, y: s.y }));
  }

  if (!mem.sources) return;

  if (room) {
    // Update container assignments for remote sources (requires visibility)
    for (const entry of mem.sources) {
      if (entry.containerId) {
        const container = Game.getObjectById(entry.containerId);
        if (container) continue;
        entry.containerId = undefined;
      }
      const source = Game.getObjectById(entry.id);
      if (!source) continue;
      const containers = source.pos.findInRange(FIND_STRUCTURES, 1, {
        filter: (s): s is StructureContainer => s.structureType === STRUCTURE_CONTAINER,
      });
      if (containers.length > 0) {
        entry.containerId = containers[0]!.id;
      }
    }
  }

  // Validate miner assignments (works without visibility — just checks Game.creeps)
  for (const entry of mem.sources) {
    if (entry.minerName) {
      const creep = Game.creeps[entry.minerName];
      if (!creep || creep.memory.role !== 'miner') {
        entry.minerName = undefined;
      }
    }
    if (!entry.minerName) {
      for (const creep of Object.values(Game.creeps)) {
        if (creep.memory.role === 'miner' && creep.memory.targetId === entry.id) {
          entry.minerName = creep.name;
          break;
        }
      }
    }
  }
}

/**
 * Find a source that has a container but no assigned miner, for spawning or
 * assigning a new miner. For remote rooms (no containers), any unassigned
 * source qualifies.
 */
export function findUnminedSource(roomName: string): Id<Source> | undefined {
  const mem = Memory.rooms[roomName];
  if (!mem?.sources) return undefined;
  for (const entry of mem.sources) {
    if (!entry.minerName && (entry.containerId || isRemoteRoom(roomName))) return entry.id;
  }
  return undefined;
}

function isRemoteRoom(roomName: string): boolean {
  for (const homeRoomName of Object.keys(Memory.rooms)) {
    const homeMem = Memory.rooms[homeRoomName];
    if (homeMem?.remoteRooms?.includes(roomName)) return true;
  }
  return false;
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

/**
 * Check if a room needs a mineral miner and doesn't have one assigned.
 */
export function needsMineralMiner(roomName: string): boolean {
  const mem = Memory.rooms[roomName];
  if (!mem?.mineralId || !mem.mineralContainerId) return false;
  if (mem.mineralMinerName && Game.creeps[mem.mineralMinerName]) return false;
  const mineral = Game.getObjectById(mem.mineralId);
  if (!mineral || mineral.mineralAmount === 0) return false;
  return true;
}

/**
 * Assign a mineral miner creep in room memory.
 */
export function assignMineralMiner(roomName: string, creepName: string): void {
  const mem = Memory.rooms[roomName];
  if (mem) mem.mineralMinerName = creepName;
}
