import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import { createRequire } from 'node:module';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { Storage } from '@google-cloud/storage';

/**
 * The answers a GCS client can get, from GCS, a GCS-compatible store, a proxy or the network, served from 127.0.0.1 to
 * the SDK's own client, for the tests that check what the driver makes of each: that no credential is reachable from
 * the error it throws, and that the scrubbed copy classifies as the raw error does.
 *
 * Nothing leaves the machine. Each client is built with an explicit auth client, so the SDK never looks for application
 * default credentials, and {@link isolateGoogleEnv} turns off the metadata server lookup the auth library would
 * otherwise make. {@link guardLoopback} refuses every connection to anything but the loopback address and records it, so
 * a test can show that none was attempted.
 */

const nodeRequire = createRequire(import.meta.url);
interface AuthLibrary {
  GoogleAuth: new (options: { authClient: unknown }) => unknown;
  OAuth2Client: new (options?: {
    clientId?: string;
    clientSecret?: string;
    endpoints?: { oauth2TokenUrl?: string };
  }) => { setCredentials(credentials: Record<string, string>): void };
}
const auth = nodeRequire(
  nodeRequire.resolve('google-auth-library', {
    paths: [nodeRequire.resolve('@google-cloud/storage')],
  }),
) as AuthLibrary;

// Every credential is built at run time, so the leak scan never reads a credential-looking literal in this file.
/** An access token as Google's token endpoint issues one. */
export const ACCESS_TOKEN = ['ya29', 'a0Ad', 'stand-in-access-token-0123456789'].join('.');
/** A refresh token and the OAuth client's secret, sent to the token endpoint to get an access token. */
export const REFRESH_TOKEN = ['1', '', 'stand-in-refresh-token-0123456789'].join('/');
export const CLIENT_SECRET = ['stand', 'in', 'client', 'secret', '0123'].join('-');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
/** A service account's address, as its key file names it. */
const SA_EMAIL = ['sa', 'p.iam.gserviceaccount.com'].join('@');
const b64u = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const unsigned = [
  b64u({ alg: 'RS256', typ: 'JWT' }),
  b64u({ iss: SA_EMAIL, aud: 'https://storage.googleapis.com/' }),
].join('.');
/** A service account's self-signed JWT, signed here, which the auth library sends as a bearer token. */
export const SELF_SIGNED_JWT = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(privateKey, 'base64url')}`;

/** How a client authenticates. */
export type CredentialKind = 'access token' | 'self-signed JWT' | 'refresh token';
export const CREDENTIAL_KINDS: CredentialKind[] = [
  'access token',
  'self-signed JWT',
  'refresh token',
];

/** The SDK's own client, on `endpoint`, with the SDK's retries off and an explicit auth client of `kind`. */
export function clientFor(kind: CredentialKind, endpoint: string): Storage {
  const oauth =
    kind === 'refresh token'
      ? new auth.OAuth2Client({
          clientId: 'stand-in-client',
          clientSecret: CLIENT_SECRET,
          endpoints: { oauth2TokenUrl: `${endpoint}/token` },
        })
      : new auth.OAuth2Client();
  oauth.setCredentials(
    kind === 'refresh token'
      ? { refresh_token: REFRESH_TOKEN }
      : { access_token: kind === 'access token' ? ACCESS_TOKEN : SELF_SIGNED_JWT },
  );
  return new Storage({
    projectId: 'test',
    apiEndpoint: endpoint,
    useAuthWithCustomEndpoint: true,
    authClient: new auth.GoogleAuth({ authClient: oauth }) as never,
    retryOptions: { autoRetry: false },
  });
}

/** Refuse, and record, every connection to anything but the loopback address. */
export function guardLoopback(): { attempts: string[]; restore: () => void } {
  const attempts: string[] = [];
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guarded(this: net.Socket, ...args: unknown[]) {
    const first = args[0] as { host?: unknown; path?: unknown } | number | string | undefined;
    const host =
      typeof first === 'object' && first !== null
        ? first.path === undefined
          ? String(first.host ?? 'localhost')
          : 'pipe'
        : typeof args[1] === 'string'
          ? args[1]
          : 'localhost';
    if (!['127.0.0.1', 'localhost', '::1', 'pipe'].includes(host)) {
      attempts.push(host);
      throw new Error(`a test may connect only to the loopback address, not ${host}`);
    }
    return (connect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof connect;
  return {
    attempts,
    restore: () => {
      net.Socket.prototype.connect = connect;
    },
  };
}

/** The variables that send the auth library to a metadata server or a credentials file, set so it asks neither. */
const ENV: Record<string, string | undefined> = {
  METADATA_SERVER_DETECTION: 'none',
  GCE_METADATA_HOST: '127.0.0.1:9',
  GCE_METADATA_IP: '127.0.0.1:9',
  GOOGLE_APPLICATION_CREDENTIALS: undefined,
  STORAGE_EMULATOR_HOST: undefined,
};

/** Set {@link ENV} for the rest of the file; the returned function puts every variable back. */
export function isolateGoogleEnv(): () => void {
  const saved = Object.fromEntries(Object.keys(ENV).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(ENV)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  return () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

/** How the server answers one request. `body` is the request's body, as text. */
export type Answer = (req: IncomingMessage, res: ServerResponse, body: string) => void;

const json =
  (status: number, payload: (req: IncomingMessage) => unknown): Answer =>
  (req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload(req)));
  };
/** An error as the JSON API sends one. */
const gcsError = (status: number, reason: string, message: string, extra = {}): Answer =>
  json(status, () => ({
    error: { code: status, message, errors: [{ message, domain: 'global', reason, ...extra }] },
  }));
/** A listing request (`GET /storage/v1/b/<bucket>/o`), which the driver also sends to tell a missing bucket. */
const isListing = (req: IncomingMessage): boolean =>
  req.method === 'GET' && /^\/storage\/v1\/b\/[^/]+\/o(?:\?|$)/.test(req.url ?? '');
const headerTable = (req: IncomingMessage): string =>
  Object.entries(req.headers)
    .map(([name, value]) => `<tr><th>${name}</th><td>${String(value)}</td></tr>`)
    .join('');
const requestText = (req: IncomingMessage): string =>
  `${String(req.method)} ${String(req.url)} HTTP/1.1\r\n` +
  Object.entries(req.headers)
    .map(([name, value]) => `${name}: ${String(value)}`)
    .join('\r\n');

/** Every answer the tests serve. Each one answers every request it gets, the bucket listing included unless it says. */
export const ANSWERS: Record<string, Answer> = {
  '401 Invalid Credentials': gcsError(401, 'authError', 'Invalid Credentials', {
    locationType: 'header',
    location: 'Authorization',
  }),
  '403 forbidden': gcsError(
    403,
    'forbidden',
    `${SA_EMAIL} does not have storage.objects.get access to the Google Cloud Storage object.`,
  ),
  '404 no such object (the bucket listed)': (req, res, body) =>
    isListing(req)
      ? json(200, () => ({ kind: 'storage#objects' }))(req, res, body)
      : gcsError(404, 'notFound', 'No such object: b/o')(req, res, body),
  '404 no such bucket': gcsError(404, 'notFound', 'The specified bucket does not exist.'),
  '412 conditionNotMet': gcsError(
    412,
    'conditionNotMet',
    'At least one of the pre-conditions you specified did not hold.',
  ),
  '416 range not satisfiable': gcsError(416, 'requestedRangeNotSatisfiable', 'out of range'),
  '429 rateLimitExceeded': gcsError(
    429,
    'rateLimitExceeded',
    'The rate of change requests is too high.',
  ),
  '500 backendError': gcsError(500, 'backendError', 'Backend Error'),
  '503 backendError': gcsError(503, 'backendError', 'Backend Error'),
  '502 proxy page quoting the request': (req, res) => {
    res.writeHead(502, { 'content-type': 'text/html' });
    res.end(
      `<html><body><h1>Bad Gateway</h1><p>upstream refused authorization ${String(req.headers.authorization)}` +
        ` for ${String(req.url)}</p><table>${headerTable(req)}</table></body></html>`,
    );
  },
  '500 text body quoting the raw request': (req, res) => {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(requestText(req));
  },
  '400 JSON error quoting the request': json(400, (req) => ({
    error: {
      code: 400,
      message: `Invalid header: authorization ${String(req.headers.authorization)}`,
      errors: [{ message: 'Invalid header', reason: 'invalid', headers: req.headers }],
    },
  })),
  '400 JSON body quoting the request': json(400, (req) => ({
    message: 'bad request',
    headers: req.headers,
  })),
  '403 XML SignatureDoesNotMatch quoting the request': (req, res) => {
    res.writeHead(403, { 'content-type': 'application/xml' });
    res.end(
      '<?xml version="1.0" encoding="UTF-8"?><Error><Code>SignatureDoesNotMatch</Code><Message>Access denied.' +
        '</Message><StringToSign>GOOG4-HMAC-SHA256\n20261017T000000Z\n20261017/auto/storage/goog4_request\nabc' +
        `</StringToSign><CanonicalRequest>${String(req.method)}\n${String(req.url)}\n\n` +
        `authorization:${String(req.headers.authorization)}\nhost:${String(req.headers.host)}\n</CanonicalRequest>` +
        '</Error>',
    );
  },
  'reset connection': (req) => req.socket.destroy(),
};

/** How the token endpoint answers a client that refreshes its access token. */
export const TOKEN_ANSWERS = {
  /** It issues {@link ACCESS_TOKEN}. */
  issued: json(200, () => ({ access_token: ACCESS_TOKEN, expires_in: 3600, token_type: 'Bearer' })),
  /** It refuses the refresh, quoting the request it was sent: the refresh token and the client secret. */
  'refused, quoting the request': ((req, res, body) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_grant', error_description: `bad request: ${body}` }));
  }) as Answer,
};

/**
 * A loopback server that answers each request with the answer `current()` names, and the token endpoint with the one
 * `token()` names.
 */
export async function startLoopback(
  current: () => Answer | undefined,
  token: () => Answer = () => TOKEN_ANSWERS.issued,
): Promise<{
  url: string;
  /** Every `Authorization` value the server was sent. */
  seen: Set<string>;
  close: () => Promise<void>;
}> {
  const seen = new Set<string>();
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('latin1')));
    req.on('end', () => {
      if (typeof req.headers.authorization === 'string') seen.add(req.headers.authorization);
      if (req.url?.startsWith('/token') === true) return token()(req, res, body);
      // No answer holds the request open: the caller's timeout ends it.
      current()?.(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
