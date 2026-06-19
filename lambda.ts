/**
 * AWS Lambda entry point for the admin panel — an alternative to the Bun
 * server in `server.ts` (used by the Docker/ECS deployment).
 *
 * It reuses the same compiled request handler (`dist/server/server.js`) and is
 * designed for a Lambda Function URL (buffered) fronted by CloudFront. Static
 * assets (`dist/client`) are served by CloudFront from S3, so only dynamic
 * routes (SSR pages + server functions) reach this handler.
 */

type LambdaFunctionUrlEvent = {
  rawPath: string;
  rawQueryString: string;
  headers: Record<string, string | undefined>;
  cookies?: string[];
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: { http: { method: string } };
};

type LambdaFunctionUrlResult = {
  statusCode: number;
  headers: Record<string, string>;
  cookies: string[];
  body: string;
  isBase64Encoded: boolean;
};

type FetchHandler = { default: { fetch: (request: Request) => Promise<Response> } };

const { default: app } = (await import('./dist/server/server.js')) as FetchHandler;

const NO_CACHE = 'no-cache, no-store, must-revalidate';

function toRequest(event: LambdaFunctionUrlEvent): Request {
  const { method } = event.requestContext.http;
  const headers = new Headers();
  for (const [name, value] of Object.entries(event.headers)) {
    if (value !== undefined) headers.set(name, value);
  }
  if (event.cookies?.length) headers.set('cookie', event.cookies.join('; '));

  const host = headers.get('x-forwarded-host') ?? headers.get('host') ?? 'localhost';
  const proto = headers.get('x-forwarded-proto') ?? 'https';
  const query = event.rawQueryString ? `?${event.rawQueryString}` : '';
  const url = `${proto}://${host}${event.rawPath}${query}`;

  const hasBody = event.body != null && method !== 'GET' && method !== 'HEAD';
  const body = hasBody
    ? event.isBase64Encoded
      ? Buffer.from(event.body as string, 'base64')
      : event.body
    : undefined;

  return new Request(url, { method, headers, body });
}

export async function handler(event: LambdaFunctionUrlEvent): Promise<LambdaFunctionUrlResult> {
  if (event.rawPath === '/health') {
    return {
      statusCode: 200,
      headers: { 'content-type': 'text/plain' },
      cookies: [],
      body: 'ok',
      isBase64Encoded: false,
    };
  }

  const response = await app.fetch(toRequest(event));

  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    if (key !== 'set-cookie') headers[key] = value;
  });
  if (!headers['cache-control']) headers['cache-control'] = NO_CACHE;

  const cookies =
    typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  const body = Buffer.from(await response.arrayBuffer());

  return {
    statusCode: response.status,
    headers,
    cookies,
    body: body.toString('base64'),
    isBase64Encoded: true,
  };
}
