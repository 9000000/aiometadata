/**
 * `parseInt(...) || fallback` throws away a deliberate 0, which is how a delay or
 * a cache gets turned off. Only a value that is not a number at all falls back.
 */
export function envInt(name: string, fallback: number, min: number = 0): number {
  const parsed = parseInt(String(process.env[name]), 10);
  return Number.isFinite(parsed) ? Math.max(min, parsed) : fallback;
}
