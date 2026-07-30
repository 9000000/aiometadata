

export type NoticeLevel = 'info' | 'warn';

export interface AnimeNotice {
  id: string;
  level: NoticeLevel;
  text: string;
}

type ConfigLike = {
  providers?: {
    anime?: string;
    anime_id_provider?: string;
    forceAnimeForDetectedImdb?: boolean;
  };
  mal?: { useImdbIdForCatalogAndSearch?: boolean };
};

/** Anime meta providers that are not anime databases, so IDs must be mapped. */
const MAPPED_META: Record<string, string> = { tvdb: 'TheTVDB', imdb: 'IMDb' };
/** Compatibility IDs that then have to be mapped back onto that provider. */
const MAPPED_ID: Record<string, string> = { kitsu: 'Kitsu', mal: 'MyAnimeList' };

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

  const meta = MAPPED_META[providers.anime ?? ''];
  const id = MAPPED_ID[providers.anime_id_provider ?? ''];
  if (meta && id) {
    notices.push({
      id: 'anime-id-experimental',
      level: 'warn',
      text: `${meta} as the anime meta provider with ${id} compatibility IDs relies on community mappings, which can be incomplete or inaccurate. Treat this pairing as experimental.`,
    });
  }

  return notices;
}
