import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  AnonymousCredential,
  ContainerClient,
  StorageSharedKeyCredential,
  newPipeline,
} from '@azure/storage-blob';

/**
 * The answers an Azure Blob client can get, from Azure, a compatible store, a proxy or the network, served from
 * 127.0.0.1 to the SDK's own client, for the tests that check what the driver makes of each: that no credential is
 * reachable from the error it throws, and that the scrubbed copy classifies as the raw error does.
 *
 * Every client carries, beside its own credential (a SharedKey signature or a SAS), the credential headers a user's
 * pipeline can add to every request: a cookie, an API key and a customer-provided key. An answer that quotes the request
 * quotes them too, the way Azure, a proxy's error page or a gateway's JSON body would. The clients talk only to the
 * loopback server; the tests that use them run under the loopback guard as well.
 */

export const ACCOUNT_KEY = Buffer.from('stand-in-account-key-0123456789').toString('base64');
export const SAS_SIGNATURE = 'SECRETSIGNATUREVALUE0123456789';
/** A cookie of two pairs, each of which must go. */
export const COOKIE = 'sid=STANDINCOOKIEVALUE0123; pref=STANDINPREFVALUE4567';
export const API_KEY = 'STANDINAPIKEYVALUE0123456789';
/** A stand-in customer-provided key, as its header carries one: 32 bytes in base64. */
export const CUSTOMER_KEY = Buffer.from('stand-in-customer-key-0123456789').toString('base64');
/** The planted credentials a user's pipeline adds, as a search for them reads each. */
export const PLANTED = ['STANDINCOOKIEVALUE0123', 'STANDINPREFVALUE4567', API_KEY, CUSTOMER_KEY];

export type CredentialKind = 'sharedkey' | 'sas';
export const CREDENTIAL_KINDS: CredentialKind[] = ['sharedkey', 'sas'];

interface PlantedRequest {
  headers: { set: (name: string, value: string) => void };
}

/** A policy of the kind a user's pipeline adds: it sets the planted headers on every request, before it is signed. */
const plant = {
  create: (next: { sendRequest: (request: PlantedRequest) => Promise<unknown> }) => ({
    sendRequest: (request: PlantedRequest): Promise<unknown> => {
      request.headers.set('cookie', COOKIE);
      request.headers.set('x-api-key', API_KEY);
      request.headers.set('x-ms-encryption-key', CUSTOMER_KEY);
      return next.sendRequest(request);
    },
  }),
};

/** A container client of `kind` against `url`, one try per request, with the planted headers on every request. */
export function clientFor(kind: CredentialKind, url: string): ContainerClient {
  const credential =
    kind === 'sharedkey'
      ? new StorageSharedKeyCredential('stand-in', ACCOUNT_KEY)
      : new AnonymousCredential();
  const pipeline = newPipeline(credential, { retryOptions: { maxTries: 1 } });
  pipeline.factories.push(plant as never);
  return new ContainerClient(
    kind === 'sharedkey' ? `${url}/c` : `${url}/c?sv=2022-11-02&sp=rw&sig=${SAS_SIGNATURE}`,
    pipeline,
  );
}

export type Answer = (req: IncomingMessage, res: ServerResponse) => void;

/** A request's headers by name, as text. */
const headersOf = (req: IncomingMessage): [string, string][] =>
  Object.entries(req.headers).flatMap(([name, value]) =>
    typeof value === 'string' ? [[name, value] as [string, string]] : [],
  );

/** An Azure error document, with its code in `x-ms-error-code` as Azure sends it (a HEAD gets the header alone). */
const azureError =
  (
    status: number,
    code: string,
    extra: (req: IncomingMessage) => string = () => '',
    headers: Record<string, string> = {},
  ): Answer =>
  (req, res) => {
    res.writeHead(status, {
      'content-type': 'application/xml',
      'x-ms-error-code': code,
      'x-ms-request-id': 'r-1',
      ...headers,
    });
    if (req.method === 'HEAD') return void res.end();
    res.end(
      `<?xml version="1.0" encoding="utf-8"?><Error><Code>${code}</Code><Message>refused</Message>${extra(req)}</Error>`,
    );
  };

/** A body of `type` (none when `undefined`) made from the request. */
const raw =
  (status: number, type: string | undefined, body: (req: IncomingMessage) => string): Answer =>
  (req, res) => {
    res.writeHead(status, type === undefined ? {} : { 'content-type': type });
    res.end(req.method === 'HEAD' ? undefined : body(req));
  };

/**
 * What Azure quotes when it cannot verify a SharedKey signature: the signature, and the string it signed, which lists
 * every `x-ms-` header the request carried with its value, one to a line.
 */
const stringToSign = (req: IncomingMessage): string => {
  const mac = /^SharedKey [^:]+:(.+)$/.exec(String(req.headers.authorization ?? ''))?.[1] ?? '';
  const signed = headersOf(req)
    .filter(([name]) => name.startsWith('x-ms-'))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}:${value}`)
    .join('\n');
  return (
    `<AuthenticationErrorDetail>The MAC signature found in the HTTP request '${mac}' is not the same as any ` +
    `computed signature. Server used following string to sign: '${req.method ?? ''}\n\n\n\n\n\n\n\n\n\n\n\n` +
    `${signed}\n/stand-in${(req.url ?? '').split('?')[0] ?? ''}'.</AuthenticationErrorDetail>`
  );
};

const rows = (req: IncomingMessage): string =>
  headersOf(req)
    .map(([name, value]) => `<tr><th>${name}</th><td>${value}</td></tr>`)
    .join('');

export const ANSWERS: Record<string, Answer> = {
  '403 AuthenticationFailed': azureError(403, 'AuthenticationFailed'),
  '403 AuthenticationFailed quoting the signature and the string to sign': azureError(
    403,
    'AuthenticationFailed',
    stringToSign,
  ),
  '400 InvalidHeaderValue quoting the customer-provided key': azureError(
    400,
    'InvalidHeaderValue',
    (req) =>
      `<HeaderName>x-ms-encryption-key</HeaderName><HeaderValue>${String(req.headers['x-ms-encryption-key'])}</HeaderValue>`,
  ),
  '404 BlobNotFound': azureError(404, 'BlobNotFound'),
  '404 ContainerNotFound': azureError(404, 'ContainerNotFound'),
  '409 BlobAlreadyExists': azureError(409, 'BlobAlreadyExists'),
  '412 ConditionNotMet': azureError(412, 'ConditionNotMet'),
  '416 InvalidRange': azureError(416, 'InvalidRange'),
  '500 InternalError': azureError(500, 'InternalError'),
  '503 ServerBusy': azureError(503, 'ServerBusy'),
  // A request id is the store's to choose: one that spells a credential name must not cost the record its code.
  '503 ServerBusy, request id "token"': azureError(503, 'ServerBusy', () => '', {
    'x-ms-request-id': 'token',
  }),
  '502 proxy page listing the request headers': raw(
    502,
    'text/html',
    (req) =>
      `<html><head><title>502</title></head><body><h1>Request headers</h1><table>${rows(req)}</table>` +
      `<p>sent: ${headersOf(req)
        .map(([name, value]) => `${name}: ${value}`)
        .join(' ')}</p></body></html>`,
  ),
  '502 proxy page served as XML': raw(
    502,
    'application/xml',
    (req) =>
      `<html><body><table><tr>${headersOf(req)
        .map(([name, value]) => `<th>${name}</th><td>${value}</td>`)
        .join('')}</tr>${rows(req)}</table></body></html>`,
  ),
  '400 JSON body listing the request headers': raw(400, 'application/json', (req) =>
    JSON.stringify({
      error: {
        code: 'GatewayRefused',
        message: 'refused',
        headers: headersOf(req).map(([name, value]) => ({ name, value })),
      },
      request: { headers: req.headers },
    }),
  ),
  '400 XML body listing the request headers': azureError(
    400,
    'GatewayRefused',
    (req) =>
      `<Headers>${headersOf(req)
        .map(([name, value]) => `<Header><Name>${name}</Name><Value>${value}</Value></Header>`)
        .join('')}</Headers>`,
  ),
  '502 body with no content type quoting the request': raw(
    502,
    undefined,
    (req) =>
      `bad gateway; ${headersOf(req)
        .map(([name, value]) => `${name}: ${value}`)
        .join('; ')}`,
  ),
  'reset connection': (req) => req.socket.destroy(),
};

/** A loopback server that answers every request with `answer()`, or holds it open when that is `undefined`. */
export async function startLoopback(
  answer: () => Answer | undefined,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    req.resume();
    answer()?.(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
