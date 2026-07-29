import type {
  AddonIdentity,
  BuilderEntry,
  ExportNote,
  ExportResult,
  FolderDraft,
  NuvioAddonSource,
  NuvioCatalogSource,
  NuvioCollection,
  NuvioFolder,
  SourceDraft,
} from './types';

function trimmed(value: unknown): string {
  return String(value ?? '').trim();
}

function orNull(value: unknown): string | null {
  return trimmed(value) || null;
}

function toAddonSource(source: SourceDraft, identity: AddonIdentity): NuvioAddonSource | null {
  const catalogId = trimmed(source.catalogId);
  const type = trimmed(source.type).toLowerCase();
  const addonId = trimmed(identity.addonId);
  if (!addonId || !type || !catalogId) return null;

  const name = trimmed(source.name) || catalogId;
  return {
    provider: 'addon',
    addonId,
    addonBaseUrl: orNull(identity.addonBaseUrl),
    addonName: orNull(identity.addonName),
    type,
    catalogId,
    catalogName: name,
    title: name,
    genre: orNull(source.genre),
  };
}

function toCatalogSource(source: NuvioAddonSource): NuvioCatalogSource {
  return {
    addonId: source.addonId,
    addonBaseUrl: source.addonBaseUrl,
    addonName: source.addonName,
    type: source.type,
    catalogId: source.catalogId,
    catalogName: source.catalogName,
    title: source.title || source.catalogName,
    genre: source.genre,
  };
}

function toFolder(
  folder: FolderDraft,
  identity: AddonIdentity,
  collectionTitle: string,
  notes: ExportNote[]
): NuvioFolder | null {
  const id = trimmed(folder.id);
  const title = trimmed(folder.title);
  if (!id || !title) {
    notes.push({
      entryId: folder.id,
      entryTitle: collectionTitle,
      message: `A folder without a title was skipped. Nuvio drops folders that have no title.`,
    });
    return null;
  }

  const sources: NuvioAddonSource[] = [];
  for (const source of folder.sources) {
    const mapped = toAddonSource(source, identity);
    if (mapped) {
      sources.push(mapped);
      continue;
    }
    notes.push({
      entryId: folder.id,
      entryTitle: title,
      message: `Source "${trimmed(source.name) || trimmed(source.catalogId) || 'unnamed'}" is missing a catalog id or type and was skipped.`,
    });
  }

  if (sources.length === 0) {
    notes.push({
      entryId: folder.id,
      entryTitle: title,
      message: `Folder "${title}" has no usable sources and was skipped.`,
    });
    return null;
  }

  return {
    id,
    title,
    coverImageUrl: orNull(folder.coverImageUrl),
    focusGifUrl: orNull(folder.focusGifUrl),
    focusGifEnabled: folder.focusGifEnabled !== false,
    coverEmoji: orNull(folder.coverEmoji),
    tileShape: folder.shape,
    hideTitle: Boolean(folder.hideTitle),
    sources,
    catalogSources: sources.map(toCatalogSource),
    heroBackdropUrl: orNull(folder.heroBackdropUrl),
    heroVideoUrl: orNull(folder.heroVideoUrl),
    titleLogoUrl: orNull(folder.titleLogoUrl),
  };
}

/**
 * Nuvio's CollectionsStore.importFromJson expects a bare array, and its normalizer
 * silently discards anything it cannot validate. Everything dropped here is reported
 * back as a note instead.
 */
export function toNuvioCollections(
  entries: BuilderEntry[],
  identity: AddonIdentity
): ExportResult<NuvioCollection[]> {
  const notes: ExportNote[] = [];
  const output: NuvioCollection[] = [];

  for (const entry of entries) {
    if (entry.kind === 'classicRow') {
      notes.push({
        entryId: entry.id,
        entryTitle: entry.title,
        message: `"${trimmed(entry.title) || 'Untitled row'}" is a classic row. Nuvio has no equivalent, so it is only included in the Fusion export.`,
      });
      continue;
    }

    const id = trimmed(entry.id);
    const title = trimmed(entry.title);
    if (!id || !title) {
      notes.push({
        entryId: entry.id,
        entryTitle: entry.title,
        message: 'A collection without a title was skipped. Nuvio drops collections that have no title.',
      });
      continue;
    }

    const folders = entry.folders
      .map(folder => toFolder(folder, identity, title, notes))
      .filter((folder): folder is NuvioFolder => folder !== null);

    output.push({
      id,
      title,
      backdropImageUrl: orNull(entry.backdropImageUrl),
      pinToTop: Boolean(entry.pinToTop),
      focusGlowEnabled: entry.focusGlowEnabled !== false,
      viewMode: entry.viewMode || 'TABBED_GRID',
      showAllTab: entry.showAllTab !== false,
      folders,
    });
  }

  return { output, notes };
}
