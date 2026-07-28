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
const SMALL_LANDSCAPE = 'w780';

function isTruthy(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value || '').trim());
}

function isExplicitlyDisabled(value: string | undefined): boolean {
  return /^(0|false|no|off)$/i.test((value || '').trim());
}

/**
 * TMDB *upscales* when the requested width exceeds the asset's own: a 350px logo
 * asked for at `w500` comes back as a re-encoded 500px file roughly 1.8x the
 * bytes of the original. Asking for a sized rendition is therefore only a saving
 * when the asset is actually bigger than the size we want.
 *
 * `nativeWidth` is the `width` TMDB reports on the image object. When it is
 * missing — a bare `poster_path`/`backdrop_path` carries no dimensions — assume
 * the asset is large, which is true of anything TMDB serves as `original`.
 */
function requestSize(nativeWidth: number | undefined, target: number, sized: string): string {
  const known = typeof nativeWidth === 'number' && nativeWidth > 0;
  return known && nativeWidth <= target ? ORIGINAL : sized;
}

/**
 * Defaults ON. `w500` against a ~200px render target is not a visible change,
 * and originals are lossless PNGs around 12x the size.
 */
export function tmdbLogoSize(nativeWidth?: number): string {
  if (isExplicitlyDisabled(process.env.PREFER_SMALLER_LOGOS_TMDB)) return ORIGINAL;
  return requestSize(nativeWidth, 500, SMALL_LOGO);
}

/**
 * Defaults OFF. The median original backdrop is 3700px wide and many are true
 * 4K, so `w1280` is a real downscale a full-screen client can show.
 */
export function tmdbBackdropSize(nativeWidth?: number): string {
  if (!isTruthy(process.env.PREFER_SMALLER_BACKDROPS_TMDB)) return ORIGINAL;
  return requestSize(nativeWidth, 1280, SMALL_BACKDROP);
}

/**
 * Defaults ON. A landscape poster is a backdrop selected with a language
 * preference, but it is rendered as a catalog tile a few hundred px wide rather
 * than full-screen, so it does not need the caution `tmdbBackdropSize` applies.
 */
export function tmdbLandscapeSize(nativeWidth?: number): string {
  if (isExplicitlyDisabled(process.env.PREFER_SMALLER_LANDSCAPE_TMDB)) return ORIGINAL;
  return requestSize(nativeWidth, 780, SMALL_LANDSCAPE);
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
  tmdbLandscapeSize,
  tmdbImageUrl,
};
