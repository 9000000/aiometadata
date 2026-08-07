import { allCatalogDefinitions } from '@/data/catalogs';
import type { CatalogConfig } from '@/contexts/config';
import type { CatalogBlueprint } from '@shared/catalogReconstruction';

import { SUFFIX_TYPES } from '@shared/types';

export { SUFFIX_TYPES };

/**
 * Catalogs tied to whoever is signed in rather than to whoever built the file.
 * They never travel as blueprints, since that would carry one person's list
 * settings to another, but their ids say exactly what they are: "my watchlist",
 * not the author's. So they can be recreated from the id, given the account.
 *
 * Shapes mirror what the integration dialogs create.
 */
interface PersonalCatalog {
  type: CatalogConfig['type'];
  name: string;
  source: CatalogConfig['source'];
  cacheTTL?: number;
  metadata?: CatalogConfig['metadata'];
}

const TRAKT_PERSONAL: Record<string, PersonalCatalog> = {
  'trakt.watchlist': { type: 'all', name: 'Trakt Watchlist', source: 'trakt' },
  'trakt.watchlist.movies': { type: 'movie', name: 'Trakt Watchlist', source: 'trakt' },
  'trakt.watchlist.series': { type: 'series', name: 'Trakt Watchlist', source: 'trakt' },
  'trakt.favorites.movies': { type: 'movie', name: 'Trakt Favorites', source: 'trakt' },
  'trakt.favorites.shows': { type: 'series', name: 'Trakt Favorites', source: 'trakt' },
  'trakt.recommendations.movies': { type: 'movie', name: 'Trakt Recommendations', source: 'trakt' },
  'trakt.recommendations.shows': { type: 'series', name: 'Trakt Recommendations', source: 'trakt' },
  'trakt.upnext': { type: 'series', name: 'Trakt Up Next', source: 'trakt', cacheTTL: 300 },
  'trakt.unwatched': { type: 'series', name: 'My Recently Aired', source: 'trakt', cacheTTL: 300 },
  'trakt.calendar': { type: 'series', name: 'Airing Soon', source: 'trakt', cacheTTL: 300 },
};

const SIMKL_STATUS_NAMES: Record<string, string> = {
  watching: 'Watching',
  plantowatch: 'Plan to Watch',
  hold: 'On Hold',
  completed: 'Completed',
  dropped: 'Dropped',
};

const SIMKL_TYPES: Record<string, CatalogConfig['type']> = {
  movies: 'movie',
  shows: 'series',
  anime: 'anime',
};

function simklPersonal(catalogId: string): PersonalCatalog | undefined {
  const match = /^simkl\.watchlist\.(movies|shows|anime)\.([a-z]+)$/.exec(catalogId);
  if (!match) return undefined;

  const [, listType, status] = match;
  const statusName = SIMKL_STATUS_NAMES[status];
  if (!statusName) return undefined;

  return {
    type: SIMKL_TYPES[listType],
    name: `Simkl ${statusName} ${listType.charAt(0).toUpperCase()}${listType.slice(1)}`,
    source: 'simkl',
    metadata: { status: status as any },
  };
}

/** The credential each account-scoped catalog needs before it can return anything. */
const ACCOUNTS: Array<{
  prefix: string;
  label: string;
  key: 'traktTokenId' | 'simklTokenId';
  lookup: (catalogId: string) => PersonalCatalog | undefined;
}> = [
  { prefix: 'trakt.', label: 'Trakt', key: 'traktTokenId', lookup: id => TRAKT_PERSONAL[id] },
  { prefix: 'simkl.', label: 'Simkl', key: 'simklTokenId', lookup: simklPersonal },
];

function findPersonal(catalogId: string) {
  for (const account of ACCOUNTS) {
    if (!catalogId.startsWith(account.prefix)) continue;
    const catalog = account.lookup(catalogId);
    if (catalog) return { account, catalog };
  }
  return undefined;
}

/**
 * A manifest id can carry the original type as a suffix, so a source pointing at
 * `tmdb.top_movie` still has to resolve back to the `tmdb.top` definition.
 */
function findDefinition(catalogId: string, type: string) {
  const direct = allCatalogDefinitions.find(def => def.id === catalogId && def.type === type);
  if (direct) return direct;

  for (const suffix of SUFFIX_TYPES) {
    if (!catalogId.endsWith(`_${suffix}`)) continue;
    const base = catalogId.slice(0, -(suffix.length + 1));
    const match = allCatalogDefinitions.find(def => def.id === base && def.type === suffix);
    if (match) return match;
  }
  return undefined;
}

export interface CatalogAdditions {
  /** Catalogs to append, already deduped against the config. */
  added: CatalogConfig[];
  /** Keys of catalogs the config already has but has switched off. */
  enabled: string[];
  /** `catalogId:type` of every imported source these additions account for. */
  resolved: Set<string>;
  /** Services whose own catalogs the file uses, but which are not connected. */
  needsAccount: string[];
  /**
   * The subset of `resolved` an apply will not actually add, because the account
   * it belongs to is not connected. Accounted for, but not staged.
   */
  needsAccountKeys: Set<string>;
}

export function additionCount(additions: CatalogAdditions): number {
  return additions.added.length + additions.enabled.length;
}

/**
 * Works out what a config is missing for an imported layout: catalogs the file
 * carries a blueprint for, and built-in catalogs the user simply has turned off.
 */
export function resolveCatalogAdditions(
  existing: CatalogConfig[],
  blueprints: CatalogBlueprint[],
  unknownSources: Array<{ catalogId: string; type: string }>,
  apiKeys: Record<string, any> = {}
): CatalogAdditions {
  const byKey = new Map(existing.map(catalog => [`${catalog.id}:${catalog.type}`, catalog]));

  const added: CatalogConfig[] = [];
  const enabled: string[] = [];
  const claimed = new Set<string>();
  const resolved = new Set<string>();

  // Only what the design in front of the user still points at. A file can carry
  // far more than is kept, and deleting a tile has to take its catalog with it.
  const wanted = new Set(unknownSources.map(source => source.catalogId));
  const usable = blueprints.filter(blueprint => wanted.has(blueprint.id));
  const blueprintIds = new Set(usable.map(blueprint => blueprint.id));

  for (const blueprint of usable) {
    const key = `${blueprint.id}:${blueprint.type}`;
    if (claimed.has(key)) continue;
    claimed.add(key);

    const match = byKey.get(key);
    if (!match) {
      added.push({ ...blueprint } as CatalogConfig);
      continue;
    }
    if (!match.enabled) enabled.push(key);
  }

  const needsAccount = new Set<string>();
  const needsAccountKeys = new Set<string>();

  const take = (key: string): boolean => {
    if (claimed.has(key)) return false;
    claimed.add(key);
    const match = byKey.get(key);
    if (!match) return true;
    if (!match.enabled) enabled.push(key);
    return false;
  };

  for (const source of unknownSources) {
    // A displayType renames the type in the manifest but not in the config, so a
    // source is matched to its blueprint on the id alone.
    if (blueprintIds.has(source.catalogId)) {
      resolved.add(`${source.catalogId}:${source.type}`);
      continue;
    }

    const personal = findPersonal(source.catalogId);
    if (personal) {
      // Reported either way: unconnected ones are explained by needsAccount, so
      // they must not also surface as catalogs nothing knows how to rebuild.
      // They are still not being added, which needsAccountKeys keeps sayable.
      const key = `${source.catalogId}:${source.type}`;
      resolved.add(key);
      if (!String(apiKeys?.[personal.account.key] || '').trim()) {
        needsAccount.add(personal.account.label);
        needsAccountKeys.add(key);
        continue;
      }
      if (take(`${source.catalogId}:${personal.catalog.type}`)) {
        added.push({
          id: source.catalogId,
          enabled: true,
          showInHome: true,
          ...personal.catalog,
        });
      }
      continue;
    }

    // Files written by another app carry no blueprints, but a built-in catalog is
    // defined the same everywhere, so it can still be resolved from its id.
    const definition = findDefinition(source.catalogId, source.type);
    if (!definition) continue;
    resolved.add(`${source.catalogId}:${source.type}`);

    if (take(`${definition.id}:${definition.type}`)) {
      added.push({
        id: definition.id,
        type: definition.type,
        name: definition.name,
        source: definition.source,
        enabled: true,
        showInHome: definition.showOnHomeByDefault !== false,
      });
    }
  }

  return { added, enabled, resolved, needsAccount: [...needsAccount], needsAccountKeys };
}

/** Applies the additions, leaving every other catalog and the ordering alone. */
export function applyCatalogAdditions(
  existing: CatalogConfig[],
  additions: CatalogAdditions
): CatalogConfig[] {
  const toEnable = new Set(additions.enabled);
  const updated = existing.map(catalog =>
    toEnable.has(`${catalog.id}:${catalog.type}`) ? { ...catalog, enabled: true } : catalog
  );
  return [...updated, ...additions.added];
}

/** Names for the confirm step, capped for display. */
export function additionLabels(additions: CatalogAdditions, limit = 8): string[] {
  return additions.added.slice(0, limit).map(catalog => catalog.name || catalog.id);
}
