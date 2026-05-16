import { Role } from './Role';
import { harvester } from './harvester';
import { upgrader } from './upgrader';
import { builder } from './builder';
import { repairer } from './repairer';
import { defender } from './defender';
import { rangedDefender } from './rangedDefender';
import { healer } from './healer';
import { miner } from './miner';
import { hauler } from './hauler';
import { mineralMiner } from './mineralMiner';
import { scout } from './scout';
import { remoteHauler } from './remoteHauler';
import { reserver } from './reserver';
import { remoteBuilder } from './remoteBuilder';
import { claimer } from './claimer';
import { colonyBuilder } from './colonyBuilder';
import { hunter } from './hunter';

export type { Role };

export const roles: Record<CreepRoleName, Role> = {
  harvester,
  upgrader,
  builder,
  repairer,
  defender,
  rangedDefender,
  healer,
  miner,
  hauler,
  mineralMiner,
  scout,
  remoteHauler,
  reserver,
  remoteBuilder,
  claimer,
  colonyBuilder,
  hunter,
};
