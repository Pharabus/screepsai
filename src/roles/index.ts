import { Role } from './Role';
import { harvester } from './harvester';
import { upgrader } from './upgrader';
import { builder } from './builder';
import { repairer } from './repairer';
import { defender } from './defender';
import { miner } from './miner';
import { hauler } from './hauler';
import { mineralMiner } from './mineralMiner';
import { scout } from './scout';
import { remoteHauler } from './remoteHauler';
import { reserver } from './reserver';

export type { Role };

export const roles: Record<CreepRoleName, Role> = {
  harvester,
  upgrader,
  builder,
  repairer,
  defender,
  miner,
  hauler,
  mineralMiner,
  scout,
  remoteHauler,
  reserver,
};
