import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

/**
 * AWS Lambda entry point for running the admin panel as an Application Load
 * Balancer target (target_type = lambda), as used by the aprochat-config
 * deployment. The Lambda is private — only the ALB can invoke it.
 *
 * Unlike `lambda.ts` (Function URL format), ALB targets use the ELB event
 * shape (`httpMethod`/`path`/`multiValueHeaders`/`statusDescription`). The
 * target group must have multi-value headers enabled so multiple `Set-Cookie`
 * headers survive. This handler also serves the static client assets
 * (`dist/client`, bundled next to it as `client/`) itself — there is no CDN.
 */

type AlbEvent = {
  requestContext: { elb: { targetGroupArn: string } };
  httpMethod: string;
  path: string;
  queryStringParameters?: Record<string, string>;
  multiValueQueryStringParameters?: Record<string, string[]>;
  headers?: Record<string, string>;
  multiValueHeaders?: Record<string, string[]>;
  body?: string;
  isBase64Encoded?: boolean;
};

type AlbResult = {
  statusCode: number;
  statusDescription: string;
  multiValueHeaders: Record<string, string[]>;
  body: string;
  isBase64Encoded: boolean;
};

type FetchHandler = { default: { fetch: (request: Request) => Promise<Response> } };

const { default: app } = (await import('./dist/server/server.js')) as FetchHandler;

const CLIENT_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'client');
const NO_CACHE = 'no-cache, no-store, must-revalidate';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const NEVER_CACHE = new Set(['/manifest.json', '/robots.txt', '/sw.js']);

// ALB requires statusDescription to be a "<code> <reason>" line; a bare code
// (e.g. "307") makes the ALB return 502 Bad Gateway.
const REASON_PHRASES: Record<number, string> = {
  200: 'OK',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

function statusLine(status: number, statusText?: string): string {
  return `${status} ${statusText || REASON_PHRASES[status] || 'OK'}`;
}

const CONTENT_TYPES: Record<string, string> = {
  js: 'text/javascript',
  mjs: 'text/javascript',
  css: 'text/css',
  html: 'text/html; charset=utf-8',
  json: 'application/json',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  txt: 'text/plain',
  map: 'application/json',
};

function contentType(pathname: string): string {
  const ext = pathname.split('.').pop()?.toLowerCase() ?? '';
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

function isStaticPath(pathname: string): boolean {
  return (
    pathname.startsWith('/assets/') ||
    pathname.endsWith('.svg') ||
    pathname === '/favicon.ico' ||
    NEVER_CACHE.has(pathname)
  );
}

function acceptsGzip(event: AlbEvent): boolean {
  const enc =
    event.multiValueHeaders?.['accept-encoding']?.join(',') ??
    event.headers?.['accept-encoding'] ??
    '';
  return enc.includes('gzip');
}

function isCompressible(contentType: string): boolean {
  return /javascript|css|json|html|svg|text|xml|manifest/.test(contentType);
}

// ALB Lambda targets cap the response at 1 MB. Gzipping keeps large assets
// (e.g. the ~1 MB icons chunk) well under it, and shrinks transfer overall.
function encodeBody(
  buffer: Buffer,
  contentType: string,
  gzip: boolean,
): { body: string; contentEncoding?: string } {
  if (gzip && isCompressible(contentType) && buffer.length > 1024) {
    return { body: gzipSync(buffer).toString('base64'), contentEncoding: 'gzip' };
  }
  return { body: buffer.toString('base64') };
}

function buildRequest(event: AlbEvent): Request {
  const headers = new Headers();
  if (event.multiValueHeaders) {
    for (const [name, values] of Object.entries(event.multiValueHeaders)) {
      for (const value of values) headers.append(name, value);
    }
  } else if (event.headers) {
    for (const [name, value] of Object.entries(event.headers)) headers.set(name, value);
  }

  const params = new URLSearchParams();
  if (event.multiValueQueryStringParameters) {
    for (const [key, values] of Object.entries(event.multiValueQueryStringParameters)) {
      for (const value of values) params.append(key, value);
    }
  } else if (event.queryStringParameters) {
    for (const [key, value] of Object.entries(event.queryStringParameters)) params.append(key, value);
  }

  const host = headers.get('x-forwarded-host') ?? headers.get('host') ?? 'localhost';
  const proto = headers.get('x-forwarded-proto') ?? 'https';
  const query = params.toString();
  const url = `${proto}://${host}${event.path}${query ? `?${query}` : ''}`;

  const method = event.httpMethod;
  const hasBody = event.body != null && method !== 'GET' && method !== 'HEAD';
  const body = hasBody
    ? event.isBase64Encoded
      ? Buffer.from(event.body as string, 'base64')
      : event.body
    : undefined;

  return new Request(url, { method, headers, body });
}

async function serveStatic(pathname: string, gzip: boolean): Promise<AlbResult | null> {
  const filePath = join(CLIENT_DIR, pathname);
  if (!filePath.startsWith(CLIENT_DIR)) return null;
  try {
    const data = await readFile(filePath);
    const ct = contentType(pathname);
    const cache = pathname.startsWith('/assets/') ? IMMUTABLE : NEVER_CACHE.has(pathname) ? NO_CACHE : '';
    const encoded = encodeBody(data, ct, gzip);
    const multiValueHeaders: Record<string, string[]> = { 'content-type': [ct] };
    if (cache) multiValueHeaders['cache-control'] = [cache];
    if (encoded.contentEncoding) {
      multiValueHeaders['content-encoding'] = [encoded.contentEncoding];
      multiValueHeaders['vary'] = ['accept-encoding'];
    }
    return {
      statusCode: 200,
      statusDescription: '200 OK',
      multiValueHeaders,
      body: encoded.body,
      isBase64Encoded: true,
    };
  } catch {
    return null;
  }
}

async function toAlbResult(response: Response, gzip: boolean): Promise<AlbResult> {
  const multiValueHeaders: Record<string, string[]> = {};
  response.headers.forEach((value, key) => {
    if (key === 'set-cookie') return;
    (multiValueHeaders[key] ??= []).push(value);
  });
  const cookies =
    typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  if (cookies.length) multiValueHeaders['set-cookie'] = cookies;
  if (!multiValueHeaders['cache-control']) multiValueHeaders['cache-control'] = [NO_CACHE];

  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = multiValueHeaders['content-type']?.[0] ?? '';
  const alreadyEncoded = 'content-encoding' in multiValueHeaders;
  const encoded = encodeBody(buffer, contentType, gzip && !alreadyEncoded);
  if (encoded.contentEncoding) {
    multiValueHeaders['content-encoding'] = [encoded.contentEncoding];
    (multiValueHeaders['vary'] ??= []).push('accept-encoding');
  }
  return {
    statusCode: response.status,
    statusDescription: statusLine(response.status, response.statusText),
    multiValueHeaders,
    body: encoded.body,
    isBase64Encoded: true,
  };
}

export async function handler(event: AlbEvent): Promise<AlbResult> {
  if (event.path === '/health') {
    return {
      statusCode: 200,
      statusDescription: '200 OK',
      multiValueHeaders: { 'content-type': ['text/plain'] },
      body: 'ok',
      isBase64Encoded: false,
    };
  }

  const gzip = acceptsGzip(event);

  if (isStaticPath(event.path)) {
    const asset = await serveStatic(event.path, gzip);
    if (asset) return asset;
  }

  const response = await app.fetch(buildRequest(event));
  return toAlbResult(response, gzip);
}
