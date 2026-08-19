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
