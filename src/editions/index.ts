import type { Handler } from '../main/api/registry';
import { pharmacyModule } from './pharmacy';
import { supermarketModule } from './supermarket';

/**
 * Edition modules.
 *
 * A module owns its tables (see `src/db/schema.ts`) and its IPC channels. The
 * main process only mounts a module's channels when its feature flag is on, so
 * the renderer — even a compromised one — cannot invoke a pharmacy handler on a
 * supermarket licence.
 */
export interface EditionModule {
  id: 'pharmacy' | 'supermarket';
  label: string;
  /** Tables that belong to this module (documented in docs/SCHEMA.md). */
  tables: string[];
  handlers: Handler[];
}

export const EDITION_MODULES: EditionModule[] = [pharmacyModule, supermarketModule];

export function editionHandlers(): Handler[] {
  return EDITION_MODULES.flatMap((module) => module.handlers);
}

export function moduleChannels(): Record<string, string[]> {
  return Object.fromEntries(
    EDITION_MODULES.map((module) => [module.id, module.handlers.map((handler) => handler.channel)])
  );
}

export { pharmacyModule, supermarketModule };
