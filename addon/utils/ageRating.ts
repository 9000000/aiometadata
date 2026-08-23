export const MOVIE_RATING_HIERARCHY = ['G', 'PG', 'PG-13', 'R', 'NC-17'];
export const TV_RATING_HIERARCHY = ['TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'TV-14', 'TV-MA'];
export const MOVIE_TO_TV_RATING: Record<string, string> = {
  'G': 'TV-G',
  'PG': 'TV-PG',
  'PG-13': 'TV-14',
  'R': 'TV-MA',
  'NC-17': 'TV-MA',
};

const MAL_RATING_TO_MPAA: Record<string, string> = {
  'G': 'G',
  'PG': 'PG',
  'PG-13': 'PG-13',
  'R': 'R',
  'R+': 'NC-17',
  'RX': 'NC-17',
};

/** Jikan spells a rating as "PG-13 - Teens 13 or older"; only the prefix is the rating. */
export function malRatingToCertification(rating: unknown): string | null {
  if (typeof rating !== 'string' || !rating.trim()) return null;
  const prefix = rating.split(' - ')[0].trim().toUpperCase();
  return MAL_RATING_TO_MPAA[prefix] || null;
}

export function hasAgeRatingCap(config: { ageRating?: unknown } | null | undefined): boolean {
  const cap = config?.ageRating;
  return typeof cap === 'string' && cap !== '' && cap.toLowerCase() !== 'none';
}

/**
 * Catalog rows carry no certification at all, so treating unknown as blocked empties
 * them outright. Opting out is the strict reading and stays available.
 */
export function allowsUnrated(config: { allowUnratedContent?: unknown } | null | undefined): boolean {
  return config?.allowUnratedContent !== false;
}

export function passesAgeRating(
  certification: string | null | undefined,
  type: string,
  ageRating: string,
  allowUnrated: boolean = true
): boolean {
  const isTvRating = type === 'series';
  const userRating = isTvRating ? (MOVIE_TO_TV_RATING[ageRating] || ageRating) : ageRating;

  if (!certification || certification === '' || certification.toLowerCase() === 'nr') {
    if (allowUnrated) return true;
    return !(userRating === 'PG-13'
      || (MOVIE_RATING_HIERARCHY.indexOf(userRating) !== -1 && MOVIE_RATING_HIERARCHY.indexOf(userRating) <= MOVIE_RATING_HIERARCHY.indexOf('PG-13'))
      || (TV_RATING_HIERARCHY.indexOf(userRating) !== -1 && TV_RATING_HIERARCHY.indexOf(userRating) <= TV_RATING_HIERARCHY.indexOf('TV-14')));
  }

  // A certification does not always use the scale its media type implies: MAL hands back
  // MPAA ratings for series. Compare on whichever scale actually carries it.
  let hierarchy = isTvRating ? TV_RATING_HIERARCHY : MOVIE_RATING_HIERARCHY;
  let cap = userRating;
  if (hierarchy.indexOf(certification) === -1) {
    const other = isTvRating ? MOVIE_RATING_HIERARCHY : TV_RATING_HIERARCHY;
    if (other.indexOf(certification) !== -1) {
      hierarchy = other;
      cap = isTvRating ? ageRating : (MOVIE_TO_TV_RATING[ageRating] || ageRating);
    }
  }

  const userRatingIndex = hierarchy.indexOf(cap);
  const resultRatingIndex = hierarchy.indexOf(certification);
  if (userRatingIndex === -1 || resultRatingIndex === -1) return true;
  return resultRatingIndex <= userRatingIndex;
}

/**
 * Spellings an install URL may use for a cap, mapped onto the scale it is stored on.
 * The TV scale collapses onto the nearest MPAA step, and TV-MA lands on R rather than
 * NC-17 because the reverse mapping is lossy and the stricter reading is the safe one.
 */
const RATING_OVERRIDE_ALIASES: Record<string, string> = {
  'NONE': 'None',
  'G': 'G',
  'PG': 'PG',
  'PG13': 'PG-13',
  'PG-13': 'PG-13',
  'R': 'R',
  'NC17': 'NC-17',
  'NC-17': 'NC-17',
  'R18': 'NC-17',
  'R+': 'NC-17',
  'RX': 'NC-17',
  'TV-Y': 'G',
  'TV-Y7': 'G',
  'TV-G': 'G',
  'TV-PG': 'PG',
  'TV-14': 'PG-13',
  'TV-MA': 'R',
};

/** How permissive a cap is. An absent or "None" cap permits everything. */
function capRank(rating: string | null | undefined): number {
  if (typeof rating !== 'string' || !rating.trim() || rating.trim().toLowerCase() === 'none') {
    return MOVIE_RATING_HIERARCHY.length;
  }
  const index = MOVIE_RATING_HIERARCHY.indexOf(rating.trim());
  return index === -1 ? MOVIE_RATING_HIERARCHY.length : index;
}

/** A single ?contentrating= value, or null when it names nothing recognisable. */
export function parseRatingOverride(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim().toUpperCase();
  return RATING_OVERRIDE_ALIASES[key] || null;
}

/**
 * Works out the cap an install URL asks for. The override may only tighten what the
 * stored config allows: it is the mechanism behind a kids install off a shared UUID,
 * so letting it loosen would mean anyone who can edit the URL can lift the limit.
 * Anything unrecognised or more permissive is refused rather than approximated, and
 * several values resolve to the strictest of them.
 */
export function resolveRatingOverride(
  config: { ageRating?: unknown } | null | undefined,
  raw: unknown
): { rating: string | null; requested: string[]; refused: string[] } {
  const values = (raw === undefined || raw === null ? [] : Array.isArray(raw) ? raw : [raw])
    .filter((value: any) => typeof value === 'string' && value.trim())
    .map((value: string) => value.trim());
  if (values.length === 0) return { rating: null, requested: [], refused: [] };

  const stored = typeof config?.ageRating === 'string' ? config.ageRating : null;
  const storedRank = capRank(stored);

  let rating: string | null = null;
  const refused: string[] = [];
  for (const value of values) {
    const parsed = parseRatingOverride(value);
    if (!parsed || capRank(parsed) >= storedRank) {
      refused.push(value);
      continue;
    }
    if (rating === null || capRank(parsed) < capRank(rating)) rating = parsed;
  }
  return { rating, requested: values, refused };
}
