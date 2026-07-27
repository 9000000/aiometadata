/**
 * Every TMDB image size decision lives here.
 *
 * TMDB serves `/t/p/original` as the uploader's file: a median 3700px backdrop
 * and a median 1683px lossless PNG logo, for a logo Stremio renders at roughly
 * 200px. Both toggles below trade that for a sized rendition.
 *
 * Env is read per call and never at module load, so a dashboard toggle takes
 * effect without a restart — `settingsService.setSetting` writes through to
 * `process.env`. `scripts/check-env-registry.ts` enforces this.
 */

export const TMDB_IMAGE_HOST = 'https://image.tmdb.org/t/p';

/** The poster rendition every meta and search response emits. */
export const TMDB_POSTER_SIZE = 'w600_and_h900_bestv2';

const ORIGINAL = 'original';
const SMALL_LOGO = 'w500';
const SMALL_BACKDROP = 'w1280';

function isTruthy(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value || '').trim());
}

function isExplicitlyDisabled(value: string | undefined): boolean {
  return /^(0|false|no|off)$/i.test((value || '').trim());
}

/**
 * Defaults ON. `w500` against a ~200px render target is not a visible change,
 * and originals are lossless PNGs around 12x the size.
 */
export function tmdbLogoSize(): string {
  return isExplicitlyDisabled(process.env.PREFER_SMALLER_LOGOS_TMDB) ? ORIGINAL : SMALL_LOGO;
}

/**
 * Defaults OFF. The median original backdrop is 3700px wide and many are true
 * 4K, so `w1280` is a real downscale a full-screen client can show.
 */
export function tmdbBackdropSize(): string {
  return isTruthy(process.env.PREFER_SMALLER_BACKDROPS_TMDB) ? SMALL_BACKDROP : ORIGINAL;
}

/** `filePath` is TMDB's `file_path`, which always carries its own leading slash. */
export function tmdbImageUrl(size: string, filePath: string): string {
  return `${TMDB_IMAGE_HOST}/${size}${filePath}`;
}

module.exports = {
  TMDB_IMAGE_HOST,
  TMDB_POSTER_SIZE,
  tmdbLogoSize,
  tmdbBackdropSize,
  tmdbImageUrl,
};
