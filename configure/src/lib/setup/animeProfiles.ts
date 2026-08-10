import type { AppConfig } from '@/contexts/config';
import type { AnimeSource, ContentChoice } from './types';

type AnimeProfile = Pick<AppConfig, 'sfw'> &
  Partial<Pick<AppConfig, 'providers' | 'artProviders' | 'mal' | 'search'>>;

const MOVIES_TV: AnimeProfile = {
  sfw: true,
  providers: {
    movie: 'tmdb',
    series: 'tvdb',
    anime: 'tvdb',
    anime_id_provider: 'imdb',
    forceAnimeForDetectedImdb: false,
  },
  artProviders: {
    movie: { poster: 'meta', background: 'meta', logo: 'meta' },
    series: { poster: 'meta', background: 'meta', logo: 'meta' },
    anime: { poster: 'tvdb', background: 'tvdb', logo: 'tvdb' },
    englishArtOnly: false,
    originalLangFallback: false,
  },
  search: {
    enabled: true,
    ai_enabled: false,
    providers: {
      movie: 'tmdb.search',
      series: 'tvdb.search',
      anime_movie: 'mal.search.movie',
      anime_series: 'mal.search.series',
    },
    engineEnabled: {
      'tmdb.search': true,
      'tvdb.search': true,
      'tvdb.collections.search': false,
      'tvmaze.search': true,
      'mal.search.movie': false,
      'mal.search.series': false,
    },
  },
};

const ANIME_KITSU: AnimeProfile = {
  sfw: true,
  providers: {
    movie: 'tmdb',
    series: 'tvdb',
    anime: 'kitsu',
    anime_id_provider: 'kitsu',
    forceAnimeForDetectedImdb: false,
  },
  artProviders: {
    movie: { poster: 'meta', background: 'meta', logo: 'meta' },
    series: { poster: 'meta', background: 'meta', logo: 'meta' },
    anime: { poster: 'meta', background: 'imdb', logo: 'imdb' },
    englishArtOnly: false,
    originalLangFallback: false,
  },
  mal: {
    skipFiller: false,
    skipRecap: false,
    allowEpisodeMarking: false,
    useImdbIdForCatalogAndSearch: false,
  },
  search: {
    enabled: true,
    ai_enabled: false,
    providers: {
      movie: 'tmdb.search',
      series: 'tvdb.search',
      anime_movie: 'kitsu.search.movie',
      anime_series: 'kitsu.search.series',
    },
    engineEnabled: {
      'tmdb.search': true,
      'tvdb.search': true,
      'tvdb.collections.search': false,
      'tvmaze.search': true,
      'kitsu.search.movie': true,
      'kitsu.search.series': true,
    },
  },
};

const ANIME_TVDB: AnimeProfile = {
  sfw: true,
  providers: {
    movie: 'tmdb',
    series: 'tvdb',
    anime: 'tvdb',
    anime_id_provider: 'kitsu',
    forceAnimeForDetectedImdb: false,
  },
  artProviders: {
    movie: { poster: 'meta', background: 'meta', logo: 'meta' },
    series: { poster: 'meta', background: 'meta', logo: 'meta' },
    anime: { poster: 'mal', background: 'imdb', logo: 'imdb' },
    englishArtOnly: false,
    originalLangFallback: false,
  },
  mal: {
    skipFiller: false,
    skipRecap: false,
    allowEpisodeMarking: false,
    useImdbIdForCatalogAndSearch: false,
  },
  search: {
    enabled: true,
    ai_enabled: false,
    providers: {
      movie: 'tmdb.search',
      series: 'tvdb.search',
      anime_movie: 'kitsu.search.movie',
      anime_series: 'kitsu.search.series',
    },
    engineEnabled: {
      'tmdb.search': true,
      'tvdb.search': true,
      'tvdb.collections.search': false,
      'tvmaze.search': true,
      'kitsu.search.movie': true,
      'kitsu.search.series': true,
    },
  },
};

const ANIME_FIRST: AnimeProfile = {
  sfw: true,
  providers: {
    movie: 'tmdb',
    series: 'tvdb',
    anime: 'tvdb',
    anime_id_provider: 'kitsu',
    forceAnimeForDetectedImdb: true,
  },
  artProviders: {
    movie: { poster: 'meta', background: 'meta', logo: 'meta' },
    series: { poster: 'meta', background: 'imdb', logo: 'imdb' },
    anime: { poster: 'tvdb', background: 'imdb', logo: 'imdb' },
    englishArtOnly: false,
    originalLangFallback: false,
  },
  mal: {
    skipFiller: false,
    skipRecap: false,
    allowEpisodeMarking: false,
    useImdbIdForCatalogAndSearch: true,
  },
  search: {
    enabled: true,
    ai_enabled: false,
    providers: {
      movie: 'tmdb.search',
      series: 'tvdb.search',
      anime_movie: 'kitsu.search.movie',
      anime_series: 'kitsu.search.series',
    },
    engineEnabled: {
      'tmdb.search': true,
      'tvdb.search': true,
      'tvdb.collections.search': false,
      'tvmaze.search': true,
      'kitsu.search.movie': true,
      'kitsu.search.series': true,
    },
  },
};

export interface AnimeSourceOption {
  value: AnimeSource;
  label: string;
  hint: string;
  /** Which ids episodes carry, which is what stream addons match on. */
  episodeIds: string;
  recommended?: boolean;
}

/** Kitsu and MAL are unusable under the detection override: IMDb ids cannot map to them. */
export const ANIME_SOURCE_OPTIONS: Record<ContentChoice, AnimeSourceOption[]> = {
  'movies-tv': [],
  'with-anime': [
    {
      value: 'tvdb',
      label: 'One page per series',
      hint: 'TVDB. The catalog still lists Re:Zero season 1 and season 2 as separate entries, but opening either one lands on the same page, with the seasons grouped.',
      episodeIds: 'Episodes carry Kitsu ids, so streams come from addons that speak Kitsu.',
      recommended: true,
    },
    {
      value: 'kitsu',
      label: 'One page per season',
      hint: 'Kitsu. The catalog lists those same separate entries, and each one opens as its own title, the way anime is usually catalogued.',
      episodeIds: 'Episodes carry Kitsu ids, so streams come from addons that speak Kitsu.',
    },
  ],
  'anime-first': [
    {
      value: 'tvdb',
      label: 'One page per series',
      hint: 'TVDB. Separate season entries in the catalog, but any of them opens the whole run with its seasons grouped.',
      episodeIds: 'Episodes carry Kitsu ids, so streams come from addons that speak Kitsu.',
      recommended: true,
    },
    {
      value: 'imdb',
      label: 'Match the rest of your library',
      hint: 'IMDb. Seasons are grouped, the same as any other show you watch.',
      episodeIds: 'Episodes carry IMDb ids, so any stream addon can find them, not just anime ones.',
    },
  ],
};

export function defaultAnimeSource(content: ContentChoice): AnimeSource {
  return ANIME_SOURCE_OPTIONS[content].find(option => option.recommended)?.value ?? 'tvdb';
}

export function resolveAnimeProfile(content: ContentChoice, source: AnimeSource): AnimeProfile {
  if (content === 'movies-tv') return MOVIES_TV;
  if (content === 'with-anime') return source === 'kitsu' ? ANIME_KITSU : ANIME_TVDB;

  if (source !== 'imdb') return ANIME_FIRST;

  return {
    ...ANIME_FIRST,
    providers: { ...ANIME_FIRST.providers!, anime: 'imdb', anime_id_provider: 'imdb' },
  };
}

export function includesAnime(content: ContentChoice): boolean {
  return content !== 'movies-tv';
}
