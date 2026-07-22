interface NormalizedRating {
  imdb: string;
  rating: number;
  ratedAt: string;
  title: string;
  year: number | null;
}

const IMDB_HEADER =
  'Const,Your Rating,Date Rated,Title,URL,Title Type,IMDb Rating,Runtime (mins),Year,Genres,Num Votes,Release Date,Directors';

function csvField(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function normalizeImdb(raw: any): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  return s.startsWith('tt') ? s : `tt${s}`;
}

function validRating(r: any): boolean {
  return typeof r === 'number' && r >= 1 && r <= 10;
}

// Shared shape for Trakt `/users/me/ratings/movies` AND MDBList `/sync/ratings` movies[]:
// each item is { rated_at, rating, movie: { title, year, ids: { imdb } } }.
function fromMovieRatingItems(items: any[]): NormalizedRating[] {
  const out: NormalizedRating[] = [];
  for (const it of items || []) {
    const imdb = normalizeImdb(it?.movie?.ids?.imdb);
    const rating = it?.rating;
    if (!imdb || !validRating(rating)) continue;
    out.push({
      imdb,
      rating,
      ratedAt: it?.rated_at || '',
      title: it?.movie?.title || '',
      year: it?.movie?.year ?? null,
    });
  }
  return out;
}

// Simkl `/sync/ratings/movies` returns the whole movie collection with `user_rating`
// null on unrated items — the validRating filter keeps only truly-rated movies.
// Rating is `user_rating`; date is often only in `last_watched_at` (user_rated_at
// is frequently null even for rated items).
function fromSimklMovieRatings(sync: any): NormalizedRating[] {
  const items = sync?.movies || [];
  const out: NormalizedRating[] = [];
  for (const it of items) {
    const imdb = normalizeImdb(it?.movie?.ids?.imdb);
    const rating = it?.user_rating ?? it?.rating;
    if (!imdb || !validRating(rating)) continue;
    out.push({
      imdb,
      rating,
      ratedAt: it?.user_rated_at || it?.last_watched_at || it?.rated_at || '',
      title: it?.movie?.title || '',
      year: it?.movie?.year ?? null,
    });
  }
  return out;
}

// Merge across sources; on the same imdb id, the most recent rated_at wins.
function mergeRatings(...lists: NormalizedRating[][]): NormalizedRating[] {
  const byImdb = new Map<string, NormalizedRating>();
  for (const list of lists) {
    for (const r of list) {
      const prev = byImdb.get(r.imdb);
      if (!prev || (r.ratedAt || '') > (prev.ratedAt || '')) {
        byImdb.set(r.imdb, r);
      }
    }
  }
  return Array.from(byImdb.values());
}

function normalizedToImdbCsv(ratings: NormalizedRating[]): { csv: string; count: number } {
  const rows: string[] = [IMDB_HEADER];
  for (const r of ratings || []) {
    if (!normalizeImdb(r.imdb) || !validRating(r.rating)) continue;
    rows.push([
      csvField(r.imdb),
      csvField(r.rating),
      csvField((r.ratedAt || '').slice(0, 10)),
      csvField(r.title),
      csvField(`https://www.imdb.com/title/${r.imdb}/`),
      'movie',
      '',
      '',
      csvField(r.year),
      '',
      '',
      '',
      '',
    ].join(','));
  }
  return { csv: rows.join('\n') + '\n', count: rows.length - 1 };
}

export {
  NormalizedRating,
  fromMovieRatingItems,
  fromSimklMovieRatings,
  mergeRatings,
  normalizedToImdbCsv,
};
module.exports = {
  fromMovieRatingItems,
  fromSimklMovieRatings,
  mergeRatings,
  normalizedToImdbCsv,
};
