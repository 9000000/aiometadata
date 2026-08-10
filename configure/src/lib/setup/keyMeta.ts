import type { RequiredKeyId } from './types';

export const KEY_META: Record<RequiredKeyId, { label: string; short: string; placeholder: string; url: string }> = {
  tmdb: {
    label: 'TMDB key',
    short: 'TMDB',
    placeholder: 'Paste your TMDB API key',
    url: 'https://www.themoviedb.org/settings/api',
  },
  tvdb: {
    label: 'TVDB key',
    short: 'TVDB',
    placeholder: 'Paste your TVDB API key',
    url: 'https://thetvdb.com/api-information',
  },
  mdblist: {
    label: 'MDBList key',
    short: 'MDBList',
    placeholder: 'Paste your MDBList API key',
    url: 'https://mdblist.com/preferences/',
  },
};
