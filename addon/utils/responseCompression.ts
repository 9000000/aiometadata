export {};

const compressionMiddleware: any = require('compression');
const { getSetting }: any = require('../lib/settingsService');
const { POSTER_CACHE_ROUTE }: any = require('../lib/posterCache/config');

const SSE_CONTENT_TYPE = 'text/event-stream';

function isEnabled(): boolean {
  try {
    return getSetting('RESPONSE_COMPRESSION_ENABLED') !== 'false';
  } catch {
    return true;
  }
}

function mountedPath(req: any): string {
  const baseUrl = typeof req.baseUrl === 'string' ? req.baseUrl : '';
  const path = typeof req.path === 'string' ? req.path : '';
  return `${baseUrl}${path}`;
}

function shouldCompressResponse(req: any, res: any): boolean {
  if (!isEnabled()) return false;

  const contentType = res.getHeader('Content-Type');
  if (typeof contentType === 'string' && contentType.startsWith(SSE_CONTENT_TYPE)) return false;

  if (mountedPath(req).startsWith(POSTER_CACHE_ROUTE)) return false;

  return compressionMiddleware.filter(req, res);
}

function createResponseCompression(): any {
  return compressionMiddleware({ filter: shouldCompressResponse });
}

module.exports = {
  createResponseCompression,
  shouldCompressResponse,
};
