import type { AppConfig, WatchTrackingService } from '@/contexts/config';

export type WatchTrackingMediaType = 'movie' | 'series';
type WatchTrackingMasterKey =
  | 'traktWatchTracking'
  | 'simklWatchTracking'
  | 'anilistWatchTracking'
  | 'malWatchTracking'
  | 'mdblistWatchTracking'
  | 'publicmetadbWatchTracking';

interface WatchTrackingServiceDefinition {
  label: string;
  masterKey: WatchTrackingMasterKey;
  hasCredential: (config: AppConfig) => boolean;
  movieLabel: string;
  seriesLabel: string;
}

export const WATCH_TRACKING_SERVICES: WatchTrackingService[] = [
  'trakt',
  'simkl',
  'anilist',
  'mal',
  'mdblist',
  'publicmetadb',
];

export const WATCH_TRACKING_SERVICE_DEFINITIONS: Record<
  WatchTrackingService,
  WatchTrackingServiceDefinition
> = {
  trakt: {
    label: 'Trakt',
    masterKey: 'traktWatchTracking',
    hasCredential: (config) => !!config.apiKeys?.traktTokenId,
    movieLabel: 'Movies',
    seriesLabel: 'TV Shows',
  },
  simkl: {
    label: 'Simkl',
    masterKey: 'simklWatchTracking',
    hasCredential: (config) => !!config.apiKeys?.simklTokenId,
    movieLabel: 'Movies',
    seriesLabel: 'TV Shows',
  },
  anilist: {
    label: 'AniList',
    masterKey: 'anilistWatchTracking',
    hasCredential: (config) => !!config.apiKeys?.anilistTokenId,
    movieLabel: 'Anime Movies',
    seriesLabel: 'Anime Series',
  },
  mal: {
    label: 'MyAnimeList',
    masterKey: 'malWatchTracking',
    hasCredential: (config) => !!config.apiKeys?.malTokenId,
    movieLabel: 'Anime Movies',
    seriesLabel: 'Anime Series',
  },
  mdblist: {
    label: 'MDBList',
    masterKey: 'mdblistWatchTracking',
    hasCredential: (config) => !!config.apiKeys?.mdblist,
    movieLabel: 'Movies',
    seriesLabel: 'TV Shows',
  },
  publicmetadb: {
    label: 'PublicMetaDB',
    masterKey: 'publicmetadbWatchTracking',
    hasCredential: (config) => !!config.apiKeys?.publicmetadb,
    movieLabel: 'Movies',
    seriesLabel: 'TV Shows',
  },
};

export function isWatchTrackingMediaTypeSelected(
  config: AppConfig,
  service: WatchTrackingService,
  mediaType: WatchTrackingMediaType,
): boolean {
  return config.watchTracking?.[service]?.[mediaType] !== false;
}

export function isWatchTrackingServiceEnabled(
  config: AppConfig,
  service: WatchTrackingService,
): boolean {
  const { masterKey } = WATCH_TRACKING_SERVICE_DEFINITIONS[service];
  return config[masterKey] === true;
}

export function isWatchTrackingMediaTypeEnabled(
  config: AppConfig,
  service: WatchTrackingService,
  mediaType: WatchTrackingMediaType,
): boolean {
  return (
    isWatchTrackingServiceEnabled(config, service) &&
    isWatchTrackingMediaTypeSelected(config, service, mediaType)
  );
}

export function hasAnyWatchTrackingEnabled(config: AppConfig): boolean {
  return WATCH_TRACKING_SERVICES.some((service) => {
    const definition = WATCH_TRACKING_SERVICE_DEFINITIONS[service];
    return (
      definition.hasCredential(config) &&
      (isWatchTrackingMediaTypeEnabled(config, service, 'movie') ||
        isWatchTrackingMediaTypeEnabled(config, service, 'series'))
    );
  });
}

export function getWatchTrackingMediaTypeSummary(
  config: AppConfig,
  service: WatchTrackingService,
): string {
  const definition = WATCH_TRACKING_SERVICE_DEFINITIONS[service];
  const movie = isWatchTrackingMediaTypeSelected(config, service, 'movie');
  const series = isWatchTrackingMediaTypeSelected(config, service, 'series');

  if (movie && series) return `${definition.movieLabel} & ${definition.seriesLabel}`;
  if (movie) return definition.movieLabel;
  if (series) return definition.seriesLabel;
  return 'No media types selected';
}

