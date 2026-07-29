import {
  createClassicRowDraft,
  createCollectionDraft,
  createFolderDraft,
  newId,
  type BuilderEntry,
  type ClassicRowDraft,
  type CollectionDraft,
  type CollectionViewMode,
  type FolderDraft,
  type FusionAspectRatio,
  type FusionCardStyle,
  type SourceDraft,
  type TileShape,
} from './types';

export type ImportFormat = 'nuvio' | 'fusion' | 'builder' | 'unknown';

export interface ImportResult {
  format: ImportFormat;
  entries: BuilderEntry[];
  notes: string[];
}

function trimmed(value: unknown): string {
  return String(value ?? '').trim();
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Nuvio writes POSTER/LANDSCAPE/SQUARE, Fusion writes Poster/Wide/Square. */
function toShape(value: unknown): TileShape {
  const normalized = trimmed(value).toUpperCase();
  if (normalized === 'POSTER') return 'POSTER';
  if (normalized === 'LANDSCAPE' || normalized === 'WIDE') return 'LANDSCAPE';
  if (normalized === 'SQUARE') return 'SQUARE';
  return 'POSTER';
}

function toViewMode(value: unknown): CollectionViewMode {
  const normalized = trimmed(value).toUpperCase();
  if (normalized === 'ROWS') return 'ROWS';
  if (normalized === 'FOLLOW_LAYOUT') return 'FOLLOW_LAYOUT';
  return 'TABBED_GRID';
}

function toAspect(value: unknown): FusionAspectRatio {
  const normalized = trimmed(value).toLowerCase();
  if (normalized === 'wide') return 'wide';
  if (normalized === 'square') return 'square';
  return 'poster';
}

function toCardStyle(value: unknown): FusionCardStyle {
  const normalized = trimmed(value).toLowerCase();
  if (normalized === 'small') return 'small';
  if (normalized === 'large') return 'large';
  return 'medium';
}

export function detectFormat(input: unknown): ImportFormat {
  if (Array.isArray(input)) {
    if (input.length === 0) return 'nuvio';
    const first = input[0];
    if (isRecord(first) && (first.kind === 'collection' || first.kind === 'classicRow')) {
      return 'builder';
    }
    if (isRecord(first) && 'folders' in first) return 'nuvio';
    return 'unknown';
  }
  if (isRecord(input)) {
    if (input.exportType === 'fusionWidgets' || Array.isArray(input.widgets)) return 'fusion';
    if (Array.isArray(input.collections)) return 'nuvio';
    if (Array.isArray(input.entries)) return 'builder';
  }
  return 'unknown';
}

// ---- Nuvio ----

function nuvioSource(raw: unknown, folderTitle: string, notes: string[]): SourceDraft | null {
  if (!isRecord(raw)) return null;
  const provider = trimmed(raw.provider || 'addon').toLowerCase();
  if (provider !== 'addon') {
    notes.push(`"${folderTitle}": skipped a ${provider} source. Only addon catalogs can be edited here.`);
    return null;
  }
  const catalogId = trimmed(raw.catalogId || raw.catalog_id);
  const type = trimmed(raw.type || raw.apiType);
  if (!catalogId || !type) {
    notes.push(`"${folderTitle}": skipped a source with no catalog id or type.`);
    return null;
  }
  return {
    catalogId,
    type,
    name: trimmed(raw.catalogName || raw.title || raw.name) || catalogId,
    genre: trimmed(raw.genre) || null,
  };
}

function nuvioFolder(raw: unknown, notes: string[]): FolderDraft | null {
  if (!isRecord(raw)) return null;
  const title = trimmed(raw.title);
  if (!title) {
    notes.push('Skipped a folder with no title.');
    return null;
  }

  const rawSources = Array.isArray(raw.sources) && raw.sources.length > 0
    ? raw.sources
    : Array.isArray(raw.catalogSources) ? raw.catalogSources : [];

  const sources = rawSources
    .map((source: unknown) => nuvioSource(isRecord(source) && !source.provider ? { ...source, provider: 'addon' } : source, title, notes))
    .filter((source): source is SourceDraft => source !== null);

  return {
    ...createFolderDraft(title),
    id: trimmed(raw.id) || newId(),
    title,
    shape: toShape(raw.tileShape),
    hideTitle: Boolean(raw.hideTitle),
    coverImageUrl: trimmed(raw.coverImageUrl),
    coverEmoji: trimmed(raw.coverEmoji),
    focusGifUrl: trimmed(raw.focusGifUrl),
    focusGifEnabled: raw.focusGifEnabled !== false,
    heroBackdropUrl: trimmed(raw.heroBackdropUrl),
    heroVideoUrl: trimmed(raw.heroVideoUrl),
    titleLogoUrl: trimmed(raw.titleLogoUrl),
    sources,
  };
}

export function fromNuvioCollections(input: unknown, notes: string[]): CollectionDraft[] {
  const list = Array.isArray(input)
    ? input
    : isRecord(input) && Array.isArray(input.collections) ? input.collections : [];

  const entries: CollectionDraft[] = [];
  for (const raw of list) {
    if (!isRecord(raw)) continue;
    const title = trimmed(raw.title);
    if (!title) {
      notes.push('Skipped a collection with no title.');
      continue;
    }
    const folders = (Array.isArray(raw.folders) ? raw.folders : [])
      .map((folder: unknown) => nuvioFolder(folder, notes))
      .filter((folder): folder is FolderDraft => folder !== null);

    entries.push({
      ...createCollectionDraft(title),
      id: trimmed(raw.id) || newId(),
      title,
      backdropImageUrl: trimmed(raw.backdropImageUrl),
      pinToTop: Boolean(raw.pinToTop),
      focusGlowEnabled: raw.focusGlowEnabled !== false,
      viewMode: toViewMode(raw.viewMode),
      showAllTab: raw.showAllTab !== false,
      folders,
    });
  }
  return entries;
}

// ---- Fusion ----

/** Fusion stores `<type>::<id>`; everything after the first separator is the id. */
function splitCatalogId(composite: string, fallbackType: string): { catalogId: string; type: string } | null {
  const value = trimmed(composite);
  if (!value) return null;
  const index = value.indexOf('::');
  if (index < 0) {
    return fallbackType ? { catalogId: value, type: fallbackType } : null;
  }
  const type = value.slice(0, index).trim();
  const catalogId = value.slice(index + 2).trim();
  if (!catalogId) return null;
  return { catalogId, type: type || fallbackType };
}

function fusionSource(raw: unknown, label: string, notes: string[]): SourceDraft | null {
  if (!isRecord(raw)) return null;
  if (raw.kind && raw.kind !== 'addonCatalog') {
    notes.push(`"${label}": skipped a ${trimmed(raw.kind)} source. Only addon catalogs can be edited here.`);
    return null;
  }
  const payload = isRecord(raw.payload) ? raw.payload : {};
  const split = splitCatalogId(trimmed(payload.catalogId), trimmed(payload.catalogType));
  if (!split) {
    notes.push(`"${label}": skipped a source with no catalog id.`);
    return null;
  }
  return { catalogId: split.catalogId, type: split.type, name: split.catalogId, genre: null };
}

function fusionItem(raw: unknown, notes: string[]): FolderDraft | null {
  if (!isRecord(raw)) return null;
  const title = trimmed(raw.name || raw.title);
  if (!title) {
    notes.push('Skipped an item with no name.');
    return null;
  }
  const sources = (Array.isArray(raw.dataSources) ? raw.dataSources : [])
    .map((source: unknown) => fusionSource(source, title, notes))
    .filter((source): source is SourceDraft => source !== null);

  return {
    ...createFolderDraft(title),
    id: trimmed(raw.id) || newId(),
    title,
    shape: toShape(raw.layout),
    hideTitle: Boolean(raw.hideTitle),
    coverImageUrl: trimmed(raw.backgroundImageURL),
    sources,
  };
}

export function fromFusionWidgets(input: unknown, notes: string[]): BuilderEntry[] {
  const widgets = isRecord(input) && Array.isArray(input.widgets)
    ? input.widgets
    : Array.isArray(input) ? input : [];

  const entries: BuilderEntry[] = [];
  for (const raw of widgets) {
    if (!isRecord(raw)) continue;
    const title = trimmed(raw.title);
    if (!title) {
      notes.push('Skipped a widget with no title.');
      continue;
    }

    if (raw.type === 'row.classic') {
      const source = fusionSource(raw.dataSource, title, notes);
      const presentation = isRecord(raw.presentation) ? raw.presentation : {};
      const badges = isRecord(presentation.badges) ? presentation.badges : {};
      const row: ClassicRowDraft = {
        ...createClassicRowDraft(title),
        id: trimmed(raw.id) || newId(),
        title,
        hideTitle: Boolean(raw.hideTitle),
        source,
        limit: Number.isFinite(Number(raw.limit)) ? Math.trunc(Number(raw.limit)) : 20,
        cacheTTL: Number.isFinite(Number(raw.cacheTTL)) ? Math.trunc(Number(raw.cacheTTL)) : 1800,
        aspectRatio: toAspect(presentation.aspectRatio),
        cardStyle: toCardStyle(presentation.cardStyle),
        badges: { providers: Boolean(badges.providers), ratings: badges.ratings !== false },
        backgroundImageURL: trimmed(presentation.backgroundImageURL),
      };
      entries.push(row);
      continue;
    }

    const dataSource = isRecord(raw.dataSource) ? raw.dataSource : {};
    const payload = isRecord(dataSource.payload) ? dataSource.payload : {};
    const items = Array.isArray(payload.items) ? payload.items : [];
    const folders = items
      .map((item: unknown) => fusionItem(item, notes))
      .filter((folder): folder is FolderDraft => folder !== null);

    entries.push({
      ...createCollectionDraft(title),
      id: trimmed(raw.id) || newId(),
      title,
      hideTitle: Boolean(raw.hideTitle),
      folders,
    });
  }
  return entries;
}

// ---- Builder's own shape, for restoring a config backup ----

function fromBuilderEntries(input: unknown, notes: string[]): BuilderEntry[] {
  const list = Array.isArray(input)
    ? input
    : isRecord(input) && Array.isArray(input.entries) ? input.entries : [];

  const entries: BuilderEntry[] = [];
  for (const raw of list) {
    if (!isRecord(raw)) continue;
    if (raw.kind === 'classicRow') {
      entries.push({ ...createClassicRowDraft(trimmed(raw.title)), ...raw } as ClassicRowDraft);
      continue;
    }
    if (raw.kind === 'collection') {
      entries.push({ ...createCollectionDraft(trimmed(raw.title)), ...raw } as CollectionDraft);
      continue;
    }
    notes.push('Skipped an entry with an unknown kind.');
  }
  return entries;
}

/**
 * Accepts whatever the user has on hand: the Nuvio array, the Fusion envelope,
 * or a raw config backup. Anything that cannot be represented in the editor is
 * reported rather than dropped quietly.
 */
export function importEntries(raw: unknown): ImportResult {
  const notes: string[] = [];
  const format = detectFormat(raw);

  if (format === 'nuvio') return { format, entries: fromNuvioCollections(raw, notes), notes };
  if (format === 'fusion') return { format, entries: fromFusionWidgets(raw, notes), notes };
  if (format === 'builder') return { format, entries: fromBuilderEntries(raw, notes), notes };

  return { format: 'unknown', entries: [], notes: ['Could not tell what this file is.'] };
}

export function parseImport(text: string): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { format: 'unknown', entries: [], notes: ['That is not valid JSON.'] };
  }
  return importEntries(parsed);
}

/** One missing catalog, plus every place it is referenced. */
export interface MissingCatalogGroup {
  key: string;
  catalogId: string;
  type: string;
  name: string;
  occurrences: number;
}

export function groupMissingCatalogs(missing: SourceDraft[]): MissingCatalogGroup[] {
  const groups = new Map<string, MissingCatalogGroup>();
  for (const source of missing) {
    const key = `${source.catalogId}:${source.type}`;
    const existing = groups.get(key);
    if (existing) {
      existing.occurrences += 1;
      continue;
    }
    groups.set(key, {
      key,
      catalogId: source.catalogId,
      type: source.type,
      name: trimmed(source.name) || source.catalogId,
      occurrences: 1,
    });
  }
  return [...groups.values()];
}

/**
 * Swaps missing catalogs for ones the user has, everywhere they appear. Lets an
 * imported layout be kept while the catalogs behind it are plugged in.
 */
export function remapSources(
  entries: BuilderEntry[],
  mapping: Record<string, SourceDraft>
): { entries: BuilderEntry[]; replaced: number } {
  let replaced = 0;

  const swap = (source: SourceDraft): SourceDraft => {
    const target = mapping[`${source.catalogId}:${source.type}`];
    if (!target) return source;
    replaced += 1;
    return { ...target };
  };

  /** A folder must not end up holding the same catalog twice after a swap. */
  const dedupe = (sources: SourceDraft[]): SourceDraft[] => {
    const seen = new Set<string>();
    return sources.filter(source => {
      const key = `${source.catalogId}:${source.type}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  const next = entries.map((entry): BuilderEntry => {
    if (entry.kind === 'classicRow') {
      return entry.source ? { ...entry, source: swap(entry.source) } : entry;
    }
    return {
      ...entry,
      folders: entry.folders.map(folder => ({
        ...folder,
        sources: dedupe(folder.sources.map(swap)),
      })),
    };
  });

  return { entries: next, replaced };
}
