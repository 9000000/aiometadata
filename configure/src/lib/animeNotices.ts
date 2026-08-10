

export type NoticeLevel = 'info' | 'warn';

export interface AnimeNotice {
  id: string;
  level: NoticeLevel;
  text: string;
}

type ConfigLike = {
  providers?: { forceAnimeForDetectedImdb?: boolean };
  mal?: { useImdbIdForCatalogAndSearch?: boolean };
};

export function animeNotices(config: ConfigLike): AnimeNotice[] {
  const providers = config?.providers ?? {};
  const notices: AnimeNotice[] = [];

  if (providers.forceAnimeForDetectedImdb) {
    notices.push({
      id: 'anime-art-detection',
      level: 'warn',
      text: 'Anime Detection Override is on, so detected anime with IMDb IDs use your Movie and Series art providers rather than the Anime ones.',
    });
  }

  if (config?.mal?.useImdbIdForCatalogAndSearch) {
    notices.push({
      id: 'anime-art-catalog',
      level: 'warn',
      text: 'Use IMDb ID for Catalog/Search is on, so anime in catalogs and search use your Movie and Series art providers rather than the Anime ones.',
    });
  }

  return notices;
}
