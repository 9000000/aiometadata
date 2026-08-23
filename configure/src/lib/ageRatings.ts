/** Most permissive last. An install URL may only pick a rating below the stored one. */
export const AGE_RATING_ORDER = ['G', 'PG', 'PG-13', 'R', 'NC-17'] as const;

export const AGE_RATING_LABELS: Record<string, string> = {
  'None': 'None (Show All)',
  'G': 'G (All Ages)',
  'PG': 'PG (Parental Guidance)',
  'PG-13': 'PG-13 (Parents Strongly Cautioned)',
  'R': 'R (Restricted)',
  'NC-17': 'NC-17 (Adults Only)',
};

export const AGE_RATING_OPTIONS = [
  { value: 'None', label: AGE_RATING_LABELS['None'] },
  ...AGE_RATING_ORDER.map(value => ({ value, label: AGE_RATING_LABELS[value] })),
];

/** Ratings an install URL can ask for, given what the saved config already caps at. */
export function stricterRatings(stored: string | undefined | null): string[] {
  const cap = !stored || stored === 'None' ? AGE_RATING_ORDER.length : AGE_RATING_ORDER.indexOf(stored as any);
  const limit = cap === -1 ? AGE_RATING_ORDER.length : cap;
  return AGE_RATING_ORDER.slice(0, limit);
}
