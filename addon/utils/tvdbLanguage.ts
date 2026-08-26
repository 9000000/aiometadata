/**
 * TVDB files European Portuguese under `por` and Brazilian under `pt`, and most records
 * carry only one of the two. Falling straight from the missing one to English hands a
 * Portuguese speaker English while a Portuguese translation sits in the same record, so
 * the sibling variant is tried first.
 */
export function tvdbLanguageChain(primary: string | null | undefined): string[] {
  const code = primary || 'eng';
  const chain = [code];
  if (code === 'por') chain.push('pt');
  else if (code === 'pt') chain.push('por');
  if (!chain.includes('eng')) chain.push('eng');
  return chain;
}

/** First non-empty `field` across the language chain. */
export function pickTranslation(
  items: any[] | null | undefined,
  chain: string[],
  field: string
): string | undefined {
  if (!Array.isArray(items)) return undefined;
  for (const code of chain) {
    const value = items.find(item => item?.language === code)?.[field];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

/** First artwork of `type` across the language chain, before any untyped fallback. */
export function pickArtwork(
  artworks: any[] | null | undefined,
  type: number | string,
  chain: string[],
  field: string
): string | undefined {
  if (!Array.isArray(artworks)) return undefined;
  for (const code of chain) {
    const value = artworks.find(art => art?.type === type && art?.language === code)?.[field];
    if (value) return value;
  }
  return undefined;
}

module.exports = { tvdbLanguageChain, pickTranslation, pickArtwork };
