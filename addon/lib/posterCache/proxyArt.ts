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
