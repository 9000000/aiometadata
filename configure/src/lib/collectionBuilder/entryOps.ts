import type { BuilderEntry } from '@shared/types';

const COPY_SUFFIX = /^(.*?) copy(?: (\d+))?$/;

export function nextCopyTitle(title: string): string {
  const base = title.trim() || 'Untitled';
  const match = COPY_SUFFIX.exec(base);
  if (!match) return `${base} copy`;
  const n = match[2] ? parseInt(match[2], 10) : 1;
  return `${match[1]} copy ${n + 1}`;
}

function haystack(entry: BuilderEntry): string {
  const parts = [entry.title];
  if (entry.kind === 'classicRow') {
    if (entry.source) parts.push(entry.source.name || entry.source.catalogId);
  } else {
    for (const folder of entry.folders) {
      parts.push(folder.title);
      for (const source of folder.sources) parts.push(source.name || source.catalogId);
    }
  }
  return parts.join(' ').toLowerCase();
}

export function filterEntries(entries: BuilderEntry[], query: string): BuilderEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter(entry => haystack(entry).includes(needle));
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function describeEntryCount(entry: BuilderEntry): string {
  if (entry.kind === 'classicRow') return entry.source ? '1 catalog' : 'No catalog';
  const catalogs = entry.folders.reduce((total, folder) => total + folder.sources.length, 0);
  return `${plural(entry.folders.length, 'folder')} · ${plural(catalogs, 'catalog')}`;
}
