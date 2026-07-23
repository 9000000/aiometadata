import * as dns from 'node:dns/promises';
import * as net from 'node:net';
import * as http from 'node:http';
import * as https from 'node:https';
import axios from 'axios';
import { getFetchConcurrency, getMaxObjectBytes, getUpstreamTimeoutMs } from './config.js';

const buildInfo = require('../buildInfo.js');


function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true; // Unparseable is not provably public.
  }
  const [a, b] = parts;
  if (a === 0) return true;                        // 0.0.0.0/8
  if (a === 10) return true;                       // private
  if (a === 127) return true;                      // loopback
  if (a === 169 && b === 254) return true;         // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true;         // private
  if (a === 192 && b === 0) return true;           // IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true;                       // multicast + reserved
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase().split('%')[0];
  if (normalized === '::' || normalized === '::1') return true;
  // IPv4-mapped (::ffff:10.0.0.1) must be judged on the embedded address.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped) return isPrivateIPv4(mapped[1]);
  if (/^f[cd]/.test(normalized)) return true; // fc00::/7 unique local
  if (/^fe[89ab]/.test(normalized)) return true; // fe80::/10 link-local
  if (/^ff/.test(normalized)) return true; // multicast
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) return isPrivateIPv4(ip);
  if (version === 6) return isPrivateIPv6(ip);
  return true;
}

export class UpstreamRejected extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface ValidatedUpstream {
  url: URL;
  /** Addresses proven public, pinned for the connection so DNS cannot change under us. */
  addresses: string[];
}

/**
 * Resolves the host and rejects if any answer lands in private address space.
 * Returns the validated addresses so the caller can pin them: re-resolving at
 * connect time would reopen a DNS-rebinding window between check and fetch.
 */
export async function resolvePublicUrl(rawUrl: string): Promise<ValidatedUpstream> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UpstreamRejected('Malformed upstream URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UpstreamRejected(`Unsupported protocol: ${parsed.protocol}`);
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) {
      throw new UpstreamRejected(`Refusing to proxy private address: ${host}`, 403);
    }
    return { url: parsed, addresses: [host] };
  }

  let addresses: { address: string }[];
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch {
    throw new UpstreamRejected(`Could not resolve upstream host: ${host}`, 502);
  }

  if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new UpstreamRejected(`Refusing to proxy host resolving to private address: ${host}`, 403);
  }

  return { url: parsed, addresses: addresses.map((entry) => entry.address) };
}

export async function assertPublicUrl(rawUrl: string): Promise<URL> {
  return (await resolvePublicUrl(rawUrl)).url;
}

/**
 * Agents whose DNS resolution is fixed to already-validated addresses. The
 * request still targets the hostname, so TLS certificate validation is
 * unaffected — only the address it connects to is pinned.
 */
function pinnedAgents(addresses: string[]): { httpAgent: http.Agent; httpsAgent: https.Agent } {
  const lookup = (_hostname: string, options: any, callback: any) => {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'function' ? {} : (options || {});
    if (opts.all) {
      cb(null, addresses.map((address) => ({ address, family: net.isIP(address) })));
      return;
    }
    const address = addresses[0];
    cb(null, address, net.isIP(address));
  };
  return {
    httpAgent: new http.Agent({ lookup } as any),
    httpsAgent: new https.Agent({ lookup } as any),
  };
}

export interface FetchedImage {
  body: Buffer;
  contentType: string;
}


export class OversizeImage extends Error {
  stream: NodeJS.ReadableStream;
  contentType: string;
  declaredLength: number;

  constructor(stream: NodeJS.ReadableStream, contentType: string, declaredLength: number) {
    super(`Image exceeds the cacheable size limit (${declaredLength} bytes)`);
    this.stream = stream;
    this.contentType = contentType;
    this.declaredLength = declaredLength;
  }
}

const MAX_REDIRECTS = 5;

let active = 0;
const waiting: Array<() => void> = [];

function acquire(): Promise<void> {
  if (active < getFetchConcurrency()) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => waiting.push(resolve));
}

function release(): void {
  const next = waiting.shift();
  if (next) {
    // Hand the slot straight over rather than decrementing and racing.
    next();
    return;
  }
  active -= 1;
}

export function getInFlightCount(): number {
  return active;
}

export function getQueuedCount(): number {
  return waiting.length;
}

export async function openImageStream(rawUrl: string): Promise<{ response: any; contentType: string }> {
  let current = rawUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const { url, addresses } = await resolvePublicUrl(current);
    const agents = pinnedAgents(addresses);

    const response = await axios.get(url.toString(), {
      responseType: 'stream',
      timeout: getUpstreamTimeoutMs(),
      maxRedirects: 0,
      ...agents,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      decompress: true,
      validateStatus: (status: number) => (status >= 200 && status < 300) || (status >= 300 && status < 400),
      headers: { 'User-Agent': `AIOMetadata/${buildInfo.version}` },
    });

    if (response.status >= 300 && response.status < 400) {
      response.data?.destroy?.();
      const location = response.headers['location'];
      if (!location) {
        throw new UpstreamRejected(`Redirect without Location from ${url.host}`, 502);
      }
      current = new URL(location, url.toString()).toString();
      continue;
    }

    const contentType = String(response.headers['content-type'] || '').split(';')[0].trim();
    if (!contentType.startsWith('image/')) {
      response.data?.destroy?.();
      throw new UpstreamRejected(`Upstream returned non-image content: ${contentType || 'unknown'}`, 502);
    }

    return { response, contentType };
  }

  throw new UpstreamRejected('Too many redirects', 502);
}


export async function fetchImage(rawUrl: string): Promise<FetchedImage> {
  const maxBytes = getMaxObjectBytes();
  await acquire();

  let response: any;
  let contentType: string;
  try {
    ({ response, contentType } = await openImageStream(rawUrl));
  } catch (error) {
    release();
    throw error;
  }

  const declared = Number.parseInt(response.headers['content-length'] || '', 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    const oversize = new OversizeImage(response.data, contentType, declared);
    const finish = () => release();
    response.data.once('close', finish);
    response.data.once('error', finish);
    throw oversize;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of response.data) {
      size += chunk.length;
      if (size > maxBytes) {
        response.data.destroy();
        throw new UpstreamRejected(`Image exceeds the ${maxBytes} byte limit`, 502);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    response.data?.destroy?.();
    throw error;
  } finally {
    release();
  }

  return { body: Buffer.concat(chunks), contentType };
}
