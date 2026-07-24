
export const DEFAULT_CACHE_EPOCH = 1;

export function getCacheEpoch(): number {
  const raw = (process.env.CACHE_EPOCH || '').trim();
  if (!raw) return DEFAULT_CACHE_EPOCH;
  if (!/^\d+$/.test(raw)) return DEFAULT_CACHE_EPOCH;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_CACHE_EPOCH;
}

module.exports = { DEFAULT_CACHE_EPOCH, getCacheEpoch };
