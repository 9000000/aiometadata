import * as crypto from 'node:crypto';

export function imageProxySigningSecret(): string {
  return process.env.IMAGE_PROXY_SIGNING_SECRET || process.env.ADMIN_KEY || process.env.MOVIELENS_CRED_KEY || '';
}

/** Marks a `url=` as addon-generated so the SSRF guard may reach a private host. */
export function signProxyArtUrl(targetUrl: string): string {
  const secret = imageProxySigningSecret();
  if (!secret || !targetUrl) return '';
  return crypto.createHmac('sha256', secret).update(targetUrl).digest('base64url').slice(0, 22);
}

export function proxyArtUrlVouched(targetUrl: string, sig: unknown): boolean {
  const expected = signProxyArtUrl(targetUrl);
  if (!expected || !sig) return false;
  const provided = Buffer.from(String(sig));
  const wanted = Buffer.from(expected);
  return provided.length === wanted.length && crypto.timingSafeEqual(provided, wanted);
}

export interface ProxyArtUrlOptions {
  /** `${host}/poster-cache/proxy` for meta responses, `${addonHost}` for warmup targets. */
  base: string;
  imageClass: 'poster' | 'logo' | 'background';
  type: string;
  id: string;
  fallback?: string;
  /** Custom art URL. Signed here so no caller has to remember to. */
  url?: string;
  /** Rating provider key, used instead of `url`. */
  ratingKey?: string;
  lang?: string;
}

export function buildProxyArtUrl(options: ProxyArtUrlOptions): string {
  const { base, imageClass, type, id, fallback, url, ratingKey, lang } = options;
  const params = [`fallback=${encodeURIComponent(fallback || '')}`];

  if (ratingKey) {
    params.push(`lang=${lang || 'en-US'}`, `key=${ratingKey}`);
  } else if (url) {
    params.push(`url=${encodeURIComponent(url)}`, `sig=${signProxyArtUrl(url)}`);
  }

  return `${base}/${imageClass}/${type}/${id}?${params.join('&')}`;
}
