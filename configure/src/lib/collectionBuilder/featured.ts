export interface FeaturedCollection {
  id: string;
  name: string;
  author: string;
  authorUrl: string;
  /**
   * Fetched as-is. A remote URL keeps the author's own updates flowing without a
   * release here; a local one under public/featured pins a copy when the author
   * has no stable raw link to point at.
   */
  url: string;
  summary: string;
  note?: string;
  /** Shown before loading, because a big design can exceed the catalog limit. */
  catalogs: number;
  detail: string;
  /** Nuvio has no classic row and skips them, so the count is worth stating. */
  classicRows?: number;
}

export const FEATURED_COLLECTIONS: FeaturedCollection[] = [
  {
    id: 'ninja-streams',
    name: 'Ninja Streams',
    author: 'RandomNinjaAtk',
    authorUrl: 'https://github.com/RandomNinjaAtk/Ninja-Streams',
    url: 'https://raw.githubusercontent.com/RandomNinjaAtk/Ninja-Streams/main/AIOMetadata/Fusion-Widgets.json',
    summary: 'New and trending, streaming services, genres, decades, runtime, studios and networks, plus airing this week, recent releases and library rows.',
    catalogs: 114,
    detail: '12 designs, 7 collections and 5 classic rows.',
    classicRows: 5,
  },
  {
    id: 'ume-nobnobz',
    name: 'Unified Media Experience',
    author: 'nobnobz',
    authorUrl: 'https://nobnobz.github.io/fusion-widget-manager/',
    url: '/featured/ume-nobnobz.json',
    summary: 'Discover, streaming services, genres, decades, directors, actors, studios, awards, collections and lists.',
    catalogs: 371,
    detail: '24 designs, 10 collections and 14 classic rows, 271 folders with artwork.',
    classicRows: 14,
  },
];
