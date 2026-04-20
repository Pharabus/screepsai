import { Role } from './Role';
import { harvester } from './harvester';
import { upgrader } from './upgrader';
import { builder } from './builder';
import { repairer } from './repairer';
import { defender } from './defender';

export type { Role };

export const roles: Record<CreepRoleName, Role> = {
  harvester,
  upgrader,
  builder,
  repairer,
  defender,
};
