import { mockRoom, resetGameGlobals } from '../mocks/screeps';
import { resetTickCache } from '../../src/utils/tickCache';
import { runLinks } from '../../src/managers/links';

function makeLink(opts: { energy?: number; free?: number; cooldown?: number } = {}): any {
  const energy = opts.energy ?? 0;
  const capacity = 800;
  const freeCapacity = opts.free ?? capacity - energy;
  return {
    id: `link_${Math.random()}`,
    cooldown: opts.cooldown ?? 0,
    store: {
      getUsedCapacity: (r?: string) => (r === RESOURCE_ENERGY ? energy : 0),
      getFreeCapacity: (r?: string) => (r === RESOURCE_ENERGY ? freeCapacity : 0),
    },
    transferEnergy: vi.fn(() => 0 /* OK */),
  };
}

describe('runLinks', () => {
  beforeEach(() => {
    resetGameGlobals();
    resetTickCache();
  });

  it('does nothing when room has no source links', () => {
    const storageLink = makeLink({ energy: 0, free: 800 });
    const room = mockRoom({ name: 'W1N1' });
    room.controller = { my: true, level: 5 };
    Game.rooms['W1N1'] = room;
    Memory.rooms['W1N1'] = {
      storageLinkId: 'storageLinkId',
      sources: [], // no source link ids
    };
    Game.getObjectById = vi.fn((id: string) => {
      if (id === 'storageLinkId') return storageLink;
      return null;
    });

    runLinks();
    expect(storageLink.transferEnergy).not.toHaveBeenCalled();
  });

  it('transfers from source link to storage link when storage link has free capacity', () => {
    const sourceLink = makeLink({ energy: 800, free: 0 });
    const storageLink = makeLink({ energy: 0, free: 800 });

    const room = mockRoom({ name: 'W1N1' });
    room.controller = { my: true, level: 5 };
    Game.rooms['W1N1'] = room;
    Memory.rooms['W1N1'] = {
      storageLinkId: 'storageLink',
      sources: [{ id: 'src1' as any, x: 10, y: 10, linkId: 'sourceLink' }],
    };
    Game.getObjectById = vi.fn((id: string) => {
      if (id === 'storageLink') return storageLink;
      if (id === 'sourceLink') return sourceLink;
      return null;
    });

    runLinks();
    expect(sourceLink.transferEnergy).toHaveBeenCalledWith(storageLink);
  });

  it('sends energy to controller link when it is running low (< 400)', () => {
    const sourceLink = makeLink({ energy: 800, free: 0 });
    const storageLink = makeLink({ energy: 400, free: 400 });
    const controllerLink = makeLink({ energy: 100, free: 700 }); // low energy

    const room = mockRoom({ name: 'W1N1' });
    room.controller = { my: true, level: 6 };
    Game.rooms['W1N1'] = room;
    Memory.rooms['W1N1'] = {
      storageLinkId: 'storageLink',
      controllerLinkId: 'controllerLink',
      sources: [{ id: 'src1' as any, x: 10, y: 10, linkId: 'sourceLink' }],
    };
    Game.getObjectById = vi.fn((id: string) => {
      if (id === 'storageLink') return storageLink;
      if (id === 'controllerLink') return controllerLink;
      if (id === 'sourceLink') return sourceLink;
      return null;
    });

    runLinks();
    expect(sourceLink.transferEnergy).toHaveBeenCalledWith(controllerLink);
  });

  it('does not send to controller link when controllerFed is already true', () => {
    // Two source links, both want to send to the controller link
    const sourceLink1 = makeLink({ energy: 800, free: 0 });
    const sourceLink2 = makeLink({ energy: 800, free: 0 });
    const storageLink = makeLink({ energy: 0, free: 800 });
    const controllerLink = makeLink({ energy: 100, free: 700 }); // low

    const room = mockRoom({ name: 'W1N1' });
    room.controller = { my: true, level: 6 };
    Game.rooms['W1N1'] = room;
    Memory.rooms['W1N1'] = {
      storageLinkId: 'storageLink',
      controllerLinkId: 'controllerLink',
      sources: [
        { id: 'src1' as any, x: 10, y: 10, linkId: 'sourceLink1' },
        { id: 'src2' as any, x: 20, y: 10, linkId: 'sourceLink2' },
      ],
    };
    Game.getObjectById = vi.fn((id: string) => {
      if (id === 'storageLink') return storageLink;
      if (id === 'controllerLink') return controllerLink;
      if (id === 'sourceLink1') return sourceLink1;
      if (id === 'sourceLink2') return sourceLink2;
      return null;
    });

    runLinks();

    // Controller link should only receive energy once
    const controllerTransfers = [sourceLink1, sourceLink2].filter((sl) =>
      sl.transferEnergy.mock.calls.some((args: any[]) => args[0] === controllerLink),
    );
    expect(controllerTransfers.length).toBe(1);
  });

  it('skips source links on cooldown', () => {
    const sourceLink = makeLink({ energy: 800, free: 0, cooldown: 5 });
    const storageLink = makeLink({ energy: 0, free: 800 });

    const room = mockRoom({ name: 'W1N1' });
    room.controller = { my: true, level: 5 };
    Game.rooms['W1N1'] = room;
    Memory.rooms['W1N1'] = {
      storageLinkId: 'storageLink',
      sources: [{ id: 'src1' as any, x: 10, y: 10, linkId: 'sourceLink' }],
    };
    Game.getObjectById = vi.fn((id: string) => {
      if (id === 'storageLink') return storageLink;
      if (id === 'sourceLink') return sourceLink;
      return null;
    });

    runLinks();
    expect(sourceLink.transferEnergy).not.toHaveBeenCalled();
  });

  it('skips source links with no energy', () => {
    const sourceLink = makeLink({ energy: 0, free: 800 });
    const storageLink = makeLink({ energy: 0, free: 800 });

    const room = mockRoom({ name: 'W1N1' });
    room.controller = { my: true, level: 5 };
    Game.rooms['W1N1'] = room;
    Memory.rooms['W1N1'] = {
      storageLinkId: 'storageLink',
      sources: [{ id: 'src1' as any, x: 10, y: 10, linkId: 'sourceLink' }],
    };
    Game.getObjectById = vi.fn((id: string) => {
      if (id === 'storageLink') return storageLink;
      if (id === 'sourceLink') return sourceLink;
      return null;
    });

    runLinks();
    expect(sourceLink.transferEnergy).not.toHaveBeenCalled();
  });

  it('falls back to controller link when storage link is full', () => {
    const sourceLink = makeLink({ energy: 800, free: 0 });
    const storageLink = makeLink({ energy: 800, free: 0 }); // full
    const controllerLink = makeLink({ energy: 700, free: 100 }); // has free capacity, energy >= 400

    const room = mockRoom({ name: 'W1N1' });
    room.controller = { my: true, level: 6 };
    Game.rooms['W1N1'] = room;
    Memory.rooms['W1N1'] = {
      storageLinkId: 'storageLink',
      controllerLinkId: 'controllerLink',
      sources: [{ id: 'src1' as any, x: 10, y: 10, linkId: 'sourceLink' }],
    };
    Game.getObjectById = vi.fn((id: string) => {
      if (id === 'storageLink') return storageLink;
      if (id === 'controllerLink') return controllerLink;
      if (id === 'sourceLink') return sourceLink;
      return null;
    });

    runLinks();
    // Storage link is full, so it should overflow to controller link
    expect(sourceLink.transferEnergy).toHaveBeenCalledWith(controllerLink);
  });
});
